import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCombinedDiceMessage,
  formatDiceLine,
  parseDiceCommand,
  parseTrailingDiceCommand,
  rollDiceExpr,
} from "../scripts/coord-dice.mjs";

test("parseDiceCommand accepts common TRPG forms", () => {
  assert.equal(parseDiceCommand("/d20"), "1d20");
  assert.equal(parseDiceCommand("/d"), "1d20");
  assert.equal(parseDiceCommand("/d%"), "1d100");
  assert.equal(parseDiceCommand("/d100"), "1d100");
  assert.equal(parseDiceCommand("/2d6"), "2d6");
  assert.equal(parseDiceCommand("/2d6+3"), "2d6+3");
  assert.equal(parseDiceCommand("/1d20-2"), "1d20-2");
  assert.equal(parseDiceCommand("/roll 3d8+1"), "3d8+1");
  assert.equal(parseDiceCommand("/r d12"), "1d12");
  assert.equal(parseDiceCommand("/hello"), null);
});

test("rollDiceExpr produces in-range totals", () => {
  const r = rollDiceExpr("2d6+1");
  assert.equal(r.rolls.length, 2);
  assert.equal(r.total, r.rolls[0] + r.rolls[1] + 1);
  for (const v of r.rolls) assert.ok(v >= 1 && v <= 6);
});

test("formatDiceLine summarizes rolls", () => {
  const line = formatDiceLine("sehui", {
    expr: "2d6+3",
    rolls: [4, 5],
    modifier: 3,
    total: 12,
  });
  assert.match(line, /^@all>/);
  assert.match(line, /sehui/);
  assert.match(line, /2d6\+3/);
  assert.match(line, /= 12/);
  assert.doesNotMatch(line, /→/);
});

test("parseTrailingDiceCommand at end of narrative", () => {
  const hit = parseTrailingDiceCommand("날렵하게 거리를 벌린다. /d20");
  assert.ok(hit);
  assert.equal(hit.narrative, "날렵하게 거리를 벌린다.");
  assert.equal(hit.expr, "1d20");
  assert.equal(parseTrailingDiceCommand("/d20"), null);
  assert.equal(parseTrailingDiceCommand("hello /d20 world"), null);
});

test("formatCombinedDiceMessage joins narrative and dice", () => {
  const msg = formatCombinedDiceMessage("sehui", "날렵하게 거리를 벌린다.", {
    expr: "1d20",
    rolls: [5],
    modifier: 0,
    total: 5,
  });
  assert.match(msg, /^날렵하게 거리를 벌린다\.\n@all>/);
  assert.match(msg, /1d20 · 5$/);
});
