import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const HOOKS_LOGS_DIR = path.join(HOOKS_DIR, "logs");

/** Ephemeral wake/listener artifacts under `.cursor/hooks/` and `logs/`. */
export const WAKE_TEMP_PATTERNS = [
  /^coord-listener-state(-.*)?\.json$/,
  /^coord-wake-daemon-state(-.*)?\.json$/,
  /^coord-wake-claimed-.*\.json$/,
  /^coord-wake-busy-.*\.json$/,
  /^coord-wake-agent-id(-.*)?\.txt$/,
  /^\.wake-queue(-.*)?\.jsonl$/,
  /^\.wake-batch-.*\.json$/,
  /^coord-wake-.*\.lock$/,
  /^_test-batch\.json$/,
];

export function hooksLogPath(...parts) {
  mkdirSync(HOOKS_LOGS_DIR, { recursive: true });
  return path.join(HOOKS_LOGS_DIR, ...parts);
}

function isWakeTempName(name) {
  return WAKE_TEMP_PATTERNS.some((re) => re.test(name));
}

/** List ephemeral wake/listener files in hooks root and `logs/`. */
export function listWakeTempFiles({ hooksDir = HOOKS_DIR } = {}) {
  const dirs = [hooksDir, path.join(hooksDir, "logs")];
  const found = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (isWakeTempName(name)) found.push(path.join(dir, name));
    }
  }
  return found.sort();
}

/** Delete ephemeral wake/listener files. Returns { removed, failed, dryRun }. */
export function cleanWakeTempFiles({ hooksDir = HOOKS_DIR, dryRun = false } = {}) {
  const files = listWakeTempFiles({ hooksDir });
  const removed = [];
  const failed = [];
  for (const file of files) {
    if (dryRun) {
      removed.push(file);
      continue;
    }
    try {
      unlinkSync(file);
      removed.push(file);
    } catch (err) {
      failed.push({ file, error: err?.message ?? String(err) });
    }
  }
  return { removed, failed, dryRun };
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
