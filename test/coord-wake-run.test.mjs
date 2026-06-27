import assert from "node:assert/strict";
import test from "node:test";

import {
  isWakeTimeoutError,
  waitForRun,
} from "../.cursor/hooks/coord-wake-lib.mjs";

test("isWakeTimeoutError matches daemon timeout message", () => {
  assert.equal(isWakeTimeoutError("wake run timeout after 180000ms"), true);
  assert.equal(isWakeTimeoutError("network error"), false);
});

test("waitForRun resolves when run finishes in time", async () => {
  const result = await waitForRun(
    {
      wait: async () => ({ status: "finished", id: "run-1" }),
      supports: () => true,
      cancel: async () => {},
    },
    50,
  );
  assert.equal(result.status, "finished");
});

test("waitForRun cancels and rejects on timeout", async () => {
  let cancelled = false;
  await assert.rejects(
    () =>
      waitForRun(
        {
          wait: () => new Promise(() => {}),
          supports: (op) => op === "cancel",
          cancel: async () => {
            cancelled = true;
          },
        },
        20,
      ),
    /wake run timeout/,
  );
  assert.equal(cancelled, true);
});
