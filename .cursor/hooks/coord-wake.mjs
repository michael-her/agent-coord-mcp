#!/usr/bin/env node
// One-shot wake fallback (used when daemon is off). Prefer coord-wake-daemon.mjs.

import "./coord-spawn-hide.mjs";

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ID,
  PROJECT,
  MODEL,
  buildPrompt,
  filterBatch,
  hookLog,
  isSessionStaleError,
  loadBatch,
  loadLocalEnv,
  mcpServers,
  queueBatch,
} from "./coord-wake-lib.mjs";
import { clearAgentBusy, isAgentBusy, releaseAgentBusy, setAgentBusy } from "./coord-busy-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.join(__dirname, `coord-wake-${AGENT_ID}.lock`);
const DAEMON_PID = path.join(__dirname, `coord-wake-daemon-${AGENT_ID}.pid`);

loadLocalEnv();

let batch = [];
try {
  batch = filterBatch(loadBatch(process.argv[2] || "[]"));
} catch (err) {
  hookLog(`coord-wake parse error: ${err?.message ?? err}`);
  process.exit(1);
}
if (batch.length === 0) process.exit(0);

if (isAgentBusy(AGENT_ID)) {
  if (process.env.COORD_WAKE_DAEMON !== "0" && isDaemonAlive()) {
    queueBatch(batch);
    hookLog(`coord-wake defer: agent busy, re-queued (${batch.length} msg)`);
  } else {
    hookLog(`coord-wake skip: agent busy (${batch.length} msg)`);
  }
  process.exit(0);
}

if (process.env.COORD_WAKE_DAEMON !== "0" && isDaemonAlive()) {
  queueBatch(batch);
  hookLog(`coord-wake queued (${batch.length} msg) → daemon`);
  process.exit(0);
}

if (existsSync(LOCK)) {
  if (isStaleLock()) {
    hookLog("coord-wake: removing stale lock");
    try {
      unlinkSync(LOCK);
    } catch {
      /* ignore */
    }
  } else {
    hookLog(`coord-wake skip: already running (${batch.length} msg)`);
    process.exit(0);
  }
}

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  hookLog("coord-wake skip: set CURSOR_API_KEY in env or coord-wake.local.env");
  process.exit(1);
}

writeFileSync(LOCK, String(process.pid), "utf8");
setAgentBusy(AGENT_ID, { source: "wake-oneshot", msgs: batch.length });
const t0 = Date.now();
hookLog(`coord-wake SDK start (${batch.length} msg)`);

try {
  const { Agent } = await import("@cursor/sdk");
  const result = await Agent.prompt(buildPrompt(batch), {
    apiKey,
    model: { id: MODEL },
    local: { cwd: PROJECT, settingSources: [] },
    mcpServers: mcpServers(),
  });
  hookLog(`coord-wake done status=${result.status} id=${result.id ?? "?"} ${Date.now() - t0}ms`);
  if (result.status === "error") {
    process.exitCode = 2;
    releaseAgentBusy(AGENT_ID, "wake run error");
    hookLog("coord-wake busy released (run error)");
  }
} catch (err) {
  const msg = err?.message ?? String(err);
  hookLog(`coord-wake failed: ${msg} ${Date.now() - t0}ms`);
  if (isSessionStaleError(msg)) {
    const t1 = Date.now();
    hookLog("coord-wake retry (stale session)");
    try {
      const { Agent } = await import("@cursor/sdk");
      const result = await Agent.prompt(buildPrompt(batch), {
        apiKey,
        model: { id: MODEL },
        local: { cwd: PROJECT, settingSources: [] },
        mcpServers: mcpServers(),
      });
      hookLog(`coord-wake retry done status=${result.status} id=${result.id ?? "?"} ${Date.now() - t1}ms`);
      if (result.status === "error") process.exitCode = 2;
    } catch (err2) {
      hookLog(`coord-wake retry failed: ${err2?.message ?? err2}`);
      console.error("[coord-wake]", err2);
      process.exitCode = 1;
    }
  } else {
    console.error("[coord-wake]", err);
    process.exitCode = 1;
  }
  releaseAgentBusy(AGENT_ID, "wake error");
  hookLog("coord-wake busy released (wake error)");
} finally {
  clearAgentBusy(AGENT_ID);
  try {
    unlinkSync(LOCK);
  } catch {
    /* ignore */
  }
}

function isDaemonAlive() {
  if (!existsSync(DAEMON_PID)) return false;
  try {
    const pid = parseInt(readFileSync(DAEMON_PID, "utf8").trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function isStaleLock() {
  try {
    const pid = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
    if (!pid) return true;
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}
