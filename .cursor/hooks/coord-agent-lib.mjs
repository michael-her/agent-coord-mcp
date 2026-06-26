import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gmSessionContextAddendum } from "./coord-gm-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_MAP = path.join(__dirname, "coord-session-agents.json");
const COORD_DIR =
  process.env.AGENT_COORD_DIR ||
  process.env.CLAUDE_COORD_DIR ||
  path.join(homedir(), "agent-coord");
const AGENT_MODELS_FILE = path.join(COORD_DIR, "agent-models.json");

export function agentIdFromModel(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("gemini")) return "gemini";
  return "rico";
}

export function mcpServerName(agentId) {
  return agentId === "rico" ? "agent-coord" : `agent-coord-${agentId}`;
}

export function loadSessionMap() {
  if (!existsSync(SESSION_MAP)) return {};
  try {
    return JSON.parse(readFileSync(SESSION_MAP, "utf8"));
  } catch {
    return {};
  }
}

export function saveSessionAgent(conversationId, agentId) {
  if (!conversationId || !agentId) return;
  const map = loadSessionMap();
  map[conversationId] = agentId;
  mkdirSync(path.dirname(SESSION_MAP), { recursive: true });
  writeFileSync(SESSION_MAP, JSON.stringify(map, null, 2), "utf8");
}

export function loadAgentModels() {
  if (!existsSync(AGENT_MODELS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(AGENT_MODELS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function saveAgentModel(agentId, model) {
  const id = String(agentId ?? "").trim();
  const name = String(model ?? "").trim();
  if (!id || !name) return;
  const map = loadAgentModels();
  map[id] = name;
  mkdirSync(path.dirname(AGENT_MODELS_FILE), { recursive: true });
  writeFileSync(AGENT_MODELS_FILE, JSON.stringify(map, null, 2), "utf8");
}

export function resolveSessionAgent(input) {
  const fromEnv = process.env.AGENT_COORD_ID?.trim();
  if (fromEnv) return fromEnv;
  const cid = input?.conversation_id;
  if (cid) {
    const mapped = loadSessionMap()[cid];
    if (mapped) return mapped;
  }
  return agentIdFromModel(input?.model);
}

export function sessionContext(agentId) {
  const mcp = mcpServerName(agentId);
  return (
    `You are agent-coord participant \`${agentId}\` (Cursor). MCP server: \`${mcp}\`. ` +
    `On session start call join({agentId:"${agentId}", project:"llm", role:"cursor", attach:false}). ` +
    `When [agent-coord 자동 푸시] messages appear, reply via ${mcp} send_message on #general ` +
    `(from:"${agentId}") — do NOT call read_messages for hook-delivered messages. ` +
    `Human peer is usually \`sehui\` on coord-chat.` +
    gmSessionContextAddendum(agentId)
  );
}
