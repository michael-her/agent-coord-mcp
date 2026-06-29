/**
 * Shared admin command logic for coord-admin CLI and gnd-client proxy.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import {
  clearTransportMarker,
  collectRegistryInviteTargets,
  discoverHookStacks,
  formatHookStackPids,
  inviteAgent,
  isInviteAllArg,
  parseInviteSpec,
  stopAllHookStacks,
  stopHookStack,
  writeTransportMarker,
} from "./coord-agent-spawn.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO = path.resolve(SCRIPT_DIR, "..");

export class AdminCommandError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = "AdminCommandError";
    this.exitCode = exitCode;
  }
}

export function parseAdminCliArgs(argv) {
  const out = { cmd: null, cmdArgs: [], dir: null, repo: null, id: null };
  const positional = [];
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === "--dir" || a === "-d") out.dir = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--id" || a === "-i") out.id = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else positional.push(a);
  }
  out.cmd = positional[0] ?? null;
  out.cmdArgs = positional.slice(1);
  return out;
}

export function adminHelpText() {
  return `coord-admin — agent-coord admin commands for gnd-client

usage: node scripts/coord-admin.mjs <cmd> [args] [--dir <path>] [--repo <path>] [--id <name>]

commands:
  list              show registered agents + transports
  invite [spec]     spawn listener + wake-daemon (<model>@<id> or @all; no arg = invited)
  invited           show listener + wake-daemon stacks (PID files)
  uninvite <id>     stop managed listener + wake-daemon
  uninvite @all     stop all managed stacks
  kick <id>         unregister agent + clear transport/inbox/cursor
`;
}

function loadWorkspaceDefaultModels(repo) {
  const out = { sehui: "human", human: "human" };
  const mcpPath = path.join(repo, ".cursor", "mcp.json");
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
  const wakeEnvPath = path.join(repo, ".cursor", "hooks", "coord-wake.local.env");
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
  const tasksPath = path.join(repo, ".vscode", "tasks.json");
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

function appendRoomSystem(ctx, text) {
  const roomFile = path.join(ctx.root, "room.jsonl");
  appendFileSync(
    roomFile,
    JSON.stringify({
      id: randomUUID(),
      ts: Date.now(),
      from: ctx.selfId,
      kind: "system",
      room: "general",
      text,
    }) + "\n",
    "utf8",
  );
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
  const { root, selfId, agentsFile, transportDir, hooksDir, emit } = ctx;
  const reg = readJsonSafe(agentsFile, {});
  const models = readJsonSafe(path.join(root, "agent-models.json"), {});
  const hookStacks = discoverHookStacks(hooksDir);
  const now = Date.now();
  const ids = Object.keys(reg).sort();
  if (!ids.length) {
    emit("(no agents)");
    return;
  }
  const idW = Math.max(2, ...ids.map((i) => i.length));
  const roleW = Math.max(4, ...ids.map((i) => (reg[i].role ?? "-").length));
  const modelW = Math.max(
    5,
    ...ids.map((i) => resolveDisplayModel(i, reg, models, transportDir, hookStacks).length),
  );
  emit(`agents (${ids.length}):`);
  emit(
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
    emit(
      `  ${dot} ${pad(id, idW)}  ${pad(statusStr, 7)}  ${pad(role, roleW)}  ${pad(model, modelW)}  ${transLabel}${me}`,
    );
  }
}

function printInvited(ctx) {
  const { root, transportDir, hooksDir, emit } = ctx;
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
    emit("no managed hook stacks (listener + wake-daemon PID files)");
    return;
  }
  emit(`invited (${rows.length}):`);
  for (const r of rows) {
    const live = r.listenerAlive && r.daemonAlive;
    const dot = live ? "●" : "○";
    emit(
      `  ${dot} ${pad(r.agentId, 12)} ${r.model}  ${formatHookStackPids(r.listenerPid, r.daemonPid)}`,
    );
  }
}

async function registerInvitedAgent(ctx, agentId, model) {
  await withLock(ctx.agentsFile, async () => {
    const reg = readJsonSafe(ctx.agentsFile, {});
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
    writeJsonAtomic(ctx.agentsFile, reg);
  });
  const roomsFile = path.join(ctx.root, "rooms.json");
  await withLock(roomsFile, async () => {
    const rooms = readJsonSafe(roomsFile, {});
    const e = (rooms.general ??= {
      createdAt: Date.now(),
      createdBy: ctx.selfId,
      members: [],
    });
    if (!e.members.includes(agentId)) e.members.push(agentId);
    writeJsonAtomic(roomsFile, rooms);
  });
}

async function doInviteAgent(ctx, spec, { announce = true, detachChildren = false } = {}) {
  const result = inviteAgent({
    agentId: spec.agentId,
    model: spec.model,
    hooksDir: ctx.hooksDir,
    projectDir: ctx.repo,
    coordDir: ctx.root,
    detachChildren,
  });
  await registerInvitedAgent(ctx, spec.agentId, spec.model);
  writeTransportMarker({
    transportDir: ctx.transportDir,
    agentId: spec.agentId,
    model: spec.model,
    listener: result.listener,
    daemon: result.daemon,
  });
  if (announce) {
    appendRoomSystem(ctx, `invited ${spec.agentId} (${spec.model})`);
  }
  ctx.emit(
    `invited ${spec.agentId} model=${spec.model} ${formatHookStackPids(result.listenerPid, result.daemonPid)}`,
  );
  return result;
}

async function cmdInvite(arg, ctx, { detachChildren = false } = {}) {
  if (!arg) {
    printInvited(ctx);
    return;
  }
  if (isInviteAllArg(arg)) {
    await cmdInviteAll(ctx, { detachChildren });
    return;
  }
  const spec = parseInviteSpec(arg);
  if (!spec) {
    throw new AdminCommandError(
      "usage: invite <model>@<agentId>  (e.g. composer-2.5@rico) or invite @all",
    );
  }
  await doInviteAgent(ctx, spec, { detachChildren });
}

async function cmdInviteAll(ctx, { detachChildren = false } = {}) {
  const reg = readJsonSafe(ctx.agentsFile, {});
  const models = readJsonSafe(path.join(ctx.root, "agent-models.json"), {});
  const defaults = loadWorkspaceDefaultModels(ctx.repo);
  const { targets, skipped } = collectRegistryInviteTargets({
    registry: reg,
    models,
    defaults,
    excludeId: ctx.selfId,
  });
  if (!targets.length) {
    ctx.emit("no invitable agents in registry (excluding you)");
    for (const s of skipped) {
      ctx.emit(`  skip ${s.agentId}: ${s.reason}`);
    }
    return;
  }
  ctx.emit(`inviting ${targets.length} agent(s) from agents.json…`);
  const invited = [];
  let failed = 0;
  for (const spec of targets) {
    try {
      await doInviteAgent(ctx, spec, { announce: false, detachChildren });
      invited.push(spec);
    } catch (err) {
      failed++;
      ctx.emit(`invite failed for ${spec.agentId}: ${err?.message ?? err}`);
    }
  }
  if (invited.length) {
    const summary = invited.map((s) => `${s.agentId} (${s.model})`).join(", ");
    appendRoomSystem(ctx, `invited ${summary}`);
  }
  for (const s of skipped) {
    ctx.emit(`  skip ${s.agentId}: ${s.reason}`);
  }
  ctx.emit(
    `done: ${invited.length} invited` +
      (failed ? `, ${failed} failed` : "") +
      (skipped.length ? `, ${skipped.length} skipped` : ""),
  );
}

async function cmdUninvite(arg, ctx) {
  if (!arg) {
    throw new AdminCommandError("usage: uninvite <agentId|@all>");
  }
  const { transportDir, hooksDir } = ctx;
  if (isInviteAllArg(arg)) {
    const ids = stopAllHookStacks(hooksDir);
    for (const id of ids) clearTransportMarker(transportDir, id);
    if (!ids.length) ctx.emit("no managed hook stacks found");
    else ctx.emit(`stopped ${ids.length} agent(s): ${ids.join(", ")}`);
    return;
  }
  const id = arg.trim().toLowerCase();
  if (stopHookStack(hooksDir, id)) {
    clearTransportMarker(transportDir, id);
    ctx.emit(`stopped ${id} (listener + wake-daemon)`);
  } else {
    ctx.emit(`no managed stack for ${id}`);
  }
}

async function cmdKick(target, ctx) {
  const id = String(target ?? "").trim().toLowerCase();
  if (!id) {
    throw new AdminCommandError("usage: kick <agentId>");
  }
  const { agentsFile, transportDir, hooksDir, inboxDir, cursorDir } = ctx;
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
    throw new AdminCommandError(`agent '${id}' not registered`);
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
  ctx.emit(`kicked ${id} (registry, transport, inbox, cursor, managed stack cleared)`);
}

export function buildAdminContext({ dir, repo, id, emit = (line) => console.log(line) }) {
  const root = dir ?? process.env.AGENT_COORD_DIR ?? path.join(homedir(), "agent-coord");
  const project = repo ?? process.env.CURSOR_PROJECT_DIR ?? DEFAULT_REPO;
  const selfId = (id ?? process.env.USER ?? "human").toLowerCase();
  const hooksDir = path.join(project, ".cursor", "hooks");
  return {
    root,
    repo: project,
    selfId,
    agentsFile: path.join(root, "agents.json"),
    transportDir: path.join(root, "transports"),
    inboxDir: path.join(root, "inbox"),
    cursorDir: path.join(root, "cursors"),
    hooksDir,
    emit,
  };
}

export async function runAdminCommand(ctx, cmd, cmdArgs = [], { detachChildren = false } = {}) {
  const lines = [];
  const active = { ...ctx, emit: (line) => lines.push(String(line)) };
  switch (cmd) {
    case "list":
    case "who":
      printList(active);
      break;
    case "invited":
      printInvited(active);
      break;
    case "invite":
      await cmdInvite(cmdArgs[0], active, { detachChildren });
      break;
    case "uninvite":
      await cmdUninvite(cmdArgs[0], active);
      break;
    case "kick":
      await cmdKick(cmdArgs[0], active);
      break;
    default:
      throw new AdminCommandError(`unknown command: ${cmd}`);
  }
  return lines;
}

export function stopAllManagedStacks(ctx) {
  const ids = stopAllHookStacks(ctx.hooksDir);
  for (const id of ids) clearTransportMarker(ctx.transportDir, id);
  return ids;
}
