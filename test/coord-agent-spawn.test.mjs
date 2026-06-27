import assert from "node:assert/strict";
import test from "node:test";
import {
  parseInviteSpec,
  isInviteAllArg,
  collectRegistryInviteTargets,
} from "../scripts/coord-agent-spawn.mjs";

test("parseInviteSpec accepts model@id", () => {
  assert.deepEqual(parseInviteSpec("gemini-3-flash@gemini"), {
    model: "gemini-3-flash",
    agentId: "gemini",
  });
  assert.deepEqual(parseInviteSpec("composer-2.5@rico"), {
    model: "composer-2.5",
    agentId: "rico",
  });
  assert.equal(parseInviteSpec(""), null);
  assert.equal(parseInviteSpec("gemini"), null);
  assert.equal(parseInviteSpec("@gemini"), null);
});

test("isInviteAllArg recognizes bulk invite and uninvite", () => {
  assert.equal(isInviteAllArg("@all"), true);
  assert.equal(isInviteAllArg("all"), true);
  assert.equal(isInviteAllArg("@ALL"), true);
  assert.equal(isInviteAllArg("gemini-3-flash@gemini"), false);
  assert.equal(isInviteAllArg("@gemini"), false);
});

test("collectRegistryInviteTargets skips executor and humans", () => {
  const registry = {
    sehui: { agentId: "sehui", role: "human" },
    gemini: { agentId: "gemini", role: "cursor", model: "gemini-3-flash" },
    rico: { agentId: "rico", role: "cursor", model: "composer-2.5" },
  };
  const { targets, skipped } = collectRegistryInviteTargets({
    registry,
    models: {},
    defaults: {},
    excludeId: "sehui",
  });
  assert.deepEqual(targets, [
    { agentId: "gemini", model: "gemini-3-flash" },
    { agentId: "rico", model: "composer-2.5" },
  ]);
  assert.equal(skipped.length, 0);
});

test("collectRegistryInviteTargets resolves model from maps", () => {
  const registry = {
    sehui: { agentId: "sehui", role: "human" },
    rico: { agentId: "rico", role: "cursor" },
  };
  const { targets } = collectRegistryInviteTargets({
    registry,
    models: { rico: "composer-2.5" },
    defaults: {},
    excludeId: "sehui",
  });
  assert.deepEqual(targets, [{ agentId: "rico", model: "composer-2.5" }]);
});
