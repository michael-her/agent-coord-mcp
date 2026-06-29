#!/usr/bin/env node
// Cursor stop hook: drain unread agent-coord messages and auto-continue via followup_message.
// Adapted from agent-coord-mcp/hooks/peek-coord.mjs (Claude Code Stop → Cursor stop).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dirname, "coord-stop.log");
const HOOKS_LOG = join(__dirname, "coord-hooks.log");

function log(line) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

function hookLog(line) {
  try {
    appendFileSync(HOOKS_LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

import { resolveSessionAgent, mcpServerName } from "./coord-agent-lib.mjs";
import { isAgentBusy } from "./coord-busy-lib.mjs";
import { shouldWakeForCoordMessage } from "./coord-mention-lib.mjs";
import { gmWakeReplyTail } from "./coord-gm-lib.mjs";
import { isWakeClaimed } from "./coord-wake-claim-lib.mjs";
import { isProcessAlive } from "./coord-wake-lib.mjs";

const ROOT =
  process.env.AGENT_COORD_DIR ||
  process.env.CLAUDE_COORD_DIR ||
  path.join(homedir(), "agent-coord");
const INCLUDE_ROOM = process.env.AGENT_COORD_INCLUDE_ROOM !== "0";
const DEFAULT_ROOM = "general";

function wakeDaemonPidFile(agentId) {
  return join(__dirname, `coord-wake-daemon-${String(agentId).trim().toLowerCase()}.pid`);
}

/** True when coord-chat backend manages wake for this agent (skip IDE stop-hook delivery). */
function isCoordWakeManaged(agentId) {
  const file = wakeDaemonPidFile(agentId);
  if (!existsSync(file)) return false;
  try {
    const pid = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Boolean(pid && isProcessAlive(pid));
  } catch {
    return false;
  }
}

function main() {
  log(`START stop pid=${process.pid}`);

  let input = {};
  try {
    const raw = readFileSync(0, "utf8");
    if (raw.trim()) input = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  const AGENT_ID = resolveSessionAgent(input);
  const INBOX = path.join(ROOT, "inbox", `${sanitize(AGENT_ID)}.jsonl`);
  const CURSOR_FILE = path.join(ROOT, "cursors", `${sanitize(AGENT_ID)}.json`);

  log(`stop hook fired status=${input.status ?? "?"} loop=${input.loop_count ?? "?"}`);

  if (input.status && input.status !== "completed") {
    log("skip: status not completed");
    process.stdout.write("{}\n");
    return;
  }

  if (isAgentBusy(AGENT_ID)) {
    log("skip: agent busy (wake in progress)");
    hookLog(`stop skip: agent busy (${AGENT_ID})`);
    process.stdout.write("{}\n");
    return;
  }

  if (isCoordWakeManaged(AGENT_ID)) {
    log("skip: coord-chat wake-daemon manages @mention delivery");
    hookLog(`stop skip: wake-daemon active (${AGENT_ID})`);
    process.stdout.write("{}\n");
    return;
  }

  const cursor = readJson(CURSOR_FILE, {});
  const lines = [];

  for (const m of drain(INBOX, cursor, "inboxOffset")) {
    if (!m.control && !isWakeClaimed(AGENT_ID, m)) lines.push(fmt("dm", null, m));
  }

  if (INCLUDE_ROOM) {
    for (const chan of joinedRooms(AGENT_ID)) {
      for (const m of drainRoom(chan, cursor)) {
        if (m.from === AGENT_ID || m.control) continue;
        if (isWakeClaimed(AGENT_ID, m)) continue;
        if (!shouldWakeForCoordMessage(m, AGENT_ID, { isDm: false, room: m.room ?? chan })) continue;
        lines.push(fmt("room", chan, m));
      }
    }
  }

  if (lines.length === 0) {
    log("no unread @mention messages");
    hookLog("stop no unread @mention coord-chat messages");
    process.stdout.write("{}\n");
    return;
  }

  writeJsonAtomic(CURSOR_FILE, cursor);
  log(`followup for ${lines.length} message(s)`);
  hookLog(`stop followup ${lines.length} msg(s) from coord-chat`);

  const body = lines.join("\n");
  const mcp = mcpServerName(AGENT_ID);
  const style = gmWakeReplyTail(AGENT_ID);
  const followup =
    `[agent-coord 자동 푸시] coord-chat에서 새 메시지가 왔어. ` +
    `아래 내용은 hook이 이미 읽음 처리했으니 read_messages 다시 호출하지 마.\n\n` +
    body +
    `\n\n${mcp} MCP로 #general(또는 해당 채널)에 send_message({from:"${AGENT_ID}", ...})로 답해줘. ` +
    style;

  process.stdout.write(JSON.stringify({ followup_message: followup }) + "\n");
}

function drain(file, cursor, key) {
  const all = readJsonlParsed(file);
  const start = cursor[key] ?? 0;
  const slice = all.slice(start);
  if (slice.length > 0) cursor[key] = start + slice.length;
  return slice;
}

function drainRoom(chan, cursor) {
  const c = normalizeRoom(chan);
  const all = readJsonlParsed(roomFile(c));
  const start = getRoomOffset(cursor, c);
  const slice = all.slice(start);
  if (slice.length > 0) setRoomOffset(cursor, c, start + slice.length);
  return slice;
}

function fmt(source, chan, m) {
  const ts = new Date(m.ts ?? Date.now()).toISOString();
  const who = m.from ?? "?";
  const tag = source === "room" ? `room #${normalizeRoom(chan)}` : "dm";
  return `  [${tag} ${ts} from=${who}] ${m.text ?? ""}`;
}

function normalizeRoom(name) {
  if (!name) return DEFAULT_ROOM;
  const n = String(name)
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return n || DEFAULT_ROOM;
}

function roomFile(chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM
    ? path.join(ROOT, "room.jsonl")
    : path.join(ROOT, "rooms", `${sanitize(c)}.jsonl`);
}

function getRoomOffset(cursor, chan) {
  const c = normalizeRoom(chan);
  return c === DEFAULT_ROOM ? (cursor.roomOffset ?? 0) : (cursor.roomOffsets?.[c] ?? 0);
}

function setRoomOffset(cursor, chan, n) {
  const c = normalizeRoom(chan);
  if (c === DEFAULT_ROOM) cursor.roomOffset = n;
  else (cursor.roomOffsets ??= {})[c] = n;
}

function joinedRooms(agentId) {
  const reg = readJson(path.join(ROOT, "rooms.json"), {});
  const out = new Set([DEFAULT_ROOM]);
  for (const [chan, e] of Object.entries(reg)) {
    if (e && Array.isArray(e.members) && e.members.includes(agentId)) out.add(chan);
  }
  return [...out];
}

function readJsonlParsed(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}

function sanitize(id) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

main();
