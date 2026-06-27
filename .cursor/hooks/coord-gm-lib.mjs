import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_ROOM = "general";

function coordDir() {
  return (
    process.env.AGENT_COORD_DIR ||
    process.env.CLAUDE_COORD_DIR ||
    path.join(homedir(), "agent-coord")
  );
}

function gmFile() {
  return path.join(coordDir(), "trpg-gm.json");
}

function agentsFile() {
  return path.join(coordDir(), "agents.json");
}

export const GM_CONTEXT_DEFAULT = 5;
export const GM_INSTRUCTIONS =
  "You are the TRPG Game Master (GM) for this coord-chat session. " +
  "Narrate vividly: scene, atmosphere, sensory detail, NPC voices, stakes, and consequences. " +
  "Write immersive in-character prose — not bullet summaries. " +
  "Do NOT artificially shorten replies; match length to the moment (exploration, dialogue, combat). " +
  "Avoid meta talk about being an AI or following instructions.";

export function loadGmState() {
  const file = gmFile();
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const agentId = String(s.agentId ?? "").trim().toLowerCase();
    if (!agentId) return null;
    return {
      agentId,
      room: normalizeRoom(s.room),
      setBy: s.setBy ?? null,
      setAt: s.setAt ?? null,
    };
  } catch {
    return null;
  }
}

export function setGmAgent(agentId, { setBy, room = "general" } = {}) {
  const id = String(agentId ?? "").trim().toLowerCase();
  if (!id) throw new Error("agent id required");
  const state = {
    agentId: id,
    room: normalizeRoom(room),
    setBy: setBy ?? null,
    setAt: Date.now(),
  };
  mkdirSync(path.dirname(gmFile()), { recursive: true });
  writeFileSync(gmFile(), JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function clearGmAgent() {
  try {
    const file = gmFile();
    if (existsSync(file)) writeFileSync(file, "{}\n", "utf8");
  } catch {
    /* ignore */
  }
}

export function getGmAgent(room = "general") {
  const s = loadGmState();
  if (!s) return null;
  if (normalizeRoom(room) !== s.room) return null;
  return s.agentId;
}

export function isGmAgent(agentId, room = "general") {
  const id = String(agentId ?? "").trim().toLowerCase();
  if (!id) return false;
  return getGmAgent(room) === id;
}

export function gmWakeReplyTail(agentId) {
  if (!isGmAgent(agentId)) {
    return "Keep it short. Do NOT call read_messages.";
  }
  return (
    `${GM_INSTRUCTIONS} ` +
    `Do NOT call read_messages. Do NOT artificially shorten replies.`
  );
}

export function saveInvWakeAddendum(agentId, batch) {
  if (!isGmAgent(agentId)) return "";
  if (!Array.isArray(batch) || !batch.some((m) => /\[saveinv\]/i.test(m.text ?? ""))) return "";
  return (
    "This is a /saveinv request: compare recent chat to current inventories, then call " +
    "get_agent_inventories and batch_set_agent_inventories to persist updates for every " +
    "participant whose inventory changed. Reply with a summary of what you saved. "
  );
}

export function conWakeAddendum(agentId, batch) {
  if (!isGmAgent(agentId)) return "";
  if (!Array.isArray(batch) || !batch.some((m) => /\[con\]/i.test(m.text ?? ""))) return "";
  return (
    "This is a /con request: continue the TRPG story — narrate the next scene beat from where chat left off. "
  );
}

function roomJsonlPath(room) {
  const c = normalizeRoom(room);
  const root = coordDir();
  return c === DEFAULT_ROOM
    ? path.join(root, "room.jsonl")
    : path.join(root, "rooms", `${c}.jsonl`);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function isGmSlashRequestMessage(msg) {
  if (!msg?.text) return false;
  const header = String(msg.text).split(/\n\s*Recent #/i)[0];
  return /^\s*@[A-Za-z0-9._-]+\s+\[(?:con|saveinv)\]/i.test(header.trim());
}

export function readRecentRoomMessages(room, limit, { excludeIds = [] } = {}) {
  const skip = new Set(excludeIds.filter(Boolean));
  const n = Math.max(1, parseInt(String(limit ?? ""), 10) || GM_CONTEXT_DEFAULT);
  return readJsonl(roomJsonlPath(room))
    .filter(
      (m) =>
        !m.system &&
        !m.control &&
        !skip.has(m.id) &&
        !isGmSlashRequestMessage(m),
    )
    .slice(-n);
}

export function loadAgentInventories() {
  const file = agentsFile();
  if (!existsSync(file)) return {};
  try {
    const reg = JSON.parse(readFileSync(file, "utf8"));
    const out = {};
    for (const [id, entry] of Object.entries(reg)) {
      out[id] = entry?.inventory ?? [];
    }
    return out;
  } catch {
    return {};
  }
}

/** Server-side context for /con and /saveinv (not posted to the room). */
export function buildGmSlashContext(agentId, batch) {
  if (!isGmAgent(agentId) || !Array.isArray(batch) || batch.length === 0) return "";

  const conMsg = batch.find((m) => /\[con\]/i.test(m.text ?? ""));
  const saveMsg = batch.find((m) => /\[saveinv\]/i.test(m.text ?? ""));
  if (!conMsg && !saveMsg) return "";

  const anchor = conMsg ?? saveMsg;
  const room = normalizeRoom(anchor.room ?? anchor.chan?.replace(/^#/, "") ?? "general");
  const limit = anchor.contextLimit ?? GM_CONTEXT_DEFAULT;
  const excludeIds = batch.map((m) => m.id);
  const recent = readRecentRoomMessages(room, limit, { excludeIds });
  const historyLines = recent.map((m) => `${m.from}: ${m.text}`).join("\n") || "(none)";

  const parts = [];
  if (saveMsg) {
    parts.push(`Current inventories:\n${JSON.stringify(loadAgentInventories(), null, 2)}`);
  }
  parts.push(`Recent #${room} messages (last ${recent.length}):\n${historyLines}`);
  return parts.join("\n\n");
}

export function gmSessionContextAddendum(agentId) {
  if (!isGmAgent(agentId)) return "";
  return ` TRPG GM role active: ${GM_INSTRUCTIONS}`;
}

function normalizeRoom(name) {
  const n = String(name ?? "general")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();
  return n || "general";
}
