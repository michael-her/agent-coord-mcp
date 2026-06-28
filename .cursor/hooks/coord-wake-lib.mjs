import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { shouldWakeForCoordMessage } from "./coord-mention-lib.mjs";
import { gmWakeReplyTail, conWakeAddendum, saveInvWakeAddendum, buildGmSlashContext } from "./coord-gm-lib.mjs";
import { dedupeWakeItems } from "./coord-wake-claim-lib.mjs";
import { hooksLogPath } from "./coord-wake-logs-lib.mjs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const HOOKS_LOG = path.join(__dirname, "coord-hooks.log");
export const LOCAL_ENV = path.join(__dirname, "coord-wake.local.env");
export const AGENT_ID = process.env.AGENT_COORD_ID || "rico";
export const QUEUE_FILE = hooksLogPath(`.wake-queue-${AGENT_ID}.jsonl`);
export const PROJECT = process.env.CURSOR_PROJECT_DIR || path.resolve(__dirname, "..", "..");
export const MODEL = process.env.COORD_WAKE_MODEL || "composer-2.5";
export const COORD_DIR =
  process.env.AGENT_COORD_DIR || process.env.CLAUDE_COORD_DIR || path.join(homedir(), "agent-coord");

loadLocalEnv();

export function loadLocalEnv() {
  if (!existsSync(LOCAL_ENV)) return;
  for (const line of readFileSync(LOCAL_ENV, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    const val = trimmed.slice(i + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

export function hookLog(line) {
  try {
    appendFileSync(HOOKS_LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function mcpServers() {
  const serverName = AGENT_ID === "rico" ? "agent-coord" : `agent-coord-${AGENT_ID}`;
  return {
    [serverName]: {
      type: "stdio",
      command: process.execPath,
      args: [path.join(PROJECT, "dist/server.js")],
      env: {
        AGENT_COORD_BOUND_AGENT: AGENT_ID,
        AGENT_COORD_DIR: COORD_DIR,
        AGENT_COORD_MODEL: MODEL,
      },
    },
  };
}

export function buildPrompt(batch) {
  const lines = batch.map((m) => `${m.chan} ${m.from}: ${m.text}`).join("\n");
  const reply = gmWakeReplyTail(AGENT_ID);
  const saveInvTail = saveInvWakeAddendum(AGENT_ID, batch);
  const conTail = conWakeAddendum(AGENT_ID, batch);
  const slashCtx = buildGmSlashContext(AGENT_ID, batch);
  return (
    `coord-chat message(s):\n${lines}\n\n` +
    (slashCtx ? `${slashCtx}\n\n` : "") +
    `${saveInvTail}` +
    `${conTail}` +
    `Reply on the matching channel via agent-coord MCP send_message ` +
    `(from:"${AGENT_ID}", room:"general", text:"..."). Model is stamped automatically. ` +
    `${reply}`
  );
}

export function loadBatch(arg) {
  if (!arg || arg === "[]") return [];
  if (arg.trimStart().startsWith("[")) return JSON.parse(arg);
  if (existsSync(arg)) return JSON.parse(readFileSync(arg, "utf8"));
  return JSON.parse(arg);
}

export function filterBatch(batch) {
  return dedupeWakeItems(
    batch.filter((m) => {
      if (!m?.text || !m.from || m.from === AGENT_ID) return false;
      const isDm = m.chan === "DM";
      const room = isDm ? "general" : String(m.chan ?? "#general").replace(/^#/, "");
      return shouldWakeForCoordMessage(
        {
          from: m.from,
          text: m.text,
          wakeAll: m.wakeAll,
          dice: m.dice,
          control: m.control,
        },
        AGENT_ID,
        { isDm, room },
      );
    }),
  );
}

export function queueBatch(batch) {
  appendFileSync(QUEUE_FILE, `${JSON.stringify(batch)}\n`, "utf8");
}

/** Warm-agent idle before proactive session refresh (default 90 min). */
export const SESSION_IDLE_MS = parseInt(process.env.COORD_WAKE_SESSION_IDLE_MS || "", 10) || 90 * 60 * 1000;

/** Max wait for a single SDK run in wake-daemon (default 3 min, matches listener). */
export const RUN_TIMEOUT_MS =
  parseInt(process.env.COORD_WAKE_RUN_TIMEOUT_MS || "", 10) ||
  parseInt(process.env.COORD_WAKE_TIMEOUT_MS || "", 10) ||
  180_000;

const SESSION_STALE_RE =
  /unauthenticated|unauthorized|not authenticated|invalid session|session expired|token expired|expired session|authentication failed/i;

const RECOVERABLE_WAKE_RE = /active run|aborted|canceled|SQLITE_CONSTRAINT/i;

const WAKE_TIMEOUT_RE = /wake run timeout/i;

export function isSessionStaleError(msg) {
  return SESSION_STALE_RE.test(String(msg ?? ""));
}

export function isRecoverableWakeError(msg) {
  return RECOVERABLE_WAKE_RE.test(String(msg ?? ""));
}

export function isWakeTimeoutError(msg) {
  return WAKE_TIMEOUT_RE.test(String(msg ?? ""));
}

/** Race run.wait() against a deadline; cancel the run on timeout. */
export async function waitForRun(run, timeoutMs = RUN_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`wake run timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([run.wait(), timeout]);
  } catch (err) {
    if (isWakeTimeoutError(err?.message ?? err)) {
      try {
        if (run.supports?.("cancel")) await run.cancel();
      } catch {
        /* ignore */
      }
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
