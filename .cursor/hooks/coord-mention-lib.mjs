/** @mention detection for coord wake / hook followup (@rico, @gemini, @all, …). */

import { getGmAgent, isGmSlashRequestMessage } from "./coord-gm-lib.mjs";

/** Chars that continue an agent id (not sentence punctuation). Hyphen kept so @rico ≠ @rico-backend. */
const MENTION_ID_CONTINUATION = /[A-Za-z0-9_-]/;

/** Agent inline / copied dice line (not human wakeAll posts from coord-chat). */
const AGENT_DICE_RE =
  /(?:^|\n)@all>\s*🎲\s+\S+\s*·|\s*🎲\s+[A-Za-z0-9._-]+\s*·\s*[^\n]+/;

export function escapeAgentIdForRegex(id) {
  return String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionTail() {
  return `(?!${MENTION_ID_CONTINUATION.source})`;
}

/** True when text contains @agentId or @all (word boundary after name). */
export function mentionsAgent(text, agentId) {
  const t = String(text ?? "");
  if (!t || !agentId) return false;
  const id = escapeAgentIdForRegex(agentId);
  const tail = mentionTail();
  const selfRe = new RegExp(`@${id}${tail}`, "i");
  const allRe = new RegExp(`@all${tail}`, "i");
  return selfRe.test(t) || allRe.test(t);
}

/**
 * Strip dice suffixes before wake @mention scan.
 * Human dice uses wakeAll on the message; @all> in text must not wake agents who copy that format.
 */
export function wakeMentionText(text) {
  let t = String(text ?? "");
  t = t.replace(/\n?@all>\s*🎲[^\n]*/gi, "");
  t = t.replace(/\s*🎲\s+[A-Za-z0-9._-]+\s*·\s*[^\n]+/gi, "");
  return t.trim();
}

/** True when text contains an agent-style dice line (🎲 id · … or copied @all> 🎲 …). */
export function hasAgentDiceText(text) {
  return AGENT_DICE_RE.test(String(text ?? ""));
}

/** Agent dice in room chat — not human coord-chat dice (wakeAll / dice flag). */
export function isAgentDiceMessage(msg) {
  if (msg?.wakeAll || msg?.dice) return false;
  return hasAgentDiceText(msg?.text);
}

function normalizeRoom(name) {
  const n = String(name ?? "general")
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();
  return n || "general";
}

/**
 * GM-only slash requests (/con, /saveinv) embed recent chat for context.
 * @mentions inside that history must not wake other agents.
 */
export function isGmSlashRequest(msg) {
  return isGmSlashRequestMessage(msg);
}

/**
 * Whether this coord message should wake / follow up the given agent.
 * Room posts require @agentId or @all in narrative; per-agent inbox (DM) always qualifies.
 * Human dice (wakeAll) wakes every listener. Agent dice auto-wakes the TRPG GM only.
 */
export function shouldWakeForCoordMessage(msg, agentId, { isDm = false, room = "general" } = {}) {
  if (!msg || msg.control) return false;
  const from = msg.from;
  if (!from || from === agentId) return false;
  if (msg.wakeAll) return msg.text != null;
  if (isDm) return msg.text != null;
  if (msg.text == null) return false;

  if (isGmSlashRequest(msg)) {
    const gm = getGmAgent(normalizeRoom(room));
    return Boolean(gm && agentId === gm);
  }

  if (isAgentDiceMessage(msg)) {
    const gm = getGmAgent(normalizeRoom(room));
    if (gm && agentId === gm) return true;
  }

  return mentionsAgent(wakeMentionText(msg.text), agentId);
}
