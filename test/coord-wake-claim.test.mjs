import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claimWakeMessages,
  dedupeWakeItems,
  filterUnclaimed,
  isWakeClaimed,
  wakeMessageKey,
} from "../.cursor/hooks/coord-wake-claim-lib.mjs";

const prevHooksDir = process.env.AGENT_COORD_DIR;

test.after(() => {
  if (prevHooksDir === undefined) delete process.env.AGENT_COORD_DIR;
  else process.env.AGENT_COORD_DIR = prevHooksDir;
});

function withTempCoord(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "coord-wake-claim-"));
  process.env.AGENT_COORD_DIR = dir;
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("dedupeWakeItems collapses duplicate message ids", () => {
  const a = { id: "m1", from: "sehui", text: "hello", ts: 1 };
  const out = dedupeWakeItems([a, { ...a }, { id: "m2", from: "rico", text: "hi", ts: 2 }]);
  assert.equal(out.length, 2);
  assert.equal(wakeMessageKey(a), "m1");
});

test("claimWakeMessages prevents second wake for same message", () => {
  withTempCoord(() => {
    const msg = { id: "roll-1", from: "sehui", text: "@all> dice", ts: 99 };
    assert.equal(isWakeClaimed("gemini", msg), false);
    claimWakeMessages("gemini", [msg]);
    assert.equal(isWakeClaimed("gemini", msg), true);
    assert.equal(filterUnclaimed("gemini", [msg]).length, 0);
  });
});
