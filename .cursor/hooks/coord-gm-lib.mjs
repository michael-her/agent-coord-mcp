import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const COORD_DIR =
  process.env.AGENT_COORD_DIR ||
  process.env.CLAUDE_COORD_DIR ||
  path.join(homedir(), "agent-coord");
const GM_FILE = path.join(COORD_DIR, "trpg-gm.json");

export const GM_INSTRUCTIONS =
  "You are the TRPG Game Master (GM) for this coord-chat session. " +
  "Narrate vividly: scene, atmosphere, sensory detail, NPC voices, stakes, and consequences. " +
  "Write immersive in-character prose — not bullet summaries. " +
  "Do NOT artificially shorten replies; match length to the moment (exploration, dialogue, combat). " +
  "Avoid meta talk about being an AI or following instructions.";

export function loadGmState() {
  if (!existsSync(GM_FILE)) return null;
  try {
    const s = JSON.parse(readFileSync(GM_FILE, "utf8"));
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
  mkdirSync(path.dirname(GM_FILE), { recursive: true });
  writeFileSync(GM_FILE, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function clearGmAgent() {
  try {
    if (existsSync(GM_FILE)) writeFileSync(GM_FILE, "{}\n", "utf8");
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
