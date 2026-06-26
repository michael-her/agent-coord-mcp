/**
 * TRPG dice parsing + rolling for coord-chat (/d20, /2d6+3, /roll …).
 */

const EXPR_RE = /^(\d*)d(%|\d{1,4})([+-]\d+)?$/i;
const MAX_COUNT = 100;
const MAX_SIDES = 1000;
const STANDARD = [4, 6, 8, 10, 12, 20, 100];

/** @returns {string | null} dice expression like "2d6+3" */
export function parseDiceCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("/")) return null;

  const lower = raw.toLowerCase();
  if (lower === "/d" || lower === "/r") return "1d20";

  let m = raw.match(/^\/(?:roll|r)\s+(.+)$/i);
  if (m) return normalizeExpr(m[1].trim());

  m = raw.match(/^\/d(%|\d*)(?:([+-]\d+))?$/i);
  if (m) {
    const sides = m[1] === "" ? "20" : m[1];
    const mod = m[2] ?? "";
    return normalizeExpr(`d${sides}${mod}`);
  }

  m = raw.match(/^\/(\d*)d(%|\d+)([+-]\d+)?$/i);
  if (m) return normalizeExpr(`${m[1]}d${m[2]}${m[3] ?? ""}`);

  return null;
}

/**
 * Trailing dice command at end of a normal chat line (not a standalone slash command).
 * @returns {{ narrative: string, expr: string, command: string } | null}
 */
export function parseTrailingDiceCommand(text) {
  const raw = String(text ?? "").trim();
  if (!raw || raw.startsWith("/")) return null;

  const patterns = [
    /^(.+?)\s+(\/d(?:%|\d*)(?:[+-]\d+)?)\s*$/i,
    /^(.+?)\s+(\/\d*d(?:%|\d+)(?:[+-]\d+)?)\s*$/i,
    /^(.+?)\s+(\/(?:roll|r)\s+\S+)\s*$/i,
  ];

  for (const re of patterns) {
    const m = raw.match(re);
    if (!m) continue;
    const narrative = m[1].trim();
    const command = m[2].trim();
    if (!narrative) continue;
    const expr = parseDiceCommand(command);
    if (expr) return { narrative, expr, command };
  }
  return null;
}

/** Narrative + dice result in one room message (single hook wake). */
export function formatCombinedDiceMessage(rollerId, narrative, result) {
  const dice = formatDiceLine(rollerId, result);
  const line = String(narrative ?? "").trim();
  return line ? `${line}\n${dice}` : dice;
}

function normalizeExpr(expr) {
  const cleaned = String(expr ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^(\d*)d%$/i, (_, n) => `${n || 1}d100`)
    .replace(/^d%/i, "1d100")
    .replace(/^d(\d+)/i, "1d$1");
  if (!EXPR_RE.test(cleaned)) return null;
  return cleaned.toLowerCase();
}

/**
 * @param {string} expr
 * @returns {{ expr: string, count: number, sides: number, modifier: number, rolls: number[], total: number }}
 */
export function rollDiceExpr(expr) {
  const normalized = normalizeExpr(expr);
  if (!normalized) throw new Error(`invalid dice: ${expr}`);

  const m = normalized.match(EXPR_RE);
  const count = m[1] === "" ? 1 : parseInt(m[1], 10);
  const sides = m[2] === "%" ? 100 : parseInt(m[2], 10);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;

  if (!Number.isFinite(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`dice count must be 1–${MAX_COUNT}`);
  }
  if (!Number.isFinite(sides) || sides < 2 || sides > MAX_SIDES) {
    throw new Error(`sides must be 2–${MAX_SIDES}`);
  }

  const rolls = [];
  for (let i = 0; i < count; i++) rolls.push(rollDie(sides));
  const sum = rolls.reduce((a, b) => a + b, 0);
  return {
    expr: formatExpr(count, sides, modifier),
    count,
    sides,
    modifier,
    rolls,
    total: sum + modifier,
  };
}

function rollDie(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

function formatExpr(count, sides, modifier) {
  const base = `${count}d${sides === 100 ? "%" : sides}`;
  if (!modifier) return base;
  return modifier > 0 ? `${base}+${modifier}` : `${base}${modifier}`;
}

/** Human-readable one-liner for room.jsonl (leading @all> wakes every agent). */
export function formatDiceLine(rollerId, result) {
  return formatDiceDetail(rollerId, result, { broadcast: true });
}

/** Agent inline roll — no @all> (does not broadcast-wake; use narrative @mention instead). */
export function formatAgentDiceLine(rollerId, result) {
  return formatDiceDetail(rollerId, result, { broadcast: false });
}

function formatDiceDetail(rollerId, result, { broadcast }) {
  const { expr, rolls, modifier, total } = result;
  const parts = rolls.map(String);
  let detail;
  if (rolls.length === 1 && modifier === 0) {
    detail = parts[0];
  } else if (modifier === 0) {
    detail = `${parts.join(" + ")} = ${total}`;
  } else {
    const modStr = modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`;
    detail = `${parts.join(" + ")}${modStr} = ${total}`;
  }
  return broadcast
    ? `@all> 🎲 ${rollerId} · ${expr} · ${detail}`
    : `🎲 ${rollerId} · ${expr} · ${detail}`;
}

export function standardDiceList() {
  return [...STANDARD];
}

export function isDiceHelpCommand(text) {
  return /^\/dice(?:\s+help)?$/i.test(String(text ?? "").trim());
}
