import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearGmAgent,
  getGmAgent,
  gmSessionContextAddendum,
  gmWakeReplyTail,
  isGmAgent,
  setGmAgent,
} from "../../.cursor/hooks/coord-gm-lib.mjs";

const prevDir = process.env.AGENT_COORD_DIR;

test.after(() => {
  if (prevDir === undefined) delete process.env.AGENT_COORD_DIR;
  else process.env.AGENT_COORD_DIR = prevDir;
});

function withTempCoord(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "coord-gm-"));
  process.env.AGENT_COORD_DIR = dir;
  try {
    fn(dir);
  } finally {
    clearGmAgent();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("setGmAgent persists and clears", () => {
  withTempCoord(() => {
    assert.equal(getGmAgent(), null);
    setGmAgent("gemini", { setBy: "sehui", room: "general" });
    assert.equal(getGmAgent(), "gemini");
    assert.equal(isGmAgent("gemini"), true);
    assert.equal(isGmAgent("rico"), false);
    clearGmAgent();
    assert.equal(getGmAgent(), null);
  });
});

test("gmWakeReplyTail swaps brevity for narrative instructions", () => {
  withTempCoord(() => {
    assert.match(gmWakeReplyTail("rico"), /Keep it short/);
    setGmAgent("gemini");
    const tail = gmWakeReplyTail("gemini");
    assert.doesNotMatch(tail, /Keep it short/);
    assert.match(tail, /TRPG Game Master/);
    assert.match(tail, /Narrate vividly/);
  });
});

test("gmSessionContextAddendum only for GM agent", () => {
  withTempCoord(() => {
    assert.equal(gmSessionContextAddendum("rico"), "");
    setGmAgent("gemini");
    assert.match(gmSessionContextAddendum("gemini"), /TRPG GM role active/);
    assert.equal(gmSessionContextAddendum("rico"), "");
  });
});
