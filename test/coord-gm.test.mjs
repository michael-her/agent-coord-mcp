import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildGmSlashContext,
  clearGmAgent,
  conWakeAddendum,
  getGmAgent,
  gmSessionContextAddendum,
  gmWakeReplyTail,
  isGmAgent,
  readRecentRoomMessages,
  saveInvWakeAddendum,
  setGmAgent,
} from "../.cursor/hooks/coord-gm-lib.mjs";

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

test("wake addenda for GM slash requests", () => {
  withTempCoord(() => {
    setGmAgent("gemini");
    const batch = [{ text: "@gemini [con] Continue the TRPG narrative" }];
    assert.match(conWakeAddendum("gemini", batch), /\/con request/);
    assert.equal(conWakeAddendum("rico", batch), "");
    const saveBatch = [{ text: "@gemini [saveinv] sync loot" }];
    assert.match(saveInvWakeAddendum("gemini", saveBatch), /\/saveinv request/);
    assert.equal(saveInvWakeAddendum("rico", saveBatch), "");
  });
});

test("buildGmSlashContext injects room history server-side", () => {
  withTempCoord((dir) => {
    setGmAgent("gemini");
    const roomFile = path.join(dir, "room.jsonl");
    const lines = [
      { id: "prev-con", from: "sehui", text: "@gemini [con]\nContinue.", room: "general" },
      { id: "prev-save", from: "sehui", text: "@gemini [saveinv]\nSync loot.", room: "general" },
      { id: "a", from: "rico", text: "@rico runs ahead", room: "general" },
      { id: "b", from: "sehui", text: "wait up", room: "general" },
      { id: "c", from: "sehui", text: "@gemini [con]\nContinue.", room: "general", contextLimit: 2 },
    ];
    writeFileSync(roomFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const recent = readRecentRoomMessages("general", 5, { excludeIds: ["c"] });
    assert.equal(recent.length, 2);
    assert.equal(recent[0].id, "a");
    assert.equal(recent[1].id, "b");

    const ctx = buildGmSlashContext("gemini", [lines[4]]);
    assert.match(ctx, /Recent #general messages/);
    assert.match(ctx, /@rico runs ahead/);
    assert.doesNotMatch(ctx, /\[con\]/);
    assert.doesNotMatch(ctx, /\[saveinv\]/);
    assert.equal(buildGmSlashContext("rico", [lines[4]]), "");
  });
});
