#!/usr/bin/env node
/**
 * coord-chat — minimal IRC-style TUI so a human can join the agent-coord bus.
 *
 * Usage:
 *   node scripts/coord-chat.mjs [--id <name>] [--dir <path>]
 *   coord-chat [--id <name>] [--dir <path>]    # if installed via npm bin
 *
 * Defaults: --id $USER, --dir $AGENT_COORD_DIR || ~/agent-coord
 *
 * Commands at the prompt:
 *   <text>             → post to shared room
 *   /dm <id> <text>    → DM a specific agent
 *   /list              → show registered agents + transports
 *   /help              → show commands
 *   /quit              → unregister and exit
 *
 * Dependency-light: only proper-lockfile (already a package dep) for the
 * read-modify-write on agents.json. JSONL appends are single small writes
 * (POSIX atomic under PIPE_BUF), no lock needed.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  watch,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  formatCombinedDiceMessage,
  formatDiceLine,
  isDiceHelpCommand,
  parseDiceCommand,
  parseTrailingDiceCommand,
  rollDiceExpr,
  standardDiceList,
} from "./coord-dice.mjs";
import { mentionsAgent } from "../.cursor/hooks/coord-mention-lib.mjs";
import {
  clearGmAgent,
  getGmAgent,
  setGmAgent,
} from "../.cursor/hooks/coord-gm-lib.mjs";
import {
  clearTransportMarker,
  inviteAgent,
  isInvited,
  listInvited,
  parseInviteSpec,
  isInviteAllArg,
  collectRegistryInviteTargets,
  stopAgent,
  stopAll,
  writeTransportMarker,
} from "./coord-agent-spawn.mjs";
import { isAgentBusy } from "../.cursor/hooks/coord-busy-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");
const HOOKS_DIR = path.join(REPO, ".cursor", "hooks");
const WAKE_LOGS_DIR = path.join(HOOKS_DIR, "logs");

// ---------- args ----------

const args = parseArgs(process.argv.slice(2));
let ID = args.id ?? process.env.USER ?? "human"; // reassignable so /nick can rebind it
const ROOT = args.dir ?? process.env.AGENT_COORD_DIR ?? path.join(homedir(), "agent-coord");

// Message-rendering state + helpers. Declared up here (above the top-level
// printRecent() call) so they're initialized before first use — const/let
// don't hoist the way function declarations do.

// Consecutive messages from the same sender within this window are visually
// grouped: the second one drops its header/blank line and just continues the
// gutter, Slack-style.
const GROUP_WINDOW = 2 * 60 * 1000;
let lastBlock = { who: null, ts: 0, kind: null };

let hintActive = false;
let hintContent = null;
let ephemeralLines = 0;
let spinnerTick = 0;
/** agentId → ts of last room/DM message seen this session (suppress spinner after reply). */
const lastAgentMessageTs = new Map();

// Auto-mention mode: null | "all" | agent id — prepended to outgoing room text.
let autoMention = null;
const mentionsSelf = (text) => mentionsAgent(text, ID);

// Recency at a glance: "now" / "5m" for fresh messages, falling back to a wall
// clock for anything over an hour (a stale "63m" reads worse than "08:34").
function relTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const INBOX_DIR = path.join(ROOT, "inbox");
const CURSOR_DIR = path.join(ROOT, "cursors");
const TRANSPORT_DIR = path.join(ROOT, "transports");
const AGENTS_FILE = path.join(ROOT, "agents.json");
const MODELS_FILE = path.join(ROOT, "agent-models.json");
const COLOR_MAP_FILE = path.join(ROOT, "chat-colors.json");
const ROOM_FILE = path.join(ROOT, "room.jsonl");

function loadWorkspaceDefaultModels() {
  const out = { sehui: "human", human: "human" };
  const mcpPath = path.join(REPO, ".cursor", "mcp.json");
  if (existsSync(mcpPath)) {
    try {
      for (const srv of Object.values(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers ?? {})) {
        const id = srv?.env?.AGENT_COORD_BOUND_AGENT?.trim();
        const model = srv?.env?.AGENT_COORD_MODEL?.trim();
        if (id && model) out[id] = model;
      }
    } catch {
      /* ignore */
    }
  }
  const wakeEnvPath = path.join(REPO, ".cursor", "hooks", "coord-wake.local.env");
  if (existsSync(wakeEnvPath)) {
    for (const line of readFileSync(wakeEnvPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const i = trimmed.indexOf("=");
      if (i < 1) continue;
      if (trimmed.slice(0, i).trim() === "COORD_WAKE_MODEL") {
        const model = trimmed.slice(i + 1).trim();
        if (model && !out.rico) out.rico = model;
        break;
      }
    }
  }
  const tasksPath = path.join(REPO, ".vscode", "tasks.json");
  if (existsSync(tasksPath)) {
    try {
      for (const task of JSON.parse(readFileSync(tasksPath, "utf8")).tasks ?? []) {
        const id = task?.options?.env?.AGENT_COORD_ID?.trim();
        const model = task?.options?.env?.COORD_WAKE_MODEL?.trim();
        if (id && model) out[id] = model;
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

const WORKSPACE_DEFAULT_MODELS = loadWorkspaceDefaultModels();

function seedAgentModelsFile() {
  const current = readJsonSafe(MODELS_FILE, {});
  let changed = false;
  for (const [id, model] of Object.entries(WORKSPACE_DEFAULT_MODELS)) {
    if (!current[id]) {
      current[id] = model;
      changed = true;
    }
  }
  if (!changed) return;
  mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
  writeFileSync(MODELS_FILE, JSON.stringify(current, null, 2), "utf8");
}

function resolveDisplayModel(who, m) {
  if (m?.model) return String(m.model);
  const invited = listInvited().find((r) => r.agentId === who);
  if (invited?.model) return invited.model;
  const fromMap = readJsonSafe(MODELS_FILE, {})[who];
  if (fromMap) return fromMap;
  const fromReg = readJsonSafe(AGENTS_FILE, {})[who]?.model;
  if (fromReg) return fromReg;
  if (WORKSPACE_DEFAULT_MODELS[who]) return WORKSPACE_DEFAULT_MODELS[who];
  return "—";
}
const ROOMS_DIR = path.join(ROOT, "rooms");
const ROOMS_FILE = path.join(ROOT, "rooms.json");
const HISTORY_DIR = path.join(ROOT, "history");
let INBOX_FILE = path.join(INBOX_DIR, `${sanitize(ID)}.jsonl`);
let CURSOR_FILE = path.join(CURSOR_DIR, `${sanitize(ID)}.json`);

mkdirSync(INBOX_DIR, { recursive: true });
mkdirSync(CURSOR_DIR, { recursive: true });
mkdirSync(ROOMS_DIR, { recursive: true });
mkdirSync(HISTORY_DIR, { recursive: true });

// ---------- channels ----------
// Mirrors src/store.ts: `general` keeps using room.jsonl + the flat roomOffset
// cursor key (hook/back-compat); other channels live in rooms/<chan>.jsonl with
// their offset under cursor.roomOffsets[chan]. currentRoom is the focused
// channel that plain text posts to; we tail every channel we've joined.
const DEFAULT_ROOM = "general";
let currentRoom = DEFAULT_ROOM;
const ignored = new Set(); // session-local /ignore — agentIds whose msgs we hide

function normalizeRoom(name) {
  if (!name) return DEFAULT_ROOM;
  const n = String(name).trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return n || DEFAULT_ROOM;
}

function roomFile(chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? ROOM_FILE : path.join(ROOMS_DIR, `${sanitize(c)}.jsonl`);
}

function getRoomOffset(cursor, chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? cursor.roomOffset ?? 0 : cursor.roomOffsets?.[c] ?? 0;
}

function setRoomOffset(cursor, chan, n) {
  const c = normalizeRoom(chan);
  if (c === DEFAULT_ROOM) cursor.roomOffset = n;
  else (cursor.roomOffsets ??= {})[c] = n;
}

function getRooms() {
  const reg = readJsonSafe(ROOMS_FILE, {});
  if (!reg[DEFAULT_ROOM]) reg[DEFAULT_ROOM] = { createdAt: 0, createdBy: "system", members: [] };
  return reg;
}

// Channels this agent has joined (always includes the default channel).
function joinedRooms() {
  const reg = getRooms();
  const out = new Set([DEFAULT_ROOM]);
  for (const [chan, e] of Object.entries(reg)) {
    if (e.members?.includes(ID)) out.add(chan);
  }
  return [...out];
}

async function updateRooms(mutate) {
  await withLock(ROOMS_FILE, async () => {
    const reg = readJsonSafe(ROOMS_FILE, {});
    mutate(reg);
    writeJsonAtomic(ROOMS_FILE, reg);
  });
}

const watchedRooms = new Set();
function watchRoom(chan) {
  const f = roomFile(chan);
  if (watchedRooms.has(f)) return;
  try {
    watch(f, () => void drainAndPrint());
    watchedRooms.add(f);
  } catch {
    // file may not exist yet; the 1s interval drain covers it until it does
  }
}

// ---------- ANSI helpers ----------

const A = {
  reset: "\x1b[0m",
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  brightGreen:   (s) => `\x1b[92m${s}\x1b[0m`,
  brightYellow:  (s) => `\x1b[93m${s}\x1b[0m`,
  brightBlue:    (s) => `\x1b[94m${s}\x1b[0m`,
  brightMagenta: (s) => `\x1b[95m${s}\x1b[0m`,
  brightCyan:    (s) => `\x1b[96m${s}\x1b[0m`,
};

// Stable per-agent color via chat-colors.json (index → RGB). Palette slots are
// spread across hues so e.g. green / brightGreen never collide visually.
const AGENT_RGB = [
  [95, 175, 255],  // sky blue
  [255, 120, 95],  // coral
  [130, 210, 125], // sage
  [255, 210, 75],  // amber
  [200, 130, 255], // violet
  [255, 130, 200], // pink
  [75, 220, 210],  // aqua
  [255, 170, 90],  // orange
  [180, 180, 255], // periwinkle
  [220, 220, 120], // khaki
];
const SPINNER_FRAMES = ["|", "/", "-", "\\", "|"];
// Will be initialized after ROOT is set, just below.

// ---------- register and start UI ----------

seedAgentModelsFile();
await register();
reconcileColorMap();

const TTY = !!process.stdout.isTTY;
let COLS = process.stdout.columns || 80;
let cachedPrompt = "";
let liveEmitting = false;
let drainChain = Promise.resolve();

if (TTY) {
  process.stdout.on("resize", () => {
    COLS = process.stdout.columns || 80;
    if (typeof rl !== "undefined") redrawPrompt(true);
  });
}

const SLASH_COMMANDS = [
  "/dm", "/msg", "/list", "/who", "/whoami", "/whois", "/last", "/find",
  "/clear", "/cls", "/me", "/status", "/away", "/back", "/ignore", "/unignore",
  "/nick", "/join", "/part", "/leave", "/rooms", "/channels", "/topic", "/motd",
  "/rules", "/prune", "/kick", "/wipe-room", "/rollover",
  "/invite", "/uninvite", "/invited",
  "/d", "/d4", "/d6", "/d8", "/d10", "/d12", "/d20", "/d100", "/d%", "/roll", "/dice",
  "/gm", "/saveinv", "/con", "/inv", "/avil",
  "/@", "/@all",
  "/help", "/?", "/quit", "/exit",
];

const STATUS_FILE_PATH = path.join(ROOT, "status.jsonl");

function completer(line) {
  // Tab-complete slash commands, DM targets, and @mentions mid-message.
  // On multi-match with no common-prefix advancement, surface the options
  // on the first Tab via say() — default readline UX hides them until a
  // second Tab, which most users assume means "nothing happened."
  let hits = [];
  let substr = line;

  // @mention completion takes priority — checked first because it can
  // appear inside a slash command argument (e.g. `/dm bob hey @ali`) or
  // in a plain room message.
  const mentionMatch = line.match(/@([A-Za-z0-9._-]*)$/);
  if (mentionMatch) {
    const partial = mentionMatch[1];
    const ids = onlineAgentIds().filter((id) => id !== ID && id.startsWith(partial));
    hits = ids.map((id) => `@${id} `);
    substr = mentionMatch[0]; // tell readline to replace just the @partial part
  } else if (line.startsWith("/dm ")) {
    const partial = line.slice(4);
    const ids = onlineAgentIds().filter((id) => id !== ID && id.startsWith(partial));
    hits = ids.map((id) => `/dm ${id} `);
  } else if (/^\/whois\s/.test(line)) {
    const partial = line.replace(/^\/whois\s+/, "");
    hits = onlineAgentIds().filter((id) => id.startsWith(partial)).map((id) => `/whois ${id} `);
  } else if (/^\/inv(?:\s|$)/.test(line) && !line.startsWith("/invite")) {
    const partial = line.replace(/^\/inv\s*/, "");
    const ids = Object.keys(readJsonSafe(AGENTS_FILE, {})).filter((id) => id.startsWith(partial));
    hits = ids.map((id) => `/inv ${id} `);
    if (!partial) hits.unshift("/inv ");
  } else if (/^\/avil(?:\s|$)/i.test(line)) {
    const partial = line.replace(/^\/avil\s*/i, "");
    const names = getAgentAvilities()
      .map((a) => a.name)
      .filter((n) => !partial || n.startsWith(partial));
    hits = names.map((n) => `/avil ${n} `);
    if (!partial) hits.unshift("/avil ");
  } else {
    // Channel-name completion for the channel-taking commands.
    const cm = line.match(/^\/(join|part|leave|msg)\s+#?(\S*)$/);
    if (cm) {
      const cmd = cm[1];
      const partial = cm[2];
      const chans = Object.keys(getRooms()).filter((c) => c.startsWith(partial));
      hits = chans.map((c) => `/${cmd} #${c} `);
    } else if (line.startsWith("/")) {
      hits = SLASH_COMMANDS.filter((c) => c.startsWith(line));
    }
  }
  if (hits.length > 1) {
    // Show the options as an ephemeral hint and hand readline only the common
    // prefix — a single-element completion means its native multi-column dump
    // never lands in scrollback. Tab still advances to the shared prefix.
    const display = hits.map((h) => h.trim()).join("  ");
    drawHint(A.dim("  ┄ " + display));
    const cp = commonPrefix(hits);
    return [[cp.length >= substr.length ? cp : substr], substr];
  }
  return [hits, substr];
}

function commonPrefix(strs) {
  if (strs.length === 0) return "";
  let p = strs[0];
  for (const s of strs.slice(1)) {
    while (s.indexOf(p) !== 0) p = p.slice(0, -1);
  }
  return p;
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: makePrompt(),
  completer,
});

// Auto-offer the logged-in agents the instant "@" is typed (editor-style),
// so you don't have to press Tab to discover who's reachable. We only observe
// keypresses — readline still owns input. setImmediate lets readline insert
// the "@" into its line buffer before we inspect it.
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", (str, key) => {
    // setImmediate lets readline mutate its line buffer first, then we inspect
    // it / redraw the slot above the prompt.
    if (str === "@") { setImmediate(showMentionPicker); return; }
    // Tab is the completer's — it draws/keeps the hint itself. Every other key
    // dismisses a showing hint so the view snaps back to a clean separator.
    if (key && key.name === "tab") return;
    if (hintActive) setImmediate(clearHint);
  });
}

// Banner — printed once on launch. Keep it tight; this is a CLI, not a poster.
printBanner();
// Show recent context (last 3 messages from inbox + room) then fast-forward
// the cursor so the same entries don't show up again via the watcher path.
fastForwardCursors();
await printRecent(3);

// Surface the focused channel's topic + MOTD (room rules) on launch — same
// banner /join shows — so the rules are seen on connect, not just on switch.
// Skip the bare header when neither is set, to avoid noise.
{
  const e = getRooms()[normalizeRoom(currentRoom)];
  if (e?.topic || e?.motd) showRoomBanner(currentRoom);
}

try { watch(INBOX_FILE, () => void drainAndPrint()); } catch {}
for (const chan of joinedRooms()) watchRoom(chan);
try { watch(AGENTS_FILE, () => refreshPrompt()); } catch {}
const drainTimer = setInterval(() => void drainAndPrint(), 1000);
const promptTimer = setInterval(refreshPrompt, 5000);
const spinnerTimer = setInterval(() => {
  spinnerTick++;
  if (listBusyAgentIds().length > 0 || ephemeralLines > 0) paintEphemeral();
}, 120);

// Single teardown path: stop the poll timers and release the terminal so we
// exit cleanly no matter which route we leave by (/quit, SIGINT, EOF).
let toreDown = false;
function shutdown() {
  if (toreDown) return;
  toreDown = true;
  stopAll(HOOKS_DIR);
  clearInterval(drainTimer);
  clearInterval(promptTimer);
  clearInterval(spinnerTimer);
  teardownFooter();
  try { rl.close(); } catch {}
}

redrawPrompt(true);

// Serialize line handling: readline fires 'line' events back-to-back for
// pasted/piped input, and our handlers are async (channel switches, file RMW).
// Chaining them guarantees e.g. "/join #x" fully completes — currentRoom set —
// before the next line posts, so a message can't leak into the old channel.
let lineChain = Promise.resolve();
rl.on("line", (line) => {
  lineChain = lineChain.then(() => handleLine(line)).catch(() => {});
});

async function handleLine(line) {
  const text = line.trim();
  if (!text) return redrawPrompt(true);
  try {
    if (text === "/quit" || text === "/exit" || text.startsWith("/quit ") || text.startsWith("/exit ")) {
      const msg = text.replace(/^\/(quit|exit)\s*/, "").trim();
      for (const chan of joinedRooms()) await sendSystem(chan, msg ? `has quit (${msg})` : "has quit");
      await unregister();
      shutdown();
      process.stdout.write(A.dim("bye.\n"));
      process.exit(0);
    } else if (text === "/help" || text === "/?") {
      printHelp();
    } else if (text === "/list" || text === "/who") {
      await printAgents();
    } else if (text === "/rooms" || text === "/channels") {
      listRooms();
    } else if (text.startsWith("/join ") || text === "/join") {
      const chan = text.slice(5).trim();
      if (!chan) say(A.red("usage: /join <#channel>"));
      else await joinRoom(chan);
    } else if (text === "/part" || text.startsWith("/part ") || text === "/leave" || text.startsWith("/leave ")) {
      await partRoom(text.replace(/^\/(part|leave)\s*/, "").trim());
    } else if (text === "/topic" || text.startsWith("/topic ")) {
      await setTopic(text.slice(6).trim());
    } else if (text === "/motd" || text.startsWith("/motd ") || text === "/rules" || text.startsWith("/rules ")) {
      await setMotd(text.replace(/^\/(motd|rules)\s*/, "").trim());
    } else if (text.startsWith("/msg ")) {
      const m = text.match(/^\/msg\s+(\S+)\s+([\s\S]+)$/);
      if (!m) say(A.red("usage: /msg <#channel> <text>"));
      else { await sendRoom(m[2], m[1]); say(A.dim(`→ sent to #${normalizeRoom(m[1])}`)); }
    } else if (text.startsWith("/whois ")) {
      const target = text.slice(7).trim();
      if (!target) say(A.red("usage: /whois <agent>"));
      else whois(target);
    } else if (text === "/away" || text.startsWith("/away ")) {
      await setAway(text.slice(5).trim());
    } else if (text === "/back") {
      await setBack();
    } else if (text.startsWith("/ignore")) {
      ignoreAgent(text.slice(7).trim());
    } else if (text.startsWith("/unignore")) {
      unignoreAgent(text.slice(9).trim());
    } else if (text === "/nick" || text.startsWith("/nick ")) {
      await nick(text.slice(5).trim());
    } else if (text === "/whoami") {
      await printWhoami();
    } else if (text === "/clear" || text === "/cls") {
      process.stdout.write("\x1b[2J\x1b[H");
      printBanner();
    } else if (text.startsWith("/last")) {
      const m = text.match(/^\/last(?:\s+(\d+))?$/);
      const n = m && m[1] ? parseInt(m[1], 10) : 20;
      await printRecent(n);
    } else if (text.startsWith("/me ")) {
      const action = text.slice(4).trim();
      if (!action) say(A.red("usage: /me <action>"));
      else await sendRoom(`* ${ID} ${action}`, currentRoom, { autoMention: false });
    } else if (text.startsWith("/dm ")) {
      const m = text.match(/^\/dm\s+(\S+)\s+([\s\S]+)$/);
      if (!m) say(A.red("usage: /dm <agentId> <text>"));
      else await sendDm(m[1], m[2]);
    } else if (text.startsWith("/status")) {
      const status = text.slice(7).trim();
      if (!status) say(A.red("usage: /status <text>"));
      else await postStatus(status);
    } else if (text.startsWith("/prune")) {
      const m = text.match(/^\/prune(?:\s+(\d+))?$/);
      const days = m && m[1] ? parseInt(m[1], 10) : 7;
      await pruneOld(days);
    } else if (text === "/invite" || text.startsWith("/invite ")) {
      await handleInviteCommand(text);
    } else if (
      text === "/uninvite" ||
      text.startsWith("/uninvite ") ||
      text === "/dismiss" ||
      text.startsWith("/dismiss ")
    ) {
      await handleUninviteCommand(text);
    } else if (text === "/invited") {
      printInvitedAgents();
    } else if (text.startsWith("/kick ")) {
      const target = text.slice(6).trim();
      if (!target) say(A.red("usage: /kick <agentId>"));
      else await kickAgent(target);
    } else if (text === "/wipe-room") {
      await wipeRoom();
    } else if (text === "/rollover") {
      await rolloverRoom();
    } else if (text.startsWith("/find ")) {
      const term = text.slice(6).trim();
      if (!term) say(A.red("usage: /find <text>"));
      else await findInHistory(term);
    } else if (isDiceHelpCommand(text)) {
      printDiceHelp();
    } else if (parseDiceCommand(text)) {
      await rollDiceCommand(text);
    } else if (text === "/gm" || text.startsWith("/gm ")) {
      await handleGmCommand(text);
    } else if (/^\/saveinv(?:\s+\d+)?$/i.test(text)) {
      await handleSaveInvCommand(text);
    } else if (/^\/con(?:\s+\d+)?$/i.test(text)) {
      await handleConCommand(text);
    } else if (text === "/inv" || /^\/inv\s+\S+$/i.test(text)) {
      handleInvCommand(text);
    } else if (text === "/avil" || text.startsWith("/avil ")) {
      await handleAvilCommand(text);
    } else if (text === "/@") {
      setAutoMention(null);
      say(A.dim("auto-mention off"));
    } else if (/^\/@all\s*$/i.test(text)) {
      setAutoMention("all");
      say(A.dim("auto-mention: @all"));
    } else if (text.startsWith("/@")) {
      const target = text.slice(2).trim();
      if (!/^[A-Za-z0-9._-]+$/i.test(target)) {
        say(A.red("usage: /@<agentId>  (e.g. /@gemini)"));
      } else {
        setAutoMention(target.toLowerCase());
        say(A.dim(`auto-mention: @${autoMention}`));
      }
    } else if (text.startsWith("/")) {
      say(A.red(`unknown command: ${text.split(" ")[0]}`) + A.dim("  (try /help)"));
    } else {
      const inline = parseTrailingDiceCommand(text);
      if (inline) await rollInlineDiceCommand(inline);
      else await sendRoom(text);
    }
  } catch (e) {
    say(A.red(`error: ${e?.message ?? e}`));
  }
  redrawPrompt(true);
}

process.on("SIGINT", async () => {
  try { await unregister(); } catch {}
  shutdown();
  process.stdout.write("\n" + A.dim("bye.\n"));
  process.exit(0);
});

process.on("exit", () => {
  // Final safety net — restore terminal state if we exit via any path.
  shutdown();
});

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--id") out.id = argv[++i];
    else if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") {
      console.log("coord-chat — minimal TUI for agent-coord-mcp");
      console.log("usage: coord-chat [--id <name>] [--dir <path>]");
      console.log("at prompt: <text>=room  /dm <id> <text>  /list  /quit");
      process.exit(0);
    }
  }
  return out;
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeColorKey(id) {
  return String(id ?? "")
    .trim()
    .toLowerCase()
    .replace(/^gm:/, "")
    .replace(/[.,;:!?]+$/g, "");
}

function isRegisteredAgent(id) {
  const key = normalizeColorKey(id);
  if (!key || key === "all") return false;
  return Object.prototype.hasOwnProperty.call(readJsonSafe(AGENTS_FILE, {}), key);
}

function colorAtIndex(idx) {
  const [r, g, b] = AGENT_RGB[idx % AGENT_RGB.length];
  return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

function hashColorFn(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return colorAtIndex(h % AGENT_RGB.length);
}

function channelColor(s) {
  return A.cyan(s);
}

function resolveColorIndex(key) {
  if (!isRegisteredAgent(key)) return null;
  const map = readJsonSafe(COLOR_MAP_FILE, {});
  let idx = map[key];
  if (typeof idx === "number" && idx >= 0 && idx < AGENT_RGB.length) return idx;
  reconcileColorMap();
  const idx2 = readJsonSafe(COLOR_MAP_FILE, {})[key];
  return typeof idx2 === "number" && idx2 >= 0 && idx2 < AGENT_RGB.length ? idx2 : null;
}

/** Rebuild chat-colors.json: one unique palette slot per registered agent only. */
function reconcileColorMap() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const agentIds = Object.keys(reg).sort();
  const old = readJsonSafe(COLOR_MAP_FILE, {});
  const next = {};
  const used = new Set();

  for (const id of agentIds) {
    const prev = old[id];
    if (typeof prev === "number" && prev >= 0 && prev < AGENT_RGB.length && !used.has(prev)) {
      next[id] = prev;
      used.add(prev);
    }
  }
  for (const id of agentIds) {
    if (next[id] !== undefined) continue;
    let idx = -1;
    for (let i = 0; i < AGENT_RGB.length; i++) {
      if (!used.has(i)) { idx = i; break; }
    }
    if (idx === -1) {
      idx = agentIds.indexOf(id) % AGENT_RGB.length;
      for (let off = 0; off < AGENT_RGB.length; off++) {
        const tryIdx = (idx + off) % AGENT_RGB.length;
        if (!used.has(tryIdx)) { idx = tryIdx; break; }
      }
    }
    next[id] = idx;
    used.add(idx);
  }

  if (JSON.stringify(old) !== JSON.stringify(next)) {
    try { writeJsonAtomic(COLOR_MAP_FILE, next); } catch { /* best effort */ }
  }
}

function agentColor(id) {
  const key = normalizeColorKey(id);
  if (!key) return (s) => s;
  const idx = resolveColorIndex(key);
  if (idx === null) return hashColorFn(key);
  return colorAtIndex(idx);
}

// Ephemeral UI below scrollback: responding-agent headers, @mention picker, prompt.
function clearEphemeral() {
  if (typeof rl === "undefined" || ephemeralLines <= 0) return;
  for (let i = 0; i < ephemeralLines; i++) {
    process.stdout.write("\x1b[1A\r\x1b[2K");
  }
  ephemeralLines = 0;
}

function resetEphemeralHint() {
  hintContent = null;
  hintActive = false;
}

function busySince(agentId) {
  const file = path.join(WAKE_LOGS_DIR, `coord-wake-busy-${agentId}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")).since ?? null;
  } catch {
    return null;
  }
}

function shouldShowRespondingSpinner(agentId) {
  if (!isAgentBusy(agentId)) return false;
  const since = busySince(agentId);
  const lastTs = lastAgentMessageTs.get(agentId);
  if (since && lastTs && lastTs >= since) return false;
  return true;
}

function listBusyAgentIds() {
  const ids = [];
  try {
    for (const f of readdirSync(WAKE_LOGS_DIR)) {
      const m = f.match(/^coord-wake-busy-(.+)\.json$/);
      if (!m) continue;
      const id = m[1];
      if (id !== ID && shouldShowRespondingSpinner(id)) ids.push(id);
    }
  } catch {
    /* ignore */
  }
  return ids.sort();
}

function agentBaseRgb(id) {
  const key = normalizeColorKey(id);
  const idx = resolveColorIndex(key);
  if (idx !== null) return AGENT_RGB[idx];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AGENT_RGB[h % AGENT_RGB.length];
}

function rgbFg([r, g, b], s) {
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

function shimmerSpinner(agentId, tick) {
  const char = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const [r0, g0, b0] = agentBaseRgb(agentId);
  const t = (Math.sin(tick * 0.7) + 1) / 2;
  const r = Math.round(r0 + (255 - r0) * t);
  const g = Math.round(g0 + (255 - g0) * t);
  const b = Math.round(b0 + (255 - b0) * t);
  return rgbFg([r, g, b], char);
}

function buildRespondingHeader(agentId) {
  const color = agentColor(agentId);
  const gutter = color("▎");
  const displayWho = gmDisplayId(agentId, currentRoom);
  const model = resolveDisplayModel(agentId, null);
  const spinner = shimmerSpinner(agentId, spinnerTick);
  return `${gutter} ${A.bold(color(displayWho))} ${A.dim(`· ${model} · `)}${spinner}`;
}

function paintEphemeral() {
  if (typeof rl === "undefined" || liveEmitting) return;
  clearEphemeral();
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  const lines = listBusyAgentIds().map((id) => buildRespondingHeader(id));
  if (hintContent) lines.push(hintContent);
  for (const line of lines) process.stdout.write(line + "\n");
  ephemeralLines = lines.length;
  rl.prompt(true);
}

// Ephemeral @mention picker: insert one line directly above the prompt, then
// delete only that line on the next keystroke (never overwrite chat scrollback).
function drawHint(content) {
  if (typeof rl === "undefined" || liveEmitting) return;
  hintContent = content;
  hintActive = true;
  paintEphemeral();
}

function clearHint() {
  if (!hintActive) return;
  hintContent = null;
  hintActive = false;
  paintEphemeral();
}

function redrawPrompt(force = false) {
  if (typeof rl === "undefined" || liveEmitting) return;
  const next = makePrompt();
  rl.setPrompt(next);
  if (force || next !== cachedPrompt) {
    cachedPrompt = next;
    paintEphemeral();
  }
}

function emitLive(outputLines) {
  if (!outputLines.length) return;
  clearEphemeral();
  resetEphemeralHint();
  liveEmitting = true;
  try {
    if (TTY && typeof rl !== "undefined") {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    for (const line of outputLines) {
      process.stdout.write(line + "\n");
    }
  } finally {
    liveEmitting = false;
  }
  cachedPrompt = makePrompt();
  rl.setPrompt(cachedPrompt);
  paintEphemeral();
}

function say(line) {
  clearEphemeral();
  resetEphemeralHint();
  if (TTY && typeof rl !== "undefined") {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  process.stdout.write(line + "\n");
  if (TTY && typeof rl !== "undefined") paintEphemeral();
}

function makePrompt() {
  const mentionHint = autoMention
    ? A.yellow(`(@${autoMention === "all" ? "all" : autoMention})`)
    : "";
  const gap = mentionHint ? " " : "";
  return `${agentColor(ID)(ID)} ${channelColor("#" + normalizeRoom(currentRoom))}${gap}${mentionHint}${A.dim(">")} `;
}

function gmDisplayId(who, room) {
  const id = String(who ?? "").trim().toLowerCase();
  if (!id) return who ?? "?";
  const gm = getGmAgent(normalizeRoom(room ?? currentRoom));
  if (gm && id === gm) return `GM:${gm}`;
  return who;
}

function setAutoMention(target) {
  autoMention = target;
}

function applyAutoMention(text) {
  if (!autoMention) return text;
  const t = String(text ?? "");
  if (!t.trim()) return t;
  if (autoMention === "all") {
    if (/@all(?![A-Za-z0-9_-])/i.test(t)) return t;
    return `@all ${t}`;
  }
  if (mentionsAgent(t, autoMention)) return t;
  return `@${autoMention} ${t}`;
}

function teardownFooter() {
  clearEphemeral();
}

function refreshPrompt() {
  redrawPrompt(false);
}

function printBanner() {
  // Banner lines are static — no need to go through say() and its
  // sep-overwrite logic, which corrupts layout when called after /clear.
  const lines = [
    A.bold(A.cyan("  agent-coord  ")) + A.dim("— shared chat for agents and humans"),
    A.dim(`  agentId=${A.reset}${agentColor(ID)(ID)}${A.dim("  dir=" + ROOT)}`),
    A.dim("  type /help for commands · /invite <model>@<id> · /invite @all · /uninvite @all · /quit to leave"),
  ];
  for (const l of lines) process.stdout.write(l + "\n");
}

function printHelp() {
  const rows = [
    ["<text>",              "post to the current channel"],
    ["/dm <agent> <text>",  "send a direct message"],
    ["/msg <#chan> <text>", "post to a channel without switching to it"],
    ["/me <action>",        "post an IRC-style action (* you wave)"],
    [A.dim("--- auto-mention ---"), ""],
    ["/@all",               "prefix room messages with @all (wake everyone)"],
    ["/@<id>",              "prefix with @id (e.g. /@gemini)"],
    ["/@",                  "turn off auto-mention"],
    [A.dim("--- dice (TRPG) ---"), ""],
    ["/d, /d20",            "roll a d20"],
    ["/d4 … /d100, /d%",    "roll one die (d4 d6 d8 d10 d12 d20 d100)"],
    ["/2d6+3, /1d20-2",     "NdM ± modifier"],
    ["/roll <expr>, /r",    "roll expression (/roll 3d8+1)"],
    ["<text> /d20",         "inline roll at end of a sentence"],
    ["/dice",               "dice command help"],
    [A.dim("--- TRPG GM ---"), ""],
    ["/gm <agentId>",       "set TRPG GM (e.g. /gm gemini)"],
    ["/gm",                 "show current GM"],
    ["/gm off",               "clear GM role"],
    ["/saveinv [n]",          "ask TRPG GM to sync inventories from last n messages (default 5)"],
    ["/con [n]",              "ask TRPG GM to narrate the next scene (default 5 msgs context)"],
    ["/inv [id]",             "show inventory (yours, or another agent's)"],
    ["/avil [name]",          "use an avility (Tab completes from agents.json)"],
    ["/status <text>",      "post to the status broadcast channel"],
    [A.dim("--- channels ---"), ""],
    ["/join <#chan>",       "join (and switch to) a channel, creating it if new"],
    ["/part [#chan]",       "leave the current (or named) channel"],
    ["/rooms",              "list all channels (topic + members)"],
    ["/topic [text]",       "show or set the current channel's topic"],
    ["/motd [text]",        "show or set the channel rules (MOTD)"],
    [A.dim("--- people ---"), ""],
    ["/list, /who",         "show registered agents + transports"],
    ["/invite <model>@<id>","spawn listener + wake-daemon (e.g. gemini-3-flash@gemini)"],
    ["/invite @all",          "invite every registered agent (id + model from agents.json)"],
    ["/invited",            "list agents managed by this coord-chat"],
    ["/uninvite <id>",      "stop managed listener + wake-daemon"],
    ["/uninvite @all",      "stop all managed agents"],
    ["/whois <agent>",      "show an agent's detail (role, channels, status)"],
    ["/whoami",             "show your registration + transport"],
    ["/nick <name>",        "rename yourself (migrates inbox/history)"],
    ["/away [msg], /back",  "set or clear your away status"],
    ["/ignore <agent>",     "mute an agent for this session (/unignore to undo)"],
    [A.dim("--- history ---"), ""],
    ["/last [n]",           "show last n messages (default 20)"],
    ["/find <text>",        "search recent inbox + channel history"],
    ["/clear",              "clear the screen"],
    [A.dim("--- admin ---"), ""],
    ["/prune [days]",       "drop messages older than N days (default 7)"],
    ["/kick <agent>",       "unregister an agent + kill their pusher"],
    ["/wipe-room",          "truncate the current channel (destructive)"],
    ["/rollover",           "archive room.jsonl, start fresh log, reset cursors + history/"],
    [A.dim("---"),          ""],
    ["/help, /?",           "this list"],
    ["/quit [msg], /exit",  "unregister and leave"],
  ];
  say(A.bold("commands:"));
  for (const [cmd, desc] of rows) {
    say(`  ${A.cyan(cmd.padEnd(22))} ${A.dim(desc)}`);
  }
}

async function printWhoami() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const a = reg[ID];
  const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(ID)}.json`), null);
  const live = marker && marker.pid && pidAlive(marker.pid);
  say(A.bold("you:"));
  say(`  ${A.cyan("id")}        ${agentColor(ID)(ID)}`);
  say(`  ${A.cyan("role")}      ${a?.role ?? "-"}`);
  say(`  ${A.cyan("dir")}       ${A.dim(ROOT)}`);
  say(`  ${A.cyan("transport")} ${live ? A.green(marker.transport) : A.dim("none")}`);
  say(`  ${A.cyan("registered")} ${a ? A.green("yes") : A.red("no")}`);
}

function fastForwardCursors() {
  // Move our cursor offsets to end-of-file so anything that existed before
  // launch is treated as already-seen. printRecent(N) then shows the last N
  // as historical context, and the watcher path only fires for genuinely
  // new messages going forward.
  const cur = readJsonSafe(CURSOR_FILE, {});
  cur.inboxOffset = readJsonl(INBOX_FILE).length;
  for (const chan of joinedRooms()) setRoomOffset(cur, chan, readJsonl(roomFile(chan)).length);
  writeJsonAtomic(CURSOR_FILE, cur);
}

async function printRecent(n) {
  const inbox = readJsonl(INBOX_FILE).slice(-n).map((m) => ({ ...m, _kind: "DM" }));
  let rooms = [];
  for (const chan of joinedRooms()) {
    rooms = rooms.concat(
      readJsonl(roomFile(chan)).slice(-n).map((m) => ({ ...m, _kind: "room", room: m.room ?? chan })),
    );
  }
  const all = [...inbox, ...rooms].sort((a, b) => a.ts - b.ts).slice(-n);
  if (!all.length) {
    say(A.dim("(no history)"));
    return;
  }
  const lines = [A.bold(`last ${all.length} message(s):`)];
  for (const m of all) lines.push(...buildMsgLines(m._kind, m, { history: true }));
  for (const row of lines) process.stdout.write(row + "\n");
}

async function withLock(file, fn) {
  await ensureFile(file);
  const release = await lockfile.lock(file, {
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 5000,
  });
  try { return await fn(); } finally { await release(); }
}

async function ensureFile(file) {
  if (!existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "");
  }
}

async function register() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    const now = Date.now();
    const existing = reg[ID];
    reg[ID] = {
      agentId: ID,
      role: existing?.role ?? "human",
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      away: existing?.away,
      inventory: existing?.inventory,
      avilities: existing?.avilities,
    };
    writeJsonAtomic(AGENTS_FILE, reg);
  });
  // Record default-channel membership so /rooms + the hooks see us there.
  await updateRooms((reg) => {
    const e = (reg[DEFAULT_ROOM] ??= { createdAt: 0, createdBy: "system", members: [] });
    if (!e.members.includes(ID)) e.members.push(ID);
  });
}

async function unregister() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    delete reg[ID];
    writeJsonAtomic(AGENTS_FILE, reg);
  });
  await updateRooms((reg) => {
    for (const e of Object.values(reg)) {
      if (e.members?.includes(ID)) e.members = e.members.filter((m) => m !== ID);
    }
  });
}

async function sendDm(to, text) {
  const target = path.join(INBOX_DIR, `${sanitize(to)}.jsonl`);
  await appendMessage(target, { from: ID, to, text });
  say(A.dim(`→ DM sent to ${to}`));
}

async function postStatus(status) {
  await ensureFile(STATUS_FILE_PATH);
  const entry = { id: randomUUID(), ts: Date.now(), agentId: ID, status };
  appendFileSync(STATUS_FILE_PATH, JSON.stringify(entry) + "\n");
  say(A.dim(`→ status posted: ${status}`));
}

async function pruneOld(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let total = 0;
  // Per-channel removal counts so we can shift the corresponding cursor
  // offsets — without this, every other agent's offsets would point past the
  // now-shorter file and they'd silently miss messages until enough new ones
  // piled up to overtake the stale offset.
  const roomRemovedByChan = {};
  let statusRemoved = 0;
  const inboxRemoved = {}; // agentId → count

  const files = [];
  for (const chan of Object.keys(getRooms())) files.push({ path: roomFile(chan), kind: "room", chan });
  files.push({ path: STATUS_FILE_PATH, kind: "status" });
  if (existsSync(INBOX_DIR)) {
    for (const n of readdirSync(INBOX_DIR)) {
      if (n.endsWith(".jsonl")) {
        files.push({ path: path.join(INBOX_DIR, n), kind: "inbox", agentId: n.replace(/\.jsonl$/, "") });
      }
    }
  }
  for (const f of files) {
    if (!existsSync(f.path)) continue;
    const all = readJsonl(f.path);
    const kept = all.filter((e) => e && e.ts > cutoff);
    const removed = all.length - kept.length;
    if (removed > 0) {
      const body = kept.length ? kept.map((e) => JSON.stringify(e)).join("\n") + "\n" : "";
      writeFileSync(f.path, body);
      total += removed;
      if (f.kind === "room") {
        const c = normalizeRoom(f.chan);
        roomRemovedByChan[c] = (roomRemovedByChan[c] ?? 0) + removed;
      } else if (f.kind === "status") statusRemoved += removed;
      else inboxRemoved[f.agentId] = (inboxRemoved[f.agentId] ?? 0) + removed;
    }
  }
  if (Object.keys(roomRemovedByChan).length || statusRemoved || Object.keys(inboxRemoved).length) {
    shiftAllCursors({ roomRemovedByChan, statusRemoved, inboxRemoved });
  }
  say(A.dim(`→ pruned ${total} entries older than ${days}d (cursors adjusted)`));
}

async function wipeRoom() {
  const chan = normalizeRoom(currentRoom);
  await ensureFile(roomFile(chan));
  writeFileSync(roomFile(chan), "");
  // Reset every agent's offset for this channel so they re-read from the start
  // of the (now empty) file rather than pointing past EOF.
  resetRoomOffsets(chan);
  say(A.dim(`→ #${chan} wiped (channel cursors reset)`));
}

function rolloverStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}_${pad(d.getMinutes())}_${pad(d.getSeconds())}`;
}

function clearHistoryDir() {
  if (!existsSync(HISTORY_DIR)) return 0;
  let removed = 0;
  for (const name of readdirSync(HISTORY_DIR)) {
    try {
      unlinkSync(path.join(HISTORY_DIR, name));
      removed++;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

async function rolloverRoom() {
  await ensureFile(ROOM_FILE);
  const msgCount = readJsonl(ROOM_FILE).length;
  const stamp = rolloverStamp();
  let archivedName = `room_${stamp}.jsonl`;
  let archivedPath = path.join(ROOT, archivedName);
  if (existsSync(archivedPath)) {
    archivedName = `room_${stamp}_${randomUUID().slice(0, 8)}.jsonl`;
    archivedPath = path.join(ROOT, archivedName);
  }

  renameSync(ROOM_FILE, archivedPath);
  writeFileSync(ROOM_FILE, "", "utf8");

  watchedRooms.delete(ROOM_FILE);
  try {
    watchRoom(DEFAULT_ROOM);
  } catch {
    /* non-fatal */
  }

  resetRoomOffsets(DEFAULT_ROOM);
  const historyRemoved = clearHistoryDir();
  lastBlock = { who: null, ts: 0, kind: null };

  await sendSystem(DEFAULT_ROOM, `room log rolled over (${msgCount} messages → ${archivedName})`);
  say(
    A.dim(`→ rolled over #general: ${archivedName}`) +
      A.dim(` (${msgCount} message${msgCount === 1 ? "" : "s"} archived)`),
  );
  say(A.dim(`  cursors reset (roomOffset=0), history/ cleared (${historyRemoved} file${historyRemoved === 1 ? "" : "s"})`));
}

// Walk every cursor file and shift offsets down by the per-channel removed
// counts. Mirrors what the MCP prune tool does server-side.
function shiftAllCursors({ roomRemovedByChan = {}, statusRemoved = 0, inboxRemoved = {} }) {
  if (!existsSync(CURSOR_DIR)) return;
  for (const name of readdirSync(CURSOR_DIR)) {
    if (!name.endsWith(".json")) continue;
    const cursorPath = path.join(CURSOR_DIR, name);
    const cur = readJsonSafe(cursorPath, {});
    const id = name.replace(/\.json$/, "");
    let touched = false;
    for (const [chan, removed] of Object.entries(roomRemovedByChan)) {
      if (removed <= 0) continue;
      const has = chan === DEFAULT_ROOM ? cur.roomOffset !== undefined : cur.roomOffsets?.[chan] !== undefined;
      if (has) {
        setRoomOffset(cur, chan, Math.max(0, getRoomOffset(cur, chan) - removed));
        touched = true;
      }
    }
    if (cur.statusOffset !== undefined && statusRemoved > 0) {
      cur.statusOffset = Math.max(0, cur.statusOffset - statusRemoved);
      touched = true;
    }
    const myInbox = inboxRemoved[id] ?? 0;
    if (cur.inboxOffset !== undefined && myInbox > 0) {
      cur.inboxOffset = Math.max(0, cur.inboxOffset - myInbox);
      touched = true;
    }
    if (touched) writeJsonAtomic(cursorPath, cur);
  }
}

function resetRoomOffsets(chan) {
  if (!existsSync(CURSOR_DIR)) return;
  const c = normalizeRoom(chan);
  for (const name of readdirSync(CURSOR_DIR)) {
    if (!name.endsWith(".json")) continue;
    const cursorPath = path.join(CURSOR_DIR, name);
    const cur = readJsonSafe(cursorPath, {});
    if (getRoomOffset(cur, c) !== 0) {
      setRoomOffset(cur, c, 0);
      writeJsonAtomic(cursorPath, cur);
    }
  }
}

async function kickAgent(target) {
  stopAgent(target, HOOKS_DIR);
  clearTransportMarker(TRANSPORT_DIR, target);
  let existed = false;
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    if (reg[target]) {
      existed = true;
      delete reg[target];
      writeJsonAtomic(AGENTS_FILE, reg);
    }
  });
  if (!existed) {
    say(A.red(`agent '${target}' not registered`));
    return;
  }
  const markerPath = path.join(TRANSPORT_DIR, `${sanitize(target)}.json`);
  try { if (existsSync(markerPath)) unlinkSync(markerPath); } catch {}
  // Remove the kicked agent's inbox + cursor so they don't sit orphaned in
  // ~/agent-coord/ taking up listing space and confusing future bookkeeping.
  const inboxPath = path.join(INBOX_DIR, `${sanitize(target)}.jsonl`);
  const cursorPath = path.join(CURSOR_DIR, `${sanitize(target)}.json`);
  try { if (existsSync(inboxPath)) unlinkSync(inboxPath); } catch {}
  try { if (existsSync(cursorPath)) unlinkSync(cursorPath); } catch {}
  say(A.dim(`→ kicked ${target} (registry, transport, inbox, cursor, managed stack cleared)`));
}

async function handleInviteCommand(text) {
  const arg = text.slice(7).trim();
  if (!arg) {
    printInvitedAgents();
    return;
  }
  if (isInviteAllArg(arg)) {
    await handleInviteAllCommand();
    return;
  }
  const spec = parseInviteSpec(arg);
  if (!spec) {
    say(
      A.red("usage: /invite <model>@<agentId>") +
        A.dim("  (e.g. /invite gemini-3-flash@gemini) or /invite @all"),
    );
    return;
  }
  try {
    await doInviteAgent(spec);
  } catch (err) {
    say(A.red(`invite failed: ${err?.message ?? err}`));
  }
}

function onInviteChildExit({ agentId, label, code, signal, error }) {
  clearTransportMarker(TRANSPORT_DIR, agentId);
  if (toreDown) return;
  const why = error ?? signal ?? code ?? "?";
  say(A.dim(`invite: ${agentColor(agentId)(agentId)} ${label} exited (${why})`));
}

async function doInviteAgent(spec, { announce = true } = {}) {
  const result = inviteAgent({
    agentId: spec.agentId,
    model: spec.model,
    hooksDir: HOOKS_DIR,
    projectDir: REPO,
    coordDir: ROOT,
    onChildExit: onInviteChildExit,
  });
  await registerInvitedAgent(spec.agentId, spec.model);
  writeTransportMarker({
    transportDir: TRANSPORT_DIR,
    agentId: spec.agentId,
    model: spec.model,
    listener: result.listener,
    daemon: result.daemon,
  });
  if (announce) {
    await sendSystem(currentRoom, `invited ${spec.agentId} (${spec.model})`);
  }
  say(
    `${A.green("invited")} ${agentColor(spec.agentId)(spec.agentId)} ` +
      A.dim(`model=${spec.model} listener=${result.listenerPid} daemon=${result.daemonPid}`),
  );
  return result;
}

async function handleInviteAllCommand() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const models = readJsonSafe(MODELS_FILE, {});
  const { targets, skipped } = collectRegistryInviteTargets({
    registry: reg,
    models,
    defaults: WORKSPACE_DEFAULT_MODELS,
    excludeId: ID,
  });
  if (!targets.length) {
    say(A.dim("no invitable agents in registry (excluding you)"));
    for (const s of skipped) {
      say(A.dim(`  skip ${agentColor(s.agentId)(s.agentId)}: ${s.reason}`));
    }
    return;
  }
  say(A.dim(`inviting ${targets.length} agent(s) from agents.json…`));
  const invited = [];
  let failed = 0;
  for (const spec of targets) {
    try {
      await doInviteAgent(spec, { announce: false });
      invited.push(spec);
    } catch (err) {
      failed++;
      say(A.red(`invite failed for ${spec.agentId}: ${err?.message ?? err}`));
    }
  }
  if (invited.length) {
    const summary = invited.map((s) => `${s.agentId} (${s.model})`).join(", ");
    await sendSystem(currentRoom, `invited ${summary}`);
  }
  for (const s of skipped) {
    say(A.dim(`  skip ${agentColor(s.agentId)(s.agentId)}: ${s.reason}`));
  }
  say(
    A.dim(
      `done: ${invited.length} invited` +
        (failed ? `, ${failed} failed` : "") +
        (skipped.length ? `, ${skipped.length} skipped` : ""),
    ),
  );
}

async function handleUninviteCommand(text) {
  const arg = text.replace(/^\/(uninvite|dismiss)\s*/, "").trim().toLowerCase();
  if (!arg) {
    say(A.red("usage: /uninvite <agentId> or /uninvite @all"));
    return;
  }
  if (isInviteAllArg(arg)) {
    await handleUninviteAllCommand();
    return;
  }
  if (stopAgent(arg, HOOKS_DIR)) {
    clearTransportMarker(TRANSPORT_DIR, arg);
    await sendSystem(currentRoom, `uninvited ${arg}`);
    say(A.dim(`→ stopped ${agentColor(arg)(arg)} (listener + wake-daemon)`));
  } else {
    say(A.dim(`→ no managed stack for ${arg}`));
  }
}

async function handleUninviteAllCommand() {
  const rows = listInvited();
  if (!rows.length) {
    say(A.dim("no agents managed by this coord-chat"));
    return;
  }
  const ids = rows.map((r) => r.agentId);
  stopAll(HOOKS_DIR);
  for (const id of ids) {
    clearTransportMarker(TRANSPORT_DIR, id);
  }
  const summary = ids.join(", ");
  await sendSystem(currentRoom, `uninvited ${summary}`);
  say(A.dim(`→ stopped ${ids.length} agent(s): ${summary}`));
}

function printInvitedAgents() {
  const rows = listInvited();
  if (!rows.length) {
    say(A.dim("no agents managed by this coord-chat — /invite <model>@<id>"));
    return;
  }
  say(A.bold(`invited (${rows.length}):`));
  for (const r of rows) {
    const live = r.listenerAlive && r.daemonAlive;
    const dot = live ? A.green("●") : A.dim("○");
    say(
      `  ${dot} ${agentColor(r.agentId)(r.agentId.padEnd(12))} ` +
        A.dim(`${r.model}  listener=${r.listenerPid ?? "-"} daemon=${r.daemonPid ?? "-"}`),
    );
  }
}

async function registerInvitedAgent(agentId, model) {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    const now = Date.now();
    const existing = reg[agentId];
    reg[agentId] = {
      agentId,
      role: existing?.role ?? "cursor",
      model,
      registeredAt: existing?.registeredAt ?? now,
      lastHeartbeat: now,
      inventory: existing?.inventory,
      avilities: existing?.avilities,
    };
    writeJsonAtomic(AGENTS_FILE, reg);
  });
  await updateRooms((rooms) => {
    const e = (rooms[DEFAULT_ROOM] ??= { createdAt: Date.now(), createdBy: ID, members: [] });
    if (!e.members.includes(agentId)) e.members.push(agentId);
  });
  reconcileColorMap();
}

async function findInHistory(term) {
  const t = term.toLowerCase();
  const inbox = readJsonl(INBOX_FILE).map((m) => ({ ...m, _kind: "DM" }));
  let rooms = [];
  for (const chan of joinedRooms()) {
    rooms = rooms.concat(readJsonl(roomFile(chan)).map((m) => ({ ...m, _kind: "room", room: m.room ?? chan })));
  }
  const matches = [...inbox, ...rooms]
    .filter((m) => (m.text ?? "").toLowerCase().includes(t))
    .sort((a, b) => a.ts - b.ts);
  if (!matches.length) return say(A.dim(`(no matches for "${term}")`));
  say(A.bold(`${matches.length} match(es) for "${term}":`));
  for (const m of matches.slice(-20)) printMsg(m._kind, m, { history: true });
}

// ---------- channel commands ----------

function showRoomBanner(chan) {
  const c = normalizeRoom(chan);
  const e = getRooms()[c];
  say(A.bold(channelColor(`#${c}`)) + (e?.topic ? A.dim(" — " + e.topic) : ""));
  if (e?.motd) say(A.dim("  rules: ") + e.motd);
  const members = e?.members ?? [];
  if (members.length) say(A.dim(`  members: ${members.join(", ")}`));
}

async function joinRoom(arg) {
  const chan = normalizeRoom(arg);
  await updateRooms((reg) => {
    const e = (reg[chan] ??= { createdAt: Date.now(), createdBy: ID, members: [] });
    if (!e.members.includes(ID)) e.members.push(ID);
  });
  // Fast-forward this channel's offset so we don't replay its whole backlog.
  const cur = readJsonSafe(CURSOR_FILE, {});
  setRoomOffset(cur, chan, readJsonl(roomFile(chan)).length);
  writeJsonAtomic(CURSOR_FILE, cur);
  await sendSystem(chan, `joined #${chan}`);
  currentRoom = chan;
  watchRoom(chan);
  refreshPrompt();
  say(A.dim("→ now in ") + A.bold(channelColor(`#${chan}`)));
  showRoomBanner(chan);
}

async function partRoom(arg) {
  const chan = normalizeRoom(arg || currentRoom);
  if (chan === DEFAULT_ROOM) return say(A.red("cannot leave #general"));
  if (!joinedRooms().includes(chan)) return say(A.red(`not in #${chan}`));
  await sendSystem(chan, `left #${chan}`);
  await updateRooms((reg) => {
    if (reg[chan]) reg[chan].members = (reg[chan].members ?? []).filter((m) => m !== ID);
  });
  if (normalizeRoom(currentRoom) === chan) {
    currentRoom = DEFAULT_ROOM;
    refreshPrompt();
  }
  say(A.dim("→ left ") + A.bold(`#${chan}`));
}

function listRooms() {
  const reg = getRooms();
  const joined = new Set(joinedRooms());
  const names = Object.keys(reg).sort();
  say(A.bold(`channels (${names.length}):`));
  for (const c of names) {
    const e = reg[c];
    const here =
      normalizeRoom(currentRoom) === c ? A.green("*") : joined.has(c) ? A.dim("·") : " ";
    const count = readJsonl(roomFile(c)).length;
    const topic = e.topic ? A.dim(" — " + e.topic) : "";
    say(`  ${here} ${channelColor(("#" + c).padEnd(16))} ${A.dim(`${(e.members ?? []).length} member(s), ${count} msg`)}${topic}`);
  }
}

async function setTopic(arg) {
  const chan = normalizeRoom(currentRoom);
  if (!arg) {
    const e = getRooms()[chan];
    return say(e?.topic ? A.bold(`#${chan} topic: `) + e.topic : A.dim(`#${chan} has no topic`));
  }
  await updateRooms((reg) => {
    (reg[chan] ??= { createdAt: Date.now(), createdBy: ID, members: [] }).topic = arg;
  });
  await sendSystem(chan, `changed topic to: ${arg}`);
  say(A.dim(`→ topic set for #${chan}`));
}

async function setMotd(arg) {
  const chan = normalizeRoom(currentRoom);
  if (!arg) {
    const e = getRooms()[chan];
    return say(e?.motd ? A.bold(`#${chan} rules: `) + e.motd : A.dim(`#${chan} has no rules (MOTD)`));
  }
  await updateRooms((reg) => {
    (reg[chan] ??= { createdAt: Date.now(), createdBy: ID, members: [] }).motd = arg;
  });
  await sendSystem(chan, `updated the room rules (MOTD)`);
  say(A.dim(`→ rules (MOTD) set for #${chan}`));
}

// ---------- phase-1 parity commands ----------

function whois(target) {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const a = reg[target];
  if (!a) return say(A.red(`no such agent: ${target}`));
  const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(target)}.json`), null);
  const live = marker && marker.pid && pidAlive(marker.pid);
  const online = live || Date.now() - a.lastHeartbeat < 5 * 60 * 1000;
  const rooms = Object.entries(getRooms())
    .filter(([, e]) => e.members?.includes(target))
    .map(([c]) => `#${c}`);
  say(A.bold("whois ") + agentColor(target)(target) + ":");
  say(`  ${A.cyan("status")}     ${online ? A.green("online") : A.dim("offline")}${a.away ? A.yellow(` (away: ${a.away})`) : ""}`);
  say(`  ${A.cyan("role")}       ${a.role ?? "-"}`);
  say(`  ${A.cyan("seen")}       ${A.dim(relTime(a.lastHeartbeat))}`);
  say(`  ${A.cyan("channels")}   ${rooms.length ? rooms.join(" ") : A.dim("(general)")}`);
  say(`  ${A.cyan("transport")}  ${live ? A.green(marker.transport) : A.dim("none")}`);
}

async function setAway(msg) {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    if (reg[ID]) {
      reg[ID].away = msg || "away";
      writeJsonAtomic(AGENTS_FILE, reg);
    }
  });
  say(A.dim(`→ marked away${msg ? ": " + msg : ""}`));
}

async function setBack() {
  await withLock(AGENTS_FILE, async () => {
    const reg = readJsonSafe(AGENTS_FILE, {});
    if (reg[ID]) {
      delete reg[ID].away;
      writeJsonAtomic(AGENTS_FILE, reg);
    }
  });
  say(A.dim("→ welcome back (away cleared)"));
}

function ignoreAgent(target) {
  if (!target) return say(A.red("usage: /ignore <agent>"));
  ignored.add(target);
  say(A.dim(`→ ignoring ${target} (this session)`));
}

function unignoreAgent(target) {
  if (target) {
    ignored.delete(target);
    say(A.dim(`→ no longer ignoring ${target}`));
  } else {
    ignored.clear();
    say(A.dim("→ cleared ignore list"));
  }
}

function moveFileSync(from, to) {
  if (!existsSync(from) || from === to) return;
  try {
    renameSync(from, to);
  } catch {
    try {
      writeFileSync(to, readFileSync(from));
      unlinkSync(from);
    } catch {
      /* best effort */
    }
  }
}

// Full rename (NICK): migrate registry, channel membership, inbox, cursor,
// transport marker, and color, then rebind the in-session identity. Mirrors
// the MCP rename_agent tool.
async function nick(arg) {
  const oldId = ID;
  const newId = (arg || "").trim();
  if (!newId || newId === oldId) return say(A.red("usage: /nick <newname>"));
  if (readJsonSafe(AGENTS_FILE, {})[newId]) return say(A.red(`'${newId}' already exists`));
  const joined = joinedRooms();

  await withLock(AGENTS_FILE, async () => {
    const r = readJsonSafe(AGENTS_FILE, {});
    if (r[oldId]) {
      r[newId] = { ...r[oldId], agentId: newId };
      delete r[oldId];
    }
    writeJsonAtomic(AGENTS_FILE, r);
  });
  await updateRooms((r) => {
    for (const e of Object.values(r)) {
      if (e.members?.includes(oldId)) e.members = e.members.map((m) => (m === oldId ? newId : m));
    }
  });
  moveFileSync(path.join(INBOX_DIR, `${sanitize(oldId)}.jsonl`), path.join(INBOX_DIR, `${sanitize(newId)}.jsonl`));
  moveFileSync(path.join(CURSOR_DIR, `${sanitize(oldId)}.json`), path.join(CURSOR_DIR, `${sanitize(newId)}.json`));
  moveFileSync(path.join(TRANSPORT_DIR, `${sanitize(oldId)}.json`), path.join(TRANSPORT_DIR, `${sanitize(newId)}.json`));
  const cmap = readJsonSafe(COLOR_MAP_FILE, {});
  if (cmap[oldId] !== undefined && cmap[newId] === undefined) {
    cmap[newId] = cmap[oldId];
    delete cmap[oldId];
    writeJsonAtomic(COLOR_MAP_FILE, cmap);
  }
  reconcileColorMap();

  // Rebind in-session identity, then broadcast under the new name.
  ID = newId;
  INBOX_FILE = path.join(INBOX_DIR, `${sanitize(ID)}.jsonl`);
  CURSOR_FILE = path.join(CURSOR_DIR, `${sanitize(ID)}.json`);
  for (const chan of joined) await sendSystem(chan, `is now known as ${newId} (was ${oldId})`);
  refreshPrompt();
  say(A.dim("→ you are now ") + agentColor(ID)(ID));
}

async function sendRoom(text, chan = currentRoom, { autoMention: useMention = true } = {}) {
  const c = normalizeRoom(chan);
  const body = useMention ? applyAutoMention(text) : text;
  await appendMessage(roomFile(c), { from: ID, room: c, text: body, model: "human" });
}

async function sendDiceResult(text, chan = currentRoom) {
  const c = normalizeRoom(chan);
  await appendMessage(roomFile(c), {
    from: ID,
    room: c,
    text,
    model: "human",
    dice: true,
    wakeAll: true,
  });
}

async function rollDiceCommand(text) {
  const expr = parseDiceCommand(text);
  if (!expr) {
    say(A.red("invalid dice command") + A.dim("  (try /dice)"));
    return;
  }
  try {
    const result = rollDiceExpr(expr);
    const line = formatDiceLine(ID, result);
    await sendDiceResult(line);
    say(A.dim(`→ ${line}`));
  } catch (err) {
    say(A.red(`dice: ${err?.message ?? err}`));
  }
}

async function rollInlineDiceCommand({ narrative, expr }) {
  try {
    const result = rollDiceExpr(expr);
    const body = formatCombinedDiceMessage(ID, applyAutoMention(narrative), result);
    await sendDiceResult(body);
    say(A.dim(`→ ${formatDiceLine(ID, result)}`));
  } catch (err) {
    say(A.red(`dice: ${err?.message ?? err}`));
  }
}

function printDiceHelp() {
  const std = standardDiceList().map((n) => (n === 100 ? "/d%" : `/d${n}`)).join("  ");
  say(A.bold("dice:"));
  say(`  ${A.cyan(std)}`);
  say(`  ${A.cyan("/d20+5")} ${A.dim("modifier")}  ${A.cyan("/2d6+3")} ${A.dim("multiple dice")}`);
  say(`  ${A.cyan("/roll 4d6")} ${A.dim("alias")}  ${A.cyan("/d")} ${A.dim("= d20")}`);
  say(`  ${A.dim("inline:")} ${A.cyan("날렵하게 피한다. /d20")} ${A.dim("→ narrative + roll, one message")}`);
  say(A.dim("  results broadcast to all agents (@all> in dice line)"));
}

// Post a system notice (join/part/topic/nick) to a channel.
async function sendSystem(chan, text) {
  const c = normalizeRoom(chan);
  await appendMessage(roomFile(c), { from: ID, room: c, text, system: true });
}

async function handleGmCommand(text) {
  const arg = text.slice(3).trim().toLowerCase();
  if (!arg) {
    const gm = getGmAgent(currentRoom);
    if (gm) say(`${A.bold("TRPG GM:")} ${agentColor(gm)(`GM:${gm}`)}`);
    else say(A.dim("no TRPG GM set — /gm <agentId>"));
    return;
  }
  if (arg === "off" || arg === "none" || arg === "clear") {
    const prev = getGmAgent(currentRoom);
    clearGmAgent();
    if (prev) await sendSystem(currentRoom, `cleared TRPG GM (was ${prev})`);
    say(A.dim("TRPG GM cleared"));
    refreshPrompt();
    return;
  }
  const reg = readJsonSafe(AGENTS_FILE, {});
  if (!reg[arg]) {
    say(A.red(`unknown agent: ${arg}`) + A.dim("  (try /list)"));
    return;
  }
  setGmAgent(arg, { setBy: ID, room: currentRoom });
  await sendSystem(currentRoom, `set ${arg} as TRPG GM`);
  say(`${A.green("TRPG GM:")} ${agentColor(arg)(`GM:${arg}`)}`);
  refreshPrompt();
}

const SAVEINV_DEFAULT_MESSAGES = 5;
const CON_DEFAULT_MESSAGES = 5;

async function handleSaveInvCommand(text) {
  const m = text.match(/^\/saveinv(?:\s+(\d+))?$/i);
  const limit = m?.[1] ? parseInt(m[1], 10) : SAVEINV_DEFAULT_MESSAGES;
  if (!Number.isFinite(limit) || limit < 1) {
    say(A.red("usage: /saveinv [messageCount]"));
    return;
  }
  const gm = getGmAgent(currentRoom);
  if (!gm) {
    say(A.red("no TRPG GM set") + A.dim("  (use /gm <agentId> first)"));
    return;
  }
  const body = [
    `@${gm} [saveinv]`,
    "Review the recent chat and update each participant's inventory in agents.json.",
    "Use MCP: get_agent_inventories (confirm state), then batch_set_agent_inventories (save all changes).",
    "Track item gains, losses, trades, and spent consumables from the narrative.",
    "Reply with a concise summary of inventory changes after saving.",
  ].join("\n");
  await appendMessage(roomFile(currentRoom), {
    from: ID,
    room: currentRoom,
    text: body,
    model: "human",
    contextLimit: limit,
  });
  say(A.dim(`→ saveinv requested from ${agentColor(gm)(`GM:${gm}`)} (${limit} msgs context)`));
}

async function handleConCommand(text) {
  const m = text.match(/^\/con(?:\s+(\d+))?$/i);
  const limit = m?.[1] ? parseInt(m[1], 10) : CON_DEFAULT_MESSAGES;
  if (!Number.isFinite(limit) || limit < 1) {
    say(A.red("usage: /con [messageCount]"));
    return;
  }
  const gm = getGmAgent(currentRoom);
  if (!gm) {
    say(A.red("no TRPG GM set") + A.dim("  (use /gm <agentId> first)"));
    return;
  }
  const body = `@${gm} [con]\nContinue the TRPG narrative — narrate the next scene beat from where the story left off.`;
  await appendMessage(roomFile(currentRoom), {
    from: ID,
    room: currentRoom,
    text: body,
    model: "human",
    contextLimit: limit,
  });
  say(A.dim(`→ continue requested from ${agentColor(gm)(`GM:${gm}`)} (${limit} msgs context)`));
}

function handleInvCommand(text) {
  const arg = text.slice(4).trim().toLowerCase();
  const target = arg || ID;
  printInventory(target);
}

function printInventory(target) {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const a = reg[target];
  if (!a) {
    say(A.red(`no such agent: ${target}`) + A.dim("  (try /list)"));
    return;
  }
  const items = Array.isArray(a.inventory) ? a.inventory : [];
  say(
    A.bold("inventory ") +
      agentColor(target)(target) +
      A.dim(` (${items.length} item${items.length === 1 ? "" : "s"})`),
  );
  if (!items.length) {
    say(A.dim("  (empty)"));
    return;
  }
  for (const item of items) {
    const qty = item?.quantity ?? 0;
    const name = String(item?.name ?? "?");
    const note = item?.note ? A.dim(` — ${item.note}`) : "";
    say(`  ${A.cyan(String(qty).padStart(4))}  ${name}${note}`);
  }
}

function getAgentAvilities(agentId = ID) {
  const a = readJsonSafe(AGENTS_FILE, {})[agentId];
  return Array.isArray(a?.avilities) ? a.avilities : [];
}

function resolveAvilityInput(input) {
  const list = getAgentAvilities();
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return { ability: null, narrative: "" };
  const sorted = [...list].sort((a, b) => String(b.name).length - String(a.name).length);
  for (const ab of sorted) {
    const name = String(ab.name ?? "");
    if (trimmed === name) return { ability: ab, narrative: "" };
    if (trimmed.startsWith(`${name} `)) {
      return { ability: ab, narrative: trimmed.slice(name.length).trim() };
    }
  }
  return { ability: null, narrative: trimmed };
}

function printAvilities(target = ID) {
  const list = getAgentAvilities(target);
  say(
    A.bold("avilities ") +
      agentColor(target)(target) +
      A.dim(` (${list.length} skill${list.length === 1 ? "" : "s"})`),
  );
  if (!list.length) {
    say(A.dim("  (none)"));
    return;
  }
  for (const ab of list) {
    const lvl = ab.level ?? "?";
    const desc = ab.desc ? A.dim(` — ${ab.desc}`) : "";
    say(`  ${A.cyan(`Lv.${lvl}`.padEnd(5))}  ${ab.name}${desc}`);
  }
}

async function handleAvilCommand(text) {
  const rest = text.slice(5).trim();
  if (!rest) {
    printAvilities(ID);
    return;
  }
  const { ability, narrative } = resolveAvilityInput(rest);
  if (!ability) {
    say(A.red(`unknown avility: ${rest.split(/\s/)[0]}`) + A.dim("  (try /avil)"));
    return;
  }
  const lvl = ability.level ?? "?";
  const action = narrative || ability.desc || "";
  const line = action
    ? `[${ability.name} Lv.${lvl}] ${action}`
    : `[${ability.name} Lv.${lvl}]`;
  await sendRoom(line, currentRoom);
  say(A.dim(`→ ${line}`));
}

async function appendMessage(file, partial) {
  await ensureFile(file);
  const entry = { id: randomUUID(), ts: Date.now(), ...partial };
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

function drainAndPrint() {
  drainChain = drainChain
    .then(() => drainAndPrintOnce())
    .catch((err) => {
      console.error("[coord-chat] drain error:", err?.message ?? err);
    });
}

async function drainAndPrintOnce() {
  const cursor = readJsonSafe(CURSOR_FILE, {});
  let changed = false;
  const pending = [];

  const inboxAll = readJsonl(INBOX_FILE);
  const inboxOff = cursor.inboxOffset ?? 0;
  for (let i = inboxOff; i < inboxAll.length; i++) {
    const m = inboxAll[i];
    if (m && m.from !== ID && !ignored.has(m.from)) pending.push({ kind: "DM", m });
  }
  if (inboxAll.length > inboxOff) {
    cursor.inboxOffset = inboxAll.length;
    changed = true;
  }

  for (const chan of joinedRooms()) {
    const all = readJsonl(roomFile(chan));
    const off = getRoomOffset(cursor, chan);
    for (let i = off; i < all.length; i++) {
      const m = all[i];
      if (m && m.from !== ID && !ignored.has(m.from)) {
        pending.push({ kind: "room", m: { ...m, room: m.room ?? chan } });
      }
    }
    if (all.length > off) {
      setRoomOffset(cursor, chan, all.length);
      changed = true;
    }
  }

  if (pending.length) {
    const lines = [];
    for (const { kind, m } of pending) {
      if (m?.from && m.from !== ID) lastAgentMessageTs.set(m.from, m.ts ?? Date.now());
      lines.push(...buildMsgLines(kind, m, { history: false }));
    }
    emitLive(lines);
  }

  if (changed) await saveCursor(cursor);
}

async function saveCursor(cursor) {
  try {
    await withLock(CURSOR_FILE, async () => {
      writeJsonAtomic(CURSOR_FILE, cursor);
    });
  } catch (err) {
    console.error("[coord-chat] cursor save:", err?.message ?? err);
  }
}

function buildMsgLines(kind, m, opts = {}) {
  const who = m.from ?? "?";
  const color = agentColor(who);
  const gutter = color("▎");
  const prefix = opts.history ? A.dim("  ") : "";

  // A channel tag when the message isn't from the focused channel, so cross-
  // channel traffic stays legible without cluttering the common single-room case.
  const otherChan = kind === "room" && m.room && normalizeRoom(m.room) !== normalizeRoom(currentRoom);
  const chanTag = otherChan ? channelColor(`#${normalizeRoom(m.room)}`) + " " : "";

  // System notices (join/part/topic/nick) render as a dim italic one-liner.
  if (m.system) {
    const tag = chanTag ? `#${normalizeRoom(m.room)} ` : "";
    const row = `${prefix}\x1b[2;3m  — ${tag}${who} ${m.text ?? ""} —\x1b[0m`;
    if (!opts.history) lastBlock = { who: null, ts: m.ts, kind: null };
    return ["", row];
  }

  if (m.dice) {
    const row = `${prefix}${chanTag}${m.text ?? ""}`;
    if (!opts.history) lastBlock = { who: null, ts: m.ts, kind: null };
    return ["", row];
  }

  // Body wraps manually under a continuous gutter — terminal auto-wrap would
  // lose the colored gutter on continuation lines.
  const gutterPrefix = `${prefix}${gutter} `;
  const bodyWidth = Math.max(20, COLS - visibleLength(gutterPrefix));
  const text = (m.text ?? "").split("\n").map(formatBody).join("\n");
  const lines = wrapBody(text, bodyWidth);

  // Group onto the previous block when it's the same live sender within the
  // window — skip the blank line + header, just keep the gutter going.
  const grouped = !opts.history
    && lastBlock.who === who && lastBlock.kind === kind
    && (m.ts - lastBlock.ts) < GROUP_WINDOW;

  const outputLines = [];
  if (!grouped) {
    const pinged = mentionsSelf(m.text);
    const badge = kind === "DM" ? A.bold(A.cyan("DM ")) : "";
    const marker = pinged ? A.bold(A.yellow("► ")) : "";
    const headGutter = pinged ? A.bold(color("▌")) : gutter;
    const displayWho = gmDisplayId(who, m.room);
    const header = `${marker}${badge}${chanTag}${A.bold(color(displayWho))} ${A.dim(`· ${resolveDisplayModel(who, m)} · ${relTime(m.ts)}`)}`;
    outputLines.push("");
    outputLines.push(`${prefix}${headGutter} ${header}`);
  }
  for (const line of lines) outputLines.push(`${prefix}${gutter} ${line}`);

  if (!opts.history) lastBlock = { who, ts: m.ts, kind };
  return outputLines;
}

function printMsg(kind, m, opts = {}) {
  const outputLines = buildMsgLines(kind, m, opts);
  if (opts.history) {
    for (const row of outputLines) process.stdout.write(row + "\n");
  } else {
    emitLive(outputLines);
  }
}

function visibleLength(s) {
  // Strip ANSI SGR sequences so we measure on-screen width, not raw bytes.
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Wrap one message's text, preserving list/indent structure: a leading bullet
// ("- ", "* ", "1. ", "2) ") or whitespace indent is detected so wrapped
// continuation lines hang-indent under the text rather than re-flowing as flat
// prose.
function wrapBody(text, width) {
  if (width <= 0) return [text];
  const out = [];
  for (const raw of text.split("\n")) {
    const mk = raw.match(/^(\s*(?:[-*•]\s+|\d+[.)]\s+)?)([\s\S]*)$/);
    const lead = mk ? mk[1] : "";
    const body = mk ? mk[2] : raw;
    const indent = " ".repeat(visibleLength(lead));
    const words = body.length ? body.split(/\s+/) : [];
    if (!words.length) { out.push(lead.trimEnd()); continue; }
    let line = lead + words[0];
    for (let i = 1; i < words.length; i++) {
      const proposed = line + " " + words[i];
      if (visibleLength(proposed) > width) {
        out.push(line);
        line = indent + words[i];
      } else {
        line = proposed;
      }
    }
    out.push(line);
  }
  return out;
}

// Lightweight inline-only "chat markdown" formatter — no dep. Handles bold,
// italic, inline code, links, and @mentions. Order matters: pull out inline
// code spans first so we don't touch their contents, then run the rest.
function formatBody(text) {
  return text.split(/(`[^`\n]+`)/).map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      return A.dim("`") + A.cyan(part.slice(1, -1)) + A.dim("`");
    }
    let s = part;
    // @mentions first — colored in the mentioned agent's hash color, bold if
    // it's the current user (so you can spot pings at a glance).
    s = s.replace(/@([A-Za-z0-9._-]+)/g, (_, name) => {
      const key = normalizeColorKey(name);
      if (key === "all") return A.bold(A.yellow("@all"));
      const colored = agentColor(key)(`@${name}`);
      return key === normalizeColorKey(ID) ? A.bold(colored) : colored;
    });
    // **bold**
    s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => A.bold(t));
    // *italic* and _italic_ (avoid matching inside **bold** by requiring
    // non-asterisk neighbors)
    s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, (_, t) => `\x1b[3m${t}\x1b[0m`);
    s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, (_, t) => `\x1b[3m${t}\x1b[0m`);
    // [text](url) — show text underlined with a dim, shortened trailing (url)
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) =>
      `\x1b[4m${t}\x1b[0m${A.dim(` (${shortenUrl(u)})`)}`,
    );
    // Bare URLs — underline only the URL itself, shortened if long
    s = s.replace(/\bhttps?:\/\/[^\s)]+/g, (u) => `\x1b[4m${shortenUrl(u)}\x1b[0m`);
    return s;
  }).join("");
}

// Long URLs eat a whole wrapped line. Collapse to "host/…/last-segment" so the
// link stays recognizable without dominating the message. Short URLs are left
// intact (and remain copy-pasteable).
function shortenUrl(u) {
  if (u.length <= 48) return u;
  try {
    const { host, pathname } = new URL(u);
    const tail = pathname.split("/").filter(Boolean).pop() ?? "";
    const short = tail ? `${host}/…/${tail}` : host;
    return short.length < u.length ? short : u.slice(0, 45) + "…";
  } catch {
    return u.slice(0, 45) + "…";
  }
}

async function printAgents() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const now = Date.now();
  const STALE = 5 * 60 * 1000;
  const ids = Object.keys(reg).sort();
  if (!ids.length) return say(A.dim("(no agents)"));
  // Compute column widths from data so things line up.
  const idW = Math.max(8, ...ids.map((i) => i.length));
  const roleW = Math.max(4, ...ids.map((i) => (reg[i].role ?? "-").length));
  say(A.bold(`agents (${ids.length}):`));
  say(
    "  " +
      A.dim(
        `${"id".padEnd(idW)}  ${"status".padEnd(7)}  ${"role".padEnd(roleW)}  transport`,
      ),
  );
  for (const id of ids) {
    const a = reg[id];
    const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(id)}.json`), null);
    const managed = listInvited().find((r) => r.agentId === id);
    const live =
      (managed && managed.listenerAlive && managed.daemonAlive) ||
      (marker && marker.pid && pidAlive(marker.pid));
    const onlineNow = live || now - a.lastHeartbeat < STALE;
    const dot = onlineNow ? A.green("●") : A.dim("○");
    const status = onlineNow ? "online " : "offline";
    const role = (a.role ?? "-").padEnd(roleW);
    const trans = live
      ? A.green(marker?.transport === "coord-chat" ? "coord-chat" : (marker?.transport ?? "coord-chat"))
      : A.dim("none");
    const me = id === ID ? A.dim(" (you)") : "";
    say(`  ${dot} ${agentColor(id)(id.padEnd(idW))}  ${A.dim(status)}  ${role}  ${trans}${me}`);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }
}

// Agents considered "logged in": a live transport process, or a heartbeat
// within the stale window. Shared by the @mention picker and completer so we
// only ever offer reachable agents.
function onlineAgentIds() {
  const reg = readJsonSafe(AGENTS_FILE, {});
  const now = Date.now();
  const STALE = 5 * 60 * 1000;
  return Object.keys(reg)
    .filter((id) => {
      const a = reg[id];
      const marker = readJsonSafe(path.join(TRANSPORT_DIR, `${sanitize(id)}.json`), null);
      const managed = listInvited().find((r) => r.agentId === id);
      const live =
        (managed && managed.listenerAlive && managed.daemonAlive) ||
        (marker && marker.pid && pidAlive(marker.pid));
      return live || now - (a?.lastHeartbeat ?? 0) < STALE;
    })
    .sort();
}

// Pop the list of logged-in agents the moment "@" starts a mention token, so
// you can see who's reachable without hunting through /list. The list is
// dim/cosmetic and re-renders above the preserved input line.
function showMentionPicker() {
  if (typeof rl === "undefined") return;
  const before = (rl.line ?? "").slice(0, rl.cursor ?? (rl.line ?? "").length);
  // Only when the just-typed "@" opens a fresh token (start of line or after
  // whitespace) — avoids firing inside emails or mid-word.
  if (!/(^|\s)@$/.test(before)) return;
  const ids = onlineAgentIds().filter((id) => id !== ID);
  if (!ids.length) return;
  const list = ids.map((id) => A.green("●") + agentColor(id)(`@${id}`)).join("  ");
  drawHint(A.dim("  ┄ ") + list + A.dim("   · Tab to complete"));
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  });
}

function readJsonSafe(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, payload, "utf8");
  try {
    renameSync(tmp, file);
  } catch {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    // Windows / concurrent writers: tmp may vanish before rename — direct write still
    // advances the cursor so messages are not replayed into the TUI.
    writeFileSync(file, payload, "utf8");
  }
}
