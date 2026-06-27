import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setGmAgent, clearGmAgent } from "../.cursor/hooks/coord-gm-lib.mjs";
import {
  isGmSlashRequest,
  mentionsAgent,
  shouldWakeForCoordMessage,
  wakeMentionText,
} from "../.cursor/hooks/coord-mention-lib.mjs";

const prevCoordDir = process.env.AGENT_COORD_DIR;

test.after(() => {
  if (prevCoordDir === undefined) delete process.env.AGENT_COORD_DIR;
  else process.env.AGENT_COORD_DIR = prevCoordDir;
});

function withGm(gmId, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "coord-mention-gm-"));
  process.env.AGENT_COORD_DIR = dir;
  try {
    setGmAgent(gmId, { room: "general" });
    fn();
  } finally {
    clearGmAgent();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("mentionsAgent: punctuation after @id still counts", () => {
  assert.equal(mentionsAgent("@gemini.", "gemini"), true);
  assert.equal(mentionsAgent("@gemini, what do you think?", "gemini"), true);
  assert.equal(mentionsAgent("@all> 🎲 roll", "rico"), true);
  assert.equal(mentionsAgent("hey @rico!", "rico"), true);
});

test("mentionsAgent: id continuation still rejected", () => {
  assert.equal(mentionsAgent("@gemini2", "gemini"), false);
  assert.equal(mentionsAgent("@geminix", "gemini"), false);
  assert.equal(mentionsAgent("@rico-backend", "rico"), false);
  assert.equal(mentionsAgent("@allow", "all"), false);
});

test("mentionsAgent: full hyphenated ids", () => {
  assert.equal(mentionsAgent("@rico-backend.", "rico-backend"), true);
});

test("wakeMentionText strips dice suffixes", () => {
  assert.equal(
    wakeMentionText("세희, 같이 간다! 🎲 rico · 1d20 · 8"),
    "세희, 같이 간다!",
  );
  assert.equal(
    wakeMentionText("날렵하게 피한다.\n@all> 🎲 sehui · 1d20 · 5"),
    "날렵하게 피한다.",
  );
});

test("shouldWakeForCoordMessage: never wake the sender", () => {
  assert.equal(
    shouldWakeForCoordMessage(
      { from: "rico", text: "@all> 🎲 rico · 1d20 · 8" },
      "rico",
    ),
    false,
  );
});

test("shouldWakeForCoordMessage: agent dice auto-wakes TRPG GM only", () => {
  const msg = { from: "rico", text: "세희, 같이 간다! 🎲 rico · 1d20 · 8" };
  withGm("gemini", () => {
    assert.equal(shouldWakeForCoordMessage(msg, "gemini", { room: "general" }), true);
    assert.equal(shouldWakeForCoordMessage(msg, "rico", { room: "general" }), false);
    assert.equal(
      shouldWakeForCoordMessage(
        { from: "rico", text: "세희, 같이 간다!\n@all> 🎲 rico · 1d20 · 8" },
        "gemini",
        { room: "general" },
      ),
      true,
    );
  });
});

test("shouldWakeForCoordMessage: agent dice + narrative @mention", () => {
  withGm("gemini", () => {
    assert.equal(
      shouldWakeForCoordMessage(
        { from: "rico", text: "@rico 실수! 🎲 rico · 1d20 · 8" },
        "rico",
        { room: "general" },
      ),
      false,
    );
    assert.equal(
      shouldWakeForCoordMessage(
        { from: "rico", text: "@gemini 결과 봐줘! 🎲 rico · 1d20 · 8" },
        "gemini",
        { room: "general" },
      ),
      true,
    );
  });
});
test("shouldWakeForCoordMessage: narrative @mention still wakes", () => {
  assert.equal(
    shouldWakeForCoordMessage(
      { from: "gemini", text: "@rico 리코, 같이 반격해줘!" },
      "rico",
    ),
    true,
  );
});

test("shouldWakeForCoordMessage: human wakeAll dice still wakes everyone", () => {
  assert.equal(
    shouldWakeForCoordMessage(
      {
        from: "sehui",
        text: "날렵하게 피한다.\n@all> 🎲 sehui · 1d20 · 5",
        wakeAll: true,
      },
      "rico",
    ),
    true,
  );
});

test("shouldWakeForCoordMessage: /con and /saveinv wake TRPG GM only", () => {
  const conMsg = {
    from: "sehui",
    text: "@johns [con]\nContinue the TRPG narrative.",
  };
  const saveMsg = {
    from: "sehui",
    text: "@johns [saveinv]\nSync inventories.",
  };
  const legacyConMsg = {
    from: "sehui",
    text: [
      "@johns [con]",
      "Continue the TRPG narrative.",
      "",
      "Recent #general messages (last 5):",
      "rico: @rico check the door",
    ].join("\n"),
  };
  withGm("johns", () => {
    assert.equal(shouldWakeForCoordMessage(conMsg, "johns", { room: "general" }), true);
    assert.equal(shouldWakeForCoordMessage(conMsg, "rico", { room: "general" }), false);
    assert.equal(shouldWakeForCoordMessage(saveMsg, "johns", { room: "general" }), true);
    assert.equal(shouldWakeForCoordMessage(saveMsg, "rico", { room: "general" }), false);
    assert.equal(shouldWakeForCoordMessage(legacyConMsg, "rico", { room: "general" }), false);
    assert.equal(isGmSlashRequest(conMsg), true);
    assert.equal(isGmSlashRequest({ from: "sehui", text: "@rico normal mention" }), false);
  });
});
