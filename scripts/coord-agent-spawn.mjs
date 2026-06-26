import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { saveAgentModel } from "../.cursor/hooks/coord-agent-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, { model: string, listener: import("node:child_process").ChildProcess, daemon: import("node:child_process").ChildProcess }>} */
const stacks = new Map();

const INVITE_RE = /^([^@\s]+)@([A-Za-z0-9._-]+)$/;

export function parseInviteSpec(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const m = raw.match(INVITE_RE);
  if (!m) return null;
  return { model: m[1], agentId: m[2].toLowerCase() };
}

/** True for `/invite @all` (bulk invite from agents.json). */
export function isInviteAllArg(text) {
  return /^@?all$/i.test(String(text ?? "").trim());
}

/**
 * Build invite specs from agents.json for bulk `/invite @all`.
 * Skips the executor, humans, and entries without an invitable model.
 */
export function collectRegistryInviteTargets({
  registry,
  models = {},
  defaults = {},
  excludeId,
}) {
  const self = String(excludeId ?? "").trim().toLowerCase();
  const targets = [];
  const skipped = [];
  for (const [key, entry] of Object.entries(registry ?? {})) {
    const agentId = String(entry?.agentId ?? key).trim().toLowerCase();
    if (!agentId || agentId === self) continue;
    if (entry?.role === "human") {
      skipped.push({ agentId, reason: "human" });
      continue;
    }
    const model =
      entry?.model || models[agentId] || defaults[agentId] || null;
    if (!model || model === "human" || model === "—") {
      skipped.push({ agentId, reason: "no model" });
      continue;
    }
    targets.push({ agentId, model: String(model) });
  }
  targets.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return { targets, skipped };
}

export function listInvited() {
  return [...stacks.entries()].map(([agentId, e]) => ({
    agentId,
    model: e.model,
    listenerPid: e.listener?.pid ?? null,
    daemonPid: e.daemon?.pid ?? null,
    listenerAlive: childAlive(e.listener),
    daemonAlive: childAlive(e.daemon),
  }));
}

export function isInvited(agentId) {
  return stacks.has(String(agentId ?? "").trim().toLowerCase());
}

function childAlive(proc) {
  if (!proc?.pid) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function pidFile(hooksDir, name) {
  return path.join(hooksDir, name);
}

/** Kill orphan listener/daemon from a previous coord-chat or VS Code task. */
export function killStaleHookProcesses(hooksDir, agentId) {
  const id = String(agentId ?? "").trim().toLowerCase();
  for (const suffix of [`coord-listener-${id}.pid`, `coord-wake-daemon-${id}.pid`]) {
    const file = pidFile(hooksDir, suffix);
    if (!existsSync(file)) continue;
    let old = 0;
    try {
      old = parseInt(readFileSync(file, "utf8").trim(), 10);
    } catch {
      /* ignore */
    }
    if (old && old !== process.pid && childAlive({ pid: old })) {
      try {
        process.kill(old, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
    try {
      unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

function baseChildEnv({ agentId, coordDir, projectDir, model }) {
  return {
    ...process.env,
    AGENT_COORD_ID: agentId,
    AGENT_COORD_DIR: coordDir,
    CLAUDE_COORD_DIR: coordDir,
    CURSOR_PROJECT_DIR: projectDir,
    COORD_WAKE: "1",
    COORD_WAKE_DAEMON: "1",
    COORD_WAKE_DEBOUNCE_MS: process.env.COORD_WAKE_DEBOUNCE_MS || "300",
    COORD_AUTO_REPLY: "0",
    COORD_WAKE_MODEL: model,
    COORD_CHAT_MANAGED: "1",
    COORD_CHAT_PARENT_PID: String(process.pid),
  };
}

function spawnHookChild(hooksDir, projectDir, script, env) {
  const entry = path.join(hooksDir, script);
  // Scripts import coord-spawn-hide.mjs themselves. Do not pass --import with an
  // absolute Windows path (Node 22 treats G:\... as URL scheme "g:" → exit 1).
  return spawn(process.execPath, [entry], {
    cwd: projectDir,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
}

function killChild(proc, signal = "SIGTERM") {
  if (!proc?.pid || proc.killed) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    process.kill(proc.pid, signal);
  } catch {
    /* ignore */
  }
}

export function getInvitedStack(agentId) {
  return stacks.get(String(agentId ?? "").trim().toLowerCase()) ?? null;
}

/**
 * Start listener + wake-daemon for an agent. Returns { agentId, model }.
 * Re-inviting the same id stops the previous stack first.
 */
export function inviteAgent({
  agentId,
  model,
  hooksDir,
  projectDir,
  coordDir,
  onChildExit,
}) {
  const id = String(agentId ?? "").trim().toLowerCase();
  const modelName = String(model ?? "").trim();
  if (!id || !modelName) throw new Error("agent id and model required");

  if (stacks.has(id)) stopAgent(id, hooksDir);

  killStaleHookProcesses(hooksDir, id);

  const env = baseChildEnv({ agentId: id, coordDir, projectDir, model: modelName });
  const listener = spawnHookChild(hooksDir, projectDir, "coord-listener.mjs", env);
  const daemon = spawnHookChild(hooksDir, projectDir, "coord-wake-daemon.mjs", env);

  const attachExit = (label, proc) => {
    proc.on("exit", (code, signal) => {
      onChildExit?.({ agentId: id, label, code, signal });
    });
    proc.on("error", (err) => {
      onChildExit?.({ agentId: id, label, error: err?.message ?? String(err) });
    });
  };
  attachExit("listener", listener);
  attachExit("daemon", daemon);

  stacks.set(id, { model: modelName, listener, daemon });
  saveAgentModel(id, modelName);

  return {
    agentId: id,
    model: modelName,
    listener,
    daemon,
    listenerPid: listener.pid,
    daemonPid: daemon.pid,
  };
}

export function stopAgent(agentId, hooksDir) {
  const id = String(agentId ?? "").trim().toLowerCase();
  const entry = stacks.get(id);
  if (!entry) {
    killStaleHookProcesses(hooksDir, id);
    return false;
  }
  killChild(entry.listener, "SIGTERM");
  killChild(entry.daemon, "SIGTERM");
  stacks.delete(id);
  killStaleHookProcesses(hooksDir, id);
  return true;
}

export function stopAll(hooksDir) {
  for (const id of [...stacks.keys()]) stopAgent(id, hooksDir);
}

export function writeTransportMarker({ transportDir, agentId, model, listener, daemon }) {
  mkdirSync(transportDir, { recursive: true });
  const file = path.join(transportDir, `${agentId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        transport: "coord-chat",
        pid: listener?.pid ?? null,
        daemonPid: daemon?.pid ?? null,
        parentPid: process.pid,
        model,
        ts: Date.now(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function clearTransportMarker(transportDir, agentId) {
  const file = path.join(
    transportDir,
    `${String(agentId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`,
  );
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
}
