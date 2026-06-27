#!/usr/bin/env node
// Background listener: new agent-coord messages → log + coord-wake.
// Usage: node .cursor/hooks/coord-listener.mjs

import "./coord-spawn-hide.mjs";

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  watch,
  statSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { shouldWakeForCoordMessage } from "./coord-mention-lib.mjs";
import { isAgentBusy } from "./coord-busy-lib.mjs";
import { isProcessAlive, queueBatch } from "./coord-wake-lib.mjs";
import {
  advanceAgentCursorForWake,
  dedupeWakeItems,
} from "./coord-wake-claim-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ID = process.env.AGENT_COORD_ID || "rico";
const ROOT =
  process.env.AGENT_COORD_DIR ||
  process.env.CLAUDE_COORD_DIR ||
  path.join(homedir(), "agent-coord");
const LOG = path.join(__dirname, "coord-hooks.log");

function hookLog(line) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}
const STATE_FILE = path.join(__dirname, `coord-listener-state-${AGENT_ID}.json`);
const PID_FILE = path.join(__dirname, `coord-listener-${AGENT_ID}.pid`);
const WAKE_SCRIPT = path.join(__dirname, "coord-wake.mjs");
const AUTO_REPLY_SCRIPT = path.join(__dirname, "coord-auto-reply.mjs");
const POLL_MS = parseInt(process.env.AGENT_COORD_LISTEN_POLL_MS || "500", 10);
const WAKE_ENABLED = process.env.COORD_WAKE !== "0";
const AUTO_REPLY_ENABLED = process.env.COORD_AUTO_REPLY === "1";
const WAKE_DEBOUNCE_MS = parseInt(process.env.COORD_WAKE_DEBOUNCE_MS || "300", 10);
const WAKE_USE_DAEMON = process.env.COORD_WAKE_DAEMON !== "0";
const WAKE_TIMEOUT_MS = parseInt(process.env.COORD_WAKE_TIMEOUT_MS || "180000", 10);

let wakeBatch = [];
let wakeTimer = null;
let wakeInFlight = false;
let wakeChild = null;
let wakeTimeout = null;
let scanChain = Promise.resolve();

const INBOX = path.join(ROOT, "inbox", `${sanitize(AGENT_ID)}.jsonl`);
const ROOM_GENERAL = path.join(ROOT, "room.jsonl");
const ROOMS_DIR = path.join(ROOT, "rooms");

function sanitize(id) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { files: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { files: {} };
  }
}

function saveState(state) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

import { readdirSync } from "node:fs";

function listWatchedFiles() {
  const files = [ROOM_GENERAL, INBOX];
  if (existsSync(ROOMS_DIR)) {
    try {
      for (const name of readdirSync(ROOMS_DIR)) {
        if (name.endsWith(".jsonl")) files.push(path.join(ROOMS_DIR, name));
      }
    } catch {
      /* ignore */
    }
  }
  return [...new Set(files)];
}

function channelLabel(filePath) {
  if (filePath === INBOX) return "DM";
  if (filePath === ROOM_GENERAL) return "#general";
  const base = path.basename(filePath, ".jsonl");
  return `#${base}`;
}

function drainNewLines(filePath, state) {
  if (!existsSync(filePath)) return [];
  const size = statSync(filePath).size;
  const key = filePath;
  const offset = state.files[key] ?? 0;
  if (size < offset) state.files[key] = 0; // truncated / rotated
  const start = state.files[key] ?? 0;
  if (size <= start) return [];

  const buf = readFileSync(filePath);
  const chunk = buf.subarray(start, size);
  state.files[key] = size;

  const text = chunk.toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  const messages = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return messages;
}

function shouldNotify(msg, filePath) {
  if (!msg || msg.control) return false;
  const from = msg.from;
  if (!from || from === AGENT_ID) return false;
  // system notices (join/quit) — still notify but shorter
  if (filePath === INBOX) return true;
  if (msg.room || msg.text != null) return true;
  return false;
}

function shouldWake(msg, filePath) {
  const room =
    filePath === INBOX
      ? "general"
      : normalizeRoom(msg.room ?? channelLabel(filePath).replace(/^#/, ""));
  return shouldWakeForCoordMessage(msg, AGENT_ID, { isDm: filePath === INBOX, room });
}

function preview(text, max = 180) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function spawnAutoReply(msg, chanLabel) {
  if (!AUTO_REPLY_ENABLED) return;
  const chan = chanLabel === "DM" ? "DM" : normalizeRoom(chanLabel.replace(/^#/, ""));
  const child = spawn(process.execPath, [AUTO_REPLY_SCRIPT, JSON.stringify(msg), chan], {
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", (err) => {
    console.error("[coord-listener] auto-reply failed:", err.message);
  });
}

function scheduleWake(msg, chanLabel) {
  if (!WAKE_ENABLED) return;
  const chan = chanLabel === "DM" ? "DM" : `#${normalizeRoom(chanLabel.replace(/^#/, ""))}`;
  wakeBatch.push({
    id: msg.id,
    ts: msg.ts,
    from: msg.from,
    chan,
    room: msg.room,
    text: String(msg.text ?? ""),
    wakeAll: msg.wakeAll === true,
    dice: msg.dice === true,
    contextLimit: msg.contextLimit,
  });
  requestWakeFlush();
}

function requestWakeFlush() {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(flushWakeBatch, WAKE_DEBOUNCE_MS);
}

function resetWakeFlight(reason) {
  if (wakeTimeout) {
    clearTimeout(wakeTimeout);
    wakeTimeout = null;
  }
  wakeChild = null;
  wakeInFlight = false;
  if (reason) hookLog(`coord-wake reset: ${reason}`);
  if (wakeBatch.length > 0) scheduleWakeFromBatch();
}

function flushWakeBatch() {
  wakeTimer = null;
  try {
    if (wakeBatch.length === 0 || wakeInFlight) return;
    if (isAgentBusy(AGENT_ID)) {
      hookLog(`coord-wake defer: agent busy (${wakeBatch.length} pending)`);
      wakeTimer = setTimeout(flushWakeBatch, 500);
      return;
    }
    const batch = dedupeWakeItems(wakeBatch.splice(0));
    if (batch.length === 0) {
      wakeInFlight = false;
      return;
    }
    advanceAgentCursorForWake(AGENT_ID, batch);
    wakeInFlight = true;

    if (WAKE_USE_DAEMON) {
      try {
        queueBatch(batch);
        hookLog(`coord-wake queued (${batch.length} msg)`);
        wakeInFlight = false;
        if (wakeBatch.length > 0) scheduleWakeFromBatch();
        return;
      } catch (err) {
        hookLog(`coord-wake queue error: ${err.message}`);
      }
    }

    hookLog(`coord-wake schedule (${batch.length} msg)`);
    const batchFile = path.join(__dirname, `.wake-batch-${Date.now()}.json`);
    try {
      writeFileSync(batchFile, JSON.stringify(batch), "utf8");
    } catch (err) {
      resetWakeFlight(`batch write error: ${err.message}`);
      return;
    }
    let child;
    try {
      child = spawn(process.execPath, [WAKE_SCRIPT, batchFile], {
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          CURSOR_PROJECT_DIR: process.env.CURSOR_PROJECT_DIR || path.resolve(__dirname, "..", ".."),
        },
        cwd: __dirname,
      });
    } catch (err) {
      try {
        unlinkSync(batchFile);
      } catch {
        /* ignore */
      }
      resetWakeFlight(`spawn error: ${err.message}`);
      console.error("[coord-listener] wake failed:", err.message);
      return;
    }
    wakeChild = child;
    wakeTimeout = setTimeout(() => {
      try {
        wakeChild?.kill();
      } catch {
        /* ignore */
      }
      resetWakeFlight("timeout");
    }, WAKE_TIMEOUT_MS);
    child.on("exit", (code) => {
      try {
        unlinkSync(batchFile);
      } catch {
        /* ignore */
      }
      if (wakeTimeout) {
        clearTimeout(wakeTimeout);
        wakeTimeout = null;
      }
      wakeChild = null;
      wakeInFlight = false;
      if (code !== 0) hookLog(`coord-wake exit code=${code ?? "?"}`);
      if (wakeBatch.length > 0) scheduleWakeFromBatch();
    });
    child.on("error", (err) => {
      try {
        unlinkSync(batchFile);
      } catch {
        /* ignore */
      }
      resetWakeFlight(`child error: ${err.message}`);
      console.error("[coord-listener] wake failed:", err.message);
    });
  } catch (err) {
    resetWakeFlight(`flush error: ${err?.message ?? err}`);
    console.error("[coord-listener] wake flush error:", err?.message ?? err);
  }
}

function scheduleWakeFromBatch() {
  if (wakeBatch.length === 0) return;
  requestWakeFlush();
}

function normalizeRoom(name) {
  const n = String(name).trim().replace(/^#+/, "").toLowerCase();
  return n || "general";
}

function scanOnce(state) {
  let changed = false;
  for (const file of listWatchedFiles()) {
    const before = state.files[file];
    const msgs = drainNewLines(file, state);
    if (state.files[file] !== before) changed = true;
    for (const msg of msgs) {
      if (!shouldNotify(msg, file)) continue;
      const chan = channelLabel(file);
      const from = msg.from ?? "?";
      const text = preview(msg.text ?? "(system)");
      console.log(`[coord-listener] ${chan} from=${from}: ${text}`);
      hookLog(`coord-chat ${chan} from=${from}: ${preview(msg.text ?? "(system)", 120)}`);
      if (shouldWake(msg, file)) {
        scheduleWake(msg, chan);
      } else {
        hookLog(`coord-wake skip: no @${AGENT_ID}/@all in ${chan} from=${from}`);
      }
      spawnAutoReply(msg, chan);
    }
  }
  if (changed) saveState(state);
  if (wakeBatch.length > 0 && !wakeInFlight && !isAgentBusy(AGENT_ID)) {
    requestWakeFlush();
  }
}

function claimListenerPid() {
  if (existsSync(PID_FILE)) {
    const old = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    if (old && old !== process.pid && isProcessAlive(old)) {
      console.log(`[coord-listener] already running (pid ${old}), exit`);
      hookLog(`coord-listener skip: already running pid=${old}`);
      return false;
    }
  }
  writeFileSync(PID_FILE, String(process.pid), "utf8");
  return true;
}

function main() {
  if (!claimListenerPid()) {
    process.exit(0);
    return;
  }

  process.on("exit", () => {
    try {
      if (existsSync(PID_FILE) && readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    } catch {
      /* ignore */
    }
  });

  process.on("uncaughtException", (err) => {
    console.error("[coord-listener] uncaught:", err?.message ?? err);
    hookLog(`coord-listener uncaught: ${err?.message ?? err}`);
  });
  process.on("unhandledRejection", (err) => {
    console.error("[coord-listener] unhandled rejection:", err?.message ?? err);
    hookLog(`coord-listener unhandled: ${err?.message ?? err}`);
  });

  console.log(`[coord-listener] watching agent-coord for "${AGENT_ID}"`);
  console.log(`[coord-listener] dir: ${ROOT}`);
  console.log(
    `[coord-listener] wake=${WAKE_ENABLED ? "on" : "off"} daemon=${WAKE_USE_DAEMON ? "on" : "off"} ` +
      `auto-reply=${AUTO_REPLY_ENABLED ? "on" : "off"} mention-only=on`,
  );
  console.log(`[coord-listener] Ctrl+C to stop`);

  const state = loadState();
  const firstRun = !existsSync(STATE_FILE);
  if (firstRun) {
    // First start: skip backlog, only handle messages after listener comes up.
    for (const file of listWatchedFiles()) {
      if (existsSync(file)) state.files[file] = statSync(file).size;
    }
    saveState(state);
  }

  const run = () => {
    scanChain = scanChain
      .then(() => scanOnce(state))
      .catch((err) => {
        console.error("[coord-listener] scan error:", err.message);
      });
  };

  run();
  const poll = setInterval(run, POLL_MS);

  const watchers = [];
  const attachWatch = (target) => {
    if (!existsSync(target)) return;
    try {
      const w = watch(target, { persistent: true }, () => run());
      w.on("error", (err) => {
        hookLog(`coord-listener watch error (${target}): ${err?.message ?? err}`);
      });
      watchers.push(w);
    } catch {
      /* ignore */
    }
  };

  attachWatch(ROOM_GENERAL);
  attachWatch(INBOX);
  if (existsSync(ROOMS_DIR)) {
    try {
      const w = watch(ROOMS_DIR, { persistent: true }, () => {
        for (const f of listWatchedFiles()) attachWatch(f);
        run();
      });
      w.on("error", (err) => {
        hookLog(`coord-listener watch error (${ROOMS_DIR}): ${err?.message ?? err}`);
      });
      watchers.push(w);
      for (const f of listWatchedFiles()) attachWatch(f);
    } catch {
      /* ignore */
    }
  }

  process.on("SIGINT", () => {
    clearInterval(poll);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    console.log("\n[coord-listener] stopped");
    process.exit(0);
  });
}

try {
  main();
} catch (err) {
  console.error("[coord-listener] startup failed:", err?.message ?? err);
  hookLog(`coord-listener startup failed: ${err?.message ?? err}`);
  process.exit(1);
}
