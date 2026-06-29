/** PID files + process cleanup for coord listener / wake-daemon stacks. */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { hiddenChildProcessOptions } from "./coord-spawn-hide.mjs";

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function sleepMs(ms) {
  if (!ms || ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin — invite path is sync; avoid timers */
  }
}

/** Kill process tree and wait for taskkill to finish (Windows). */
export function killPidTreeSync(pid) {
  const n = parseInt(String(pid ?? ""), 10);
  if (!n || n === process.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync(
        "taskkill",
        ["/PID", String(n), "/T", "/F"],
        hiddenChildProcessOptions({ stdio: "ignore" }),
      );
      return;
    }
    process.kill(n, "SIGTERM");
  } catch {
    /* ignore */
  }
}

export function hookManifestPath(hooksDir, agentId) {
  const id = String(agentId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
  return path.join(hooksDir, `coord-hook-manifest-${id}.json`);
}

export function writeHookManifest(hooksDir, agentId, extra = {}) {
  const file = hookManifestPath(hooksDir, agentId);
  writeFileSync(
    file,
    JSON.stringify(
      {
        agentId: String(agentId ?? "").trim().toLowerCase(),
        pid: process.pid,
        ts: Date.now(),
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
}

export function clearHookManifest(hooksDir, agentId) {
  const file = hookManifestPath(hooksDir, agentId);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export function readHookManifestPids(hooksDir, agentId) {
  const file = hookManifestPath(hooksDir, agentId);
  if (!existsSync(file)) return [];
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return [j.pid, j.listenerPid, j.daemonPid].filter(Boolean);
  } catch {
    return [];
  }
}

/** PIDs from coord-listener / wake-daemon / stack PID files under hooksDir. */
export function readHookPidFilePids(hooksDir) {
  const pids = new Set();
  if (!existsSync(hooksDir)) return [];
  for (const name of readdirSync(hooksDir)) {
    if (!/^coord-(?:listener|wake-daemon)-.+\.pid$/.test(name)) continue;
    try {
      const pid = parseInt(readFileSync(path.join(hooksDir, name), "utf8").trim(), 10);
      if (pid) pids.add(pid);
    } catch {
      /* ignore */
    }
  }
  return [...pids];
}

/** Best-effort scan for orphan hook node processes (Windows). */
export function discoverRunningHookPids() {
  const pids = new Set();
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
          "Where-Object { $_.CommandLine -match 'coord-listener\\.mjs|coord-wake-daemon\\.mjs|coord-agent-stack\\.mjs' } | " +
          "Select-Object -ExpandProperty ProcessId",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const line of (r.stdout ?? "").split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid) pids.add(pid);
    }
  } catch {
    /* ignore */
  }
  return [...pids];
}

/**
 * Claim a hook PID file. When COORD_CHAT_MANAGED=1, replace a live stale holder.
 * Returns false only for unmanaged duplicate instances.
 */
export function claimManagedHookPid(pidFile, { log } = {}) {
  let old = 0;
  if (existsSync(pidFile)) {
    try {
      old = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
      /* ignore */
    }
  }

  if (old && old !== process.pid && isProcessAlive(old)) {
    if (process.env.COORD_CHAT_MANAGED === "1") {
      log?.(`coord hook preempt pid=${old} → ${process.pid}`);
      killPidTreeSync(old);
      sleepMs(250);
    } else {
      log?.(`coord hook skip: already running pid=${old}`);
      return false;
    }
  }

  writeFileSync(pidFile, String(process.pid), "utf8");
  return true;
}
