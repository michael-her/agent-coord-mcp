#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dirname, "coord-hooks.log");

// Log immediately — proves Cursor invoked the hook even if stdin is empty.
try {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `[${new Date().toISOString()}] START audit pid=${process.pid}\n`, "utf8");
} catch {
  /* ignore */
}

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  /* ignore */
}
raw = raw.replace(/^\uFEFF/, "").trim();

let payload = {};
try {
  if (raw) payload = JSON.parse(raw);
} catch {
  /* ignore */
}

const event =
  payload.hook_event_name ||
  payload.tool_name ||
  raw.match(/"hook_event_name"\s*:\s*"([^"]+)"/)?.[1] ||
  raw.match(/"tool_name"\s*:\s*"([^"]+)"/)?.[1] ||
  "unknown";

const summary =
  event === "beforeSubmitPrompt"
    ? `prompt=${JSON.stringify((payload.prompt || "").slice(0, 80))}`
    : event === "postToolUse"
      ? `tool=${payload.tool_name || "?"}`
      : event === "stop"
        ? `status=${payload.status ?? "?"}`
        : "";

const line = `[${new Date().toISOString()}] ${event} ${summary}\n`;
try {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, line, "utf8");
} catch {
  /* ignore */
}

process.stdout.write("{}\n");
