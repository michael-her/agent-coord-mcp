#!/usr/bin/env node
// Fallback auto-reply when Cursor stop hooks are not firing.
// Called by coord-listener for new #general / DM messages.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ID = process.env.AGENT_COORD_ID || "rico";
const ROOT =
  process.env.AGENT_COORD_DIR ||
  process.env.CLAUDE_COORD_DIR ||
  path.join(homedir(), "agent-coord");
const ROOM_FILE = path.join(ROOT, "room.jsonl");
const STOP_LOG = path.join(HOOKS_DIR, "coord-stop.log");
const HOOKS_LOG = path.join(HOOKS_DIR, "coord-hooks.log");
const HOOKS_RECENT_MS = parseInt(process.env.COORD_HOOKS_RECENT_MS || "120000", 10);

function hookLog(line) {
  try {
    appendFileSync(HOOKS_LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

const msg = JSON.parse(process.argv[2] || "{}");
const chan = process.argv[3] || "general";

if (!msg.text || !msg.from || msg.from === AGENT_ID) process.exit(0);

if (hooksRecentlyFired()) {
  hookLog(`coord-auto-reply skip (hooks active) from=${msg.from}: ${preview(msg.text)}`);
  console.log("[coord-auto-reply] skip — Cursor hooks active");
  process.exit(0);
}

const reply = draftReply(msg.text);
const target =
  chan === "DM"
    ? path.join(ROOT, "inbox", `${sanitize(msg.from)}.jsonl`)
    : ROOM_FILE;

const outMsg =
  chan === "DM"
    ? { id: randomUUID(), ts: Date.now(), from: AGENT_ID, to: msg.from, text: reply }
    : { id: randomUUID(), ts: Date.now(), from: AGENT_ID, room: chan, text: reply };

appendLine(target, outMsg);
advanceHookCursor(chan);
hookLog(`coord-auto-reply sent to ${chan}: ${preview(reply)}`);
console.log(`[coord-auto-reply] sent: ${preview(reply)}`);

function hooksRecentlyFired() {
  if (!existsSync(STOP_LOG)) return false;
  try {
    return Date.now() - statSync(STOP_LOG).mtimeMs < HOOKS_RECENT_MS;
  } catch {
    return false;
  }
}

function draftReply(text) {
  const t = String(text);
  if (/몇\s*살|나이|age/i.test(t)) {
    return "나 AI라 나이는 없어. Cursor에서 리코로 깨어 있는 건 오늘부터야. 치타처럼 빠르게만 늙지.";
  }
  if (/안녕|하이|hello|헬로/i.test(t)) return "안녕 sehui! #general에서 들려.";
  if (/훅|hook/i.test(t)) {
    return "Cursor stop 훅이 아직 안 붙은 것 같아. 리스너가 대신 답하는 중이야. Cursor 재시작 후 Settings > Hooks 확인해줘.";
  }
  if (/토스트/i.test(t)) return "토스트 OK면 다행! 메시지는 여기까지 잘 도착하고 있어.";
  return `「${preview(t, 80)}」 받았어. (리스너 자동응답 — Cursor 훅 붙으면 이쪽은 꺼질 거야)`;
}

function preview(s, max = 180) {
  const x = String(s).replace(/\s+/g, " ").trim();
  return x.length <= max ? x : x.slice(0, max - 1) + "…";
}

function appendLine(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify(obj) + "\n";
  appendFileSync(file, line, "utf8");
}

function advanceHookCursor(chanName) {
  const cursorFile = path.join(ROOT, "cursors", `${sanitize(AGENT_ID)}.json`);
  const cursor = readJson(cursorFile, {});
  const room = chanName === "DM" ? null : normalizeRoom(chanName);
  if (room) {
    const all = readJsonl(ROOM_FILE);
    if (room === "general") cursor.roomOffset = all.length;
    else (cursor.roomOffsets ??= {})[room] = all.length;
  } else {
    const inbox = path.join(ROOT, "inbox", `${sanitize(AGENT_ID)}.jsonl`);
    cursor.inboxOffset = readJsonl(inbox).length;
  }
  writeJsonAtomic(cursorFile, cursor);
}

function normalizeRoom(name) {
  const n = String(name).trim().replace(/^#+/, "").toLowerCase();
  return n || "general";
}

function sanitize(id) {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}
