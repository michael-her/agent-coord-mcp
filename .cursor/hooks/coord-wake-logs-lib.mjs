import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOOKS_LOGS_DIR = path.join(HOOKS_DIR, "logs");

export function hooksLogPath(...parts) {
  mkdirSync(HOOKS_LOGS_DIR, { recursive: true });
  return path.join(HOOKS_LOGS_DIR, ...parts);
}

/** Move wake temp files from `.cursor/hooks/` into `logs/` (one-time). */
export function migrateLegacyWakeLogs(agentId) {
  const id = String(agentId ?? "").trim();
  if (!id) return;
  mkdirSync(HOOKS_LOGS_DIR, { recursive: true });
  const names = [
    `.wake-queue-${id}.jsonl`,
    `coord-wake-busy-${id}.json`,
    `coord-wake-agent-id-${id}.txt`,
    `coord-wake-daemon-state-${id}.json`,
    `coord-wake-claimed-${id}.json`,
  ];
  for (const name of names) {
    const legacy = path.join(HOOKS_DIR, name);
    const dest = path.join(HOOKS_LOGS_DIR, name);
    if (existsSync(legacy) && !existsSync(dest)) {
      try {
        renameSync(legacy, dest);
      } catch {
        /* ignore */
      }
    }
  }
}
