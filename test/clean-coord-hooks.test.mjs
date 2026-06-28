import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import {
  cleanWakeTempFiles,
  listWakeTempFiles,
  WAKE_TEMP_PATTERNS,
} from "../.cursor/hooks/coord-wake-logs-lib.mjs";

test("WAKE_TEMP_PATTERNS match wake/listener artifacts", () => {
  assert.ok(WAKE_TEMP_PATTERNS.some((re) => re.test("coord-wake-busy-rico.json")));
  assert.ok(WAKE_TEMP_PATTERNS.some((re) => re.test("coord-listener-state-gemini.json")));
  assert.ok(WAKE_TEMP_PATTERNS.some((re) => re.test(".wake-queue-rico.jsonl")));
  assert.ok(!WAKE_TEMP_PATTERNS.some((re) => re.test("coord-wake.local.env")));
  assert.ok(!WAKE_TEMP_PATTERNS.some((re) => re.test("coord-session-agents.json")));
});

test("listWakeTempFiles and cleanWakeTempFiles", () => {
  const root = path.join(tmpdir(), `coord-hooks-clean-${Date.now()}`);
  const logs = path.join(root, "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(root, "coord-wake-claimed-johns.json"), "{}");
  writeFileSync(path.join(logs, "coord-wake-busy-gemini.json"), "{}");
  writeFileSync(path.join(root, "coord-wake.local.env"), "X=1");

  const listed = listWakeTempFiles({ hooksDir: root });
  assert.equal(listed.length, 2);

  const preview = cleanWakeTempFiles({ hooksDir: root, dryRun: true });
  assert.equal(preview.removed.length, 2);
  assert.ok(existsSync(path.join(root, "coord-wake-claimed-johns.json")));

  const done = cleanWakeTempFiles({ hooksDir: root });
  assert.equal(done.removed.length, 2);
  assert.equal(done.failed.length, 0);
  assert.ok(!existsSync(path.join(root, "coord-wake-claimed-johns.json")));
  assert.ok(existsSync(path.join(root, "coord-wake.local.env")));

  rmSync(root, { recursive: true, force: true });
});
