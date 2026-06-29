#!/usr/bin/env node
/**
 * Admin CLI for gnd-client: list / invited / uninvite / kick
 *
 * Usage:
 *   node scripts/coord-admin.mjs <cmd> [args] [--dir <coord>] [--repo <project>] [--id <self>]
 */

import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  clearTransportMarker,
  discoverHookStacks,
  isInviteAllArg,
  stopAllHookStacks,
  stopHookStack,
} from "./coord-agent-spawn.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(SCRIPT_DIR, "..");

function parseArgs(argv) {
  const out = { cmd: null, cmdArgs: [], dir: null, repo: null, id: null };
  const positional = [];
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === "--dir" || a === "-d") out.dir = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--id" || a === "-i") out.id = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else positional.push(a);
  }
  out.cmd = positional[0] ?? null;
  out.cmdArgs = positional.slice(1);
  return out;
}

function printHelp() {
  console.log(`coord-admin — agent-coord admin commands for gnd-client

usage: node scripts/coord-admin.mjs <cmd> [args] [--dir <path>] [--repo <path>] [--id <name>]

commands:
  list              show registered agents + transports
  invited           show listener + wake-daemon stacks (PID files)
  uninvite <id>     stop managed listener + wake-daemon
  uninvite @all     stop all managed stacks
  kick <id>         unregister agent + clear transport/inbox/cursor
`);
}

function readJsonSafe(file, fallback) {
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
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, file);
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

async function ensureFile(file) {
  if (!existsSync(file)) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "");
  }
}

async function withLock(file, fn) {
  await ensureFile(file);
  const release = await lockfile.lock(file, {
    retries: { retries: 10, minTimeout: 20, maxTimeout: 200 },
    stale: 5000,
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

function resolveDisplayModel(who, reg, models, transportDir, hookStacks) {
  const invited = hookStacks.find((r) => r.agentId === who);
  if (invited?.model) return invited.model;
  const marker = readJsonSafe(path.join(transportDir, `${sanitize(who)}.json`), null);
  if (marker?.model) return String(marker.model);
  if (models[who]) return models[who];
  if (reg[who]?.model) return reg[who].model;
  return "—";
}

function agentTransportLive(id, selfId, marker, hookRow) {
  if (id === selfId) return true;
  return (
    (hookRow && hookRow.listenerAlive && hookRow.daemonAlive) ||
    (marker && marker.pid && pidAlive(marker.pid))
  );
}

function agentOnline(id, selfId, entry, live, now, staleMs = 5 * 60 * 1000) {
  if (id === selfId) return true;
  return live || now - (entry?.lastHeartbeat ?? 0) < staleMs;
}

function pad(s, w) {
  const t = String(s);
  return t.length >= w ? t : t + " ".repeat(w - t.length);
}

function printList(ctx) {
  const { root, selfId, agentsFile, transportDir, hooksDir } = ctx;
  const reg = readJsonSafe(agentsFile, {});
  const models = readJsonSafe(path.join(root, "agent-models.json"), {});
  const hookStacks = discoverHookStacks(hooksDir);
  const now = Date.now();
  const ids = Object.keys(reg).sort();
  if (!ids.length) {
    console.log("(no agents)");
    return;
  }
  const idW = Math.max(2, ...ids.map((i) => i.length));
  const roleW = Math.max(4, ...ids.map((i) => (reg[i].role ?? "-").length));
  const modelW = Math.max(
    5,
    ...ids.map((i) => resolveDisplayModel(i, reg, models, transportDir, hookStacks).length),
  );
  console.log(`agents (${ids.length}):`);
  console.log(
    `  ${pad("id", idW)}  ${pad("status", 7)}  ${pad("role", roleW)}  ${pad("model", modelW)}  transport`,
  );
  for (const id of ids) {
    const a = reg[id];
    const marker = readJsonSafe(path.join(transportDir, `${sanitize(id)}.json`), null);
    const hookRow = hookStacks.find((r) => r.agentId === id);
    const live = agentTransportLive(id, selfId, marker, hookRow);
    const onlineNow = agentOnline(id, selfId, a, live, now);
    const dot = onlineNow ? "●" : "○";
    const statusStr = onlineNow ? "online" : "offline";
    const role = a.role ?? "-";
    const model = resolveDisplayModel(id, reg, models, transportDir, hookStacks);
    const transLabel = live ? (marker?.transport ?? "coord-chat") : "none";
    const me = id === selfId ? " (you)" : "";
    console.log(
      `  ${dot} ${pad(id, idW)}  ${pad(statusStr, 7)}  ${pad(role, roleW)}  ${pad(model, modelW)}  ${transLabel}${me}`,
    );
  }
}

function printInvited(ctx) {
  const { root, transportDir, hooksDir } = ctx;
  const models = readJsonSafe(path.join(root, "agent-models.json"), {});
  const rows = discoverHookStacks(hooksDir).map((r) => {
    const marker = readJsonSafe(
      path.join(transportDir, `${sanitize(r.agentId)}.json`),
      null,
    );
    const model =
      marker?.model ?? models[r.agentId] ?? readJsonSafe(path.join(root, "agents.json"), {})[r.agentId]?.model ?? "—";
    return { ...r, model: String(model) };
  });
  if (!rows.length) {
    console.log("no managed hook stacks (listener + wake-daemon PID files)");
    return;
  }
  console.log(`invited (${rows.length}):`);
  for (const r of rows) {
    const live = r.listenerAlive && r.daemonAlive;
    const dot = live ? "●" : "○";
    console.log(
      `  ${dot} ${pad(r.agentId, 12)} ${r.model}  listener=${r.listenerPid ?? "-"} daemon=${r.daemonPid ?? "-"}`,
    );
  }
}

async function cmdUninvite(arg, ctx) {
  if (!arg) {
    console.log("usage: uninvite <agentId|@all>");
    process.exit(1);
  }
  const { transportDir, hooksDir } = ctx;
  if (isInviteAllArg(arg)) {
    const ids = stopAllHookStacks(hooksDir);
    for (const id of ids) clearTransportMarker(transportDir, id);
    if (!ids.length) console.log("no managed hook stacks found");
    else console.log(`stopped ${ids.length} agent(s): ${ids.join(", ")}`);
    return;
  }
  const id = arg.trim().toLowerCase();
  if (stopHookStack(hooksDir, id)) {
    clearTransportMarker(transportDir, id);
    console.log(`stopped ${id} (listener + wake-daemon)`);
  } else {
    console.log(`no managed stack for ${id}`);
  }
}

async function cmdKick(target, ctx) {
  const id = String(target ?? "").trim().toLowerCase();
  if (!id) {
    console.log("usage: kick <agentId>");
    process.exit(1);
  }
  const { root, agentsFile, transportDir, hooksDir, inboxDir, cursorDir } = ctx;
  stopHookStack(hooksDir, id);
  clearTransportMarker(transportDir, id);
  let existed = false;
  await withLock(agentsFile, async () => {
    const reg = readJsonSafe(agentsFile, {});
    if (reg[id]) {
      existed = true;
      delete reg[id];
      writeJsonAtomic(agentsFile, reg);
    }
  });
  if (!existed) {
    console.log(`agent '${id}' not registered`);
    process.exit(1);
  }
  const markerPath = path.join(transportDir, `${sanitize(id)}.json`);
  try {
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    /* ignore */
  }
  const inboxPath = path.join(inboxDir, `${sanitize(id)}.jsonl`);
  const cursorPath = path.join(cursorDir, `${sanitize(id)}.json`);
  try {
    if (existsSync(inboxPath)) unlinkSync(inboxPath);
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(cursorPath)) unlinkSync(cursorPath);
  } catch {
    /* ignore */
  }
  console.log(`kicked ${id} (registry, transport, inbox, cursor, managed stack cleared)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd) {
    printHelp();
    process.exit(1);
  }
  const root =
    args.dir ?? process.env.AGENT_COORD_DIR ?? path.join(homedir(), "agent-coord");
  const repo =
    args.repo ?? process.env.CURSOR_PROJECT_DIR ?? DEFAULT_REPO;
  const selfId = (args.id ?? process.env.USER ?? "human").toLowerCase();
  const hooksDir = path.join(repo, ".cursor", "hooks");
  const ctx = {
    root,
    repo,
    selfId,
    agentsFile: path.join(root, "agents.json"),
    transportDir: path.join(root, "transports"),
    inboxDir: path.join(root, "inbox"),
    cursorDir: path.join(root, "cursors"),
    hooksDir,
  };

  switch (args.cmd) {
    case "list":
    case "who":
      printList(ctx);
      break;
    case "invited":
      printInvited(ctx);
      break;
    case "uninvite":
      await cmdUninvite(args.cmdArgs[0], ctx);
      break;
    case "kick":
      await cmdKick(args.cmdArgs[0], ctx);
      break;
    default:
      console.error(`unknown command: ${args.cmd}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
