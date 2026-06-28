import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { isProcessAlive } from "./coord-wake-lib.mjs";
import { hooksLogPath } from "./coord-wake-logs-lib.mjs";
const BUSY_MAX_MS = parseInt(process.env.COORD_WAKE_BUSY_MAX_MS || "", 10) || 10 * 60 * 1000;

export function busyFile(agentId) {
  return hooksLogPath(`coord-wake-busy-${agentId}.json`);
}

export function setAgentBusy(agentId, meta = {}) {
  writeFileSync(
    busyFile(agentId),
    JSON.stringify({ since: Date.now(), pid: process.pid, ...meta }, null, 2),
    "utf8",
  );
}

export function clearAgentBusy(agentId) {
  try {
    if (existsSync(busyFile(agentId))) unlinkSync(busyFile(agentId));
  } catch {
    /* ignore */
  }
}

/** Clear busy after a failed wake; optional reason is stored only for logging by caller. */
export function releaseAgentBusy(agentId, reason) {
  clearAgentBusy(agentId);
  return reason;
}

/** True while a wake/hook run is in progress for this agent (until response completes). */
export function isAgentBusy(agentId) {
  const file = busyFile(agentId);
  if (!existsSync(file)) return false;
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const age = Date.now() - (s.since ?? 0);
    if (age > BUSY_MAX_MS) {
      clearAgentBusy(agentId);
      return false;
    }
    if (s.pid && !isProcessAlive(s.pid)) {
      clearAgentBusy(agentId);
      return false;
    }
    return true;
  } catch {
    clearAgentBusy(agentId);
    return false;
  }
}
