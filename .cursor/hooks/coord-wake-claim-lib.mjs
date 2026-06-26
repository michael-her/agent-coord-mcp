import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT =
  process.env.AGENT_COORD_DIR ||
  process.env.CLAUDE_COORD_DIR ||
  path.join(homedir(), "agent-coord");
const CLAIM_MAX_AGE_MS =
  parseInt(process.env.COORD_WAKE_CLAIM_MAX_MS || "", 10) || 24 * 60 * 60 * 1000;

export function wakeMessageKey(msg) {
  if (msg?.id) return String(msg.id);
  const from = msg?.from ?? "?";
  const ts = msg?.ts ?? 0;
  const text = String(msg?.text ?? "").slice(0, 120);
  return `${from}:${ts}:${text}`;
}

function claimFile(agentId) {
  return path.join(__dirname, `coord-wake-claimed-${agentId}.json`);
}

function cursorFile(agentId) {
  return path.join(ROOT, "cursors", `${String(agentId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function loadClaimed(agentId) {
  const file = claimFile(agentId);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveClaimed(agentId, map) {
  mkdirSync(path.dirname(claimFile(agentId)), { recursive: true });
  writeFileSync(claimFile(agentId), JSON.stringify(map, null, 2), "utf8");
}

function pruneClaimed(map) {
  const cutoff = Date.now() - CLAIM_MAX_AGE_MS;
  for (const [k, t] of Object.entries(map)) {
    if (!t || t < cutoff) delete map[k];
  }
}

export function isWakeClaimed(agentId, msg) {
  const key = wakeMessageKey(msg);
  const t = loadClaimed(agentId)[key];
  return Boolean(t && Date.now() - t < CLAIM_MAX_AGE_MS);
}

export function filterUnclaimed(agentId, items) {
  return (items ?? []).filter((m) => m && !isWakeClaimed(agentId, m));
}

export function dedupeWakeItems(items) {
  const seen = new Set();
  const out = [];
  for (const m of items ?? []) {
    if (!m) continue;
    const key = wakeMessageKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Mark messages as handled by wake-daemon / listener so stop-hook won't re-deliver. */
export function claimWakeMessages(agentId, items) {
  if (!items?.length) return;
  const map = loadClaimed(agentId);
  const now = Date.now();
  for (const m of items) map[wakeMessageKey(m)] = now;
  pruneClaimed(map);
  saveClaimed(agentId, map);
}

function normalizeRoom(name) {
  const n = String(name ?? "general")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  return n || "general";
}

/** Advance agent-coord cursor offsets so coord-stop skips hook-delivered messages. */
export function advanceAgentCursorForWake(agentId, items) {
  if (!items?.length) return;
  const file = cursorFile(agentId);
  let cursor = {};
  if (existsSync(file)) {
    try {
      cursor = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      cursor = {};
    }
  }

  const roomCounts = new Map();
  let inboxCount = 0;
  for (const m of items) {
    if (m.chan === "DM") inboxCount++;
    else {
      const room = normalizeRoom(m.room ?? String(m.chan ?? "").replace(/^#/, "") ?? "general");
      roomCounts.set(room, (roomCounts.get(room) ?? 0) + 1);
    }
  }

  if (inboxCount > 0) cursor.inboxOffset = (cursor.inboxOffset ?? 0) + inboxCount;

  for (const [room, n] of roomCounts) {
    if (room === "general") cursor.roomOffset = (cursor.roomOffset ?? 0) + n;
    else {
      cursor.roomOffsets ??= {};
      cursor.roomOffsets[room] = (cursor.roomOffsets[room] ?? 0) + n;
    }
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cursor, null, 2), "utf8");
}
