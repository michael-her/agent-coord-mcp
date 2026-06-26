#!/usr/bin/env node
// Inject agent-coord identity + behavior at session start (rico / gemini / …).

import { readFileSync } from "node:fs";
import {
  agentIdFromModel,
  saveAgentModel,
  saveSessionAgent,
  sessionContext,
} from "./coord-agent-lib.mjs";

let input = {};
try {
  const raw = readFileSync(0, "utf8");
  if (raw.trim()) input = JSON.parse(raw);
} catch {
  /* ignore */
}

if (input.composer_mode && input.composer_mode !== "agent") {
  process.stdout.write("{}\n");
  process.exit(0);
}

const agentId = agentIdFromModel(input.model);
if (input.conversation_id) saveSessionAgent(input.conversation_id, agentId);
if (agentId && input.model) saveAgentModel(agentId, input.model);

process.stdout.write(
  JSON.stringify({ additional_context: sessionContext(agentId) }) + "\n",
);
