#!/usr/bin/env node
// Warm agent for coord-chat wake — reuses one local SDK agent instead of cold Agent.prompt().

import "./coord-spawn-hide.mjs";

import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  watch,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ID,
  PROJECT,
  MODEL,
  buildPrompt,
  filterBatch,
  hookLog,
  isProcessAlive,
  isRecoverableWakeError,
  isSessionStaleError,
  isWakeTimeoutError,
  loadLocalEnv,
  mcpServers,
  QUEUE_FILE,
  SESSION_IDLE_MS,
  waitForRun,
} from "./coord-wake-lib.mjs";
import { saveAgentModel } from "./coord-agent-lib.mjs";
import { clearAgentBusy, releaseAgentBusy, setAgentBusy } from "./coord-busy-lib.mjs";
import {
  advanceAgentCursorForWake,
  claimWakeMessages,
  dedupeWakeItems,
  filterUnclaimed,
} from "./coord-wake-claim-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = path.join(__dirname, `coord-wake-daemon-${AGENT_ID}.pid`);
const AGENT_ID_FILE = path.join(__dirname, `coord-wake-agent-id-${AGENT_ID}.txt`);
const STATE_FILE = path.join(__dirname, `coord-wake-daemon-state-${AGENT_ID}.json`);

loadLocalEnv();
saveAgentModel(AGENT_ID, MODEL);

const apiKey = process.env.CURSOR_API_KEY?.trim();
if (!apiKey) {
  console.error("[coord-wake-daemon] set CURSOR_API_KEY in coord-wake.local.env");
  process.exit(1);
}

if (!claimDaemonPid()) {
  process.exit(0);
}

process.on("exit", () => {
  clearAgentBusy(AGENT_ID);
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
});

let agent = null;
let processing = false;
let queueChain = Promise.resolve();
let state = loadState();
let lastSuccessAt = Date.now();
let sessionNeedsReconnect = false;

// SDK stall-detector aborts can surface as late unhandled rejections — don't exit.
process.on("unhandledRejection", (err) => {
  const msg = err?.message ?? String(err);
  hookLog(`coord-wake unhandled: ${msg}`);
  if (isSessionStaleError(msg)) sessionNeedsReconnect = true;
  void resetAgent("unhandled rejection", { discardSavedId: isSessionStaleError(msg) });
  releaseAgentBusy(AGENT_ID, "unhandled rejection");
  hookLog("coord-wake busy released (unhandled rejection)");
});

process.on("uncaughtException", (err) => {
  const msg = err?.message ?? String(err);
  hookLog(`coord-wake uncaught: ${msg}`);
  if (isSessionStaleError(msg)) sessionNeedsReconnect = true;
  void resetAgent("uncaught exception", { discardSavedId: isSessionStaleError(msg) });
  releaseAgentBusy(AGENT_ID, "uncaught exception");
  hookLog("coord-wake busy released (uncaught exception)");
  processing = false;
});

console.log(`[coord-wake-daemon] agent=${AGENT_ID} model=${MODEL} queue=${QUEUE_FILE}`);
hookLog("coord-wake daemon start");

if (!existsSync(QUEUE_FILE)) writeFileSync(QUEUE_FILE, "", "utf8");

const drain = () => {
  queueChain = queueChain.then(() => processQueue()).catch((err) => {
    hookLog(`coord-wake queue error: ${err?.message ?? err}`);
  });
};

try {
  watch(QUEUE_FILE, drain);
} catch {
  /* queue file may not exist yet */
}
setInterval(drain, 400);

// Drop stale warm sessions during idle so the first post-idle wake does not hang.
setInterval(() => {
  if (processing || !agent) return;
  const idleMs = Date.now() - lastSuccessAt;
  if (idleMs < SESSION_IDLE_MS) return;
  void resetAgent("idle timeout (proactive)", { discardSavedId: true });
}, 60_000);

process.on("SIGINT", () => {
  releaseAgentBusy(AGENT_ID, "SIGINT");
  console.log("\n[coord-wake-daemon] stopped");
  process.exit(0);
});

async function processQueue() {
  if (processing) return;
  if (!existsSync(QUEUE_FILE)) return;

  processing = true;
  try {
    const size = readFileSync(QUEUE_FILE).length;
    const offset = state.queueOffset ?? 0;
    if (size < offset) state.queueOffset = 0;
    if (size <= (state.queueOffset ?? 0)) return;

    const chunk = readFileSync(QUEUE_FILE).subarray(state.queueOffset ?? 0, size);
    state.queueOffset = size;
    saveState(state);

    const lines = chunk.toString("utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let batch;
      try {
        batch = filterUnclaimed(
          AGENT_ID,
          dedupeWakeItems(filterBatch(JSON.parse(line))),
        );
      } catch {
        continue;
      }
      if (batch.length === 0) continue;
      claimWakeMessages(AGENT_ID, batch);
      setAgentBusy(AGENT_ID, { source: "wake-daemon", msgs: batch.length });
      try {
        await runWakeBatch(batch);
      } catch (err) {
        const msg = err?.message ?? String(err);
        hookLog(`coord-wake batch failed: ${msg}`);
        releaseAgentBusy(AGENT_ID, "batch error");
        hookLog("coord-wake busy released (batch error)");
      } finally {
        clearAgentBusy(AGENT_ID);
      }
    }
  } finally {
    processing = false;
  }
}

async function runWakeBatch(batch) {
  const t0 = Date.now();
  hookLog(`coord-wake SDK start (${batch.length} msg)`);
  await refreshAgentIfIdle();

  let result;
  try {
    result = await sendWakeBatch(batch, false);
  } catch (err) {
    const msg = err?.message ?? String(err);
    hookLog(`coord-wake failed: ${msg} ${Date.now() - t0}ms`);
    if (isWakeTimeoutError(msg)) {
      await retryWakeBatch(batch, "run timeout", t0, { force: true, discardSavedId: true });
      return;
    }
    if (isRecoverableWakeError(msg)) {
      await retryWakeBatch(batch, "recoverable error", t0, { force: true, discardSavedId: false });
      return;
    }
    if (isSessionStaleError(msg)) {
      await retryWakeBatch(batch, "stale session", t0, { force: true, discardSavedId: true });
      return;
    }
    await resetAgent("error");
    return;
  }

  const reconnect = sessionNeedsReconnect;
  sessionNeedsReconnect = false;

  hookLog(
    `coord-wake done status=${result.status} id=${result.id ?? "?"} ${Date.now() - t0}ms`
  );

  if (result.status === "finished") {
    lastSuccessAt = Date.now();
    return;
  }

  if (result.status === "error") {
    if (reconnect) {
      await retryWakeBatch(batch, "stale session (run error)", t0, {
        force: true,
        discardSavedId: true,
      });
      return;
    }
    await resetAgent("run error", { discardSavedId: true });
  }
}

async function retryWakeBatch(batch, reason, t0, { force, discardSavedId }) {
  await resetAgent(reason, { discardSavedId });
  const t1 = Date.now();
  hookLog(`coord-wake retry (${batch.length} msg) reason=${reason}`);
  try {
    const result = await sendWakeBatch(batch, force);
    hookLog(
      `coord-wake retry done status=${result.status} id=${result.id ?? "?"} ${Date.now() - t1}ms`
    );
    if (result.status === "finished") {
      lastSuccessAt = Date.now();
      return;
    }
    await resetAgent("retry run error", { discardSavedId: true });
  } catch (err2) {
    hookLog(`coord-wake retry failed: ${err2?.message ?? err2} ${Date.now() - t1}ms`);
    await resetAgent("retry failed", { discardSavedId: isSessionStaleError(err2?.message ?? err2) });
  }
}

async function sendWakeBatch(batch, force) {
  const a = await getAgent();
  const run = await a.send(buildPrompt(batch), {
    mcpServers: mcpServers(),
    local: { force },
  });
  return await waitForRun(run);
}

async function refreshAgentIfIdle() {
  if (!agent) return;
  const idleMs = Date.now() - lastSuccessAt;
  if (idleMs < SESSION_IDLE_MS) return;
  hookLog(`coord-wake idle ${Math.round(idleMs / 60000)}m — refreshing session`);
  await resetAgent("idle timeout", { discardSavedId: true });
}

async function getAgent() {
  if (agent) return agent;
  const { Agent } = await import("@cursor/sdk");
  const opts = {
    apiKey,
    model: { id: MODEL },
    local: { cwd: PROJECT, settingSources: [] },
    mcpServers: mcpServers(),
  };

  const savedId = existsSync(AGENT_ID_FILE) ? readFileSync(AGENT_ID_FILE, "utf8").trim() : "";
  if (savedId) {
    try {
      agent = await Agent.resume(savedId, opts);
      hookLog(`coord-wake daemon resumed ${savedId}`);
      return agent;
    } catch (err) {
      const msg = err?.message ?? String(err);
      hookLog(`coord-wake daemon resume failed: ${msg}`);
      if (isSessionStaleError(msg)) {
        try {
          unlinkSync(AGENT_ID_FILE);
        } catch {
          /* ignore */
        }
      }
    }
  }

  agent = await Agent.create(opts);
  writeFileSync(AGENT_ID_FILE, agent.agentId, "utf8");
  hookLog(`coord-wake daemon created ${agent.agentId}`);
  return agent;
}

async function resetAgent(reason, { discardSavedId = false } = {}) {
  hookLog(`coord-wake reset agent: ${reason}`);
  if (agent) {
    try {
      agent.close();
    } catch {
      /* ignore */
    }
    agent = null;
  }
  if (discardSavedId && existsSync(AGENT_ID_FILE)) {
    try {
      unlinkSync(AGENT_ID_FILE);
    } catch {
      /* ignore */
    }
  }
}

function claimDaemonPid() {
  if (existsSync(PID_FILE)) {
    const old = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (old && old !== process.pid && isProcessAlive(old)) {
      console.log(`[coord-wake-daemon] already running (pid ${old}), exit`);
      hookLog(`coord-wake daemon skip: already running pid=${old}`);
      return false;
    }
  }
  writeFileSync(PID_FILE, String(process.pid), "utf8");
  return true;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { queueOffset: 0 };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { queueOffset: 0 };
  }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
}
