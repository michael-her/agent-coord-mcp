#!/usr/bin/env node
// One hidden node process per agent: listener + wake-daemon together (not two windows).

import "./coord-spawn-hide.mjs";

import path from "node:path";
import { fileURLToPath } from "node:url";

import { startCoordListener } from "./coord-listener.mjs";
import { startCoordWakeDaemon } from "./coord-wake-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  if (!startCoordWakeDaemon()) process.exit(0);
  startCoordListener();
}
