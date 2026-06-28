#!/usr/bin/env node
/**
 * Remove ephemeral coord wake/listener files from `.cursor/hooks/` and `logs/`.
 *
 * Usage:
 *   node scripts/clean-coord-hooks.mjs           # delete matched files
 *   node scripts/clean-coord-hooks.mjs --dry-run # preview only
 *   node scripts/clean-coord-hooks.mjs --list    # list paths, no delete
 *
 * Does not remove: *.pid, coord-hooks.log, coord-wake.local.env, coord-session-agents.json
 * Stop coord-chat invited stacks (/uninvite or /quit) before cleaning if daemons are running.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanWakeTempFiles,
  listWakeTempFiles,
} from "../.cursor/hooks/coord-wake-logs-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_HOOKS_DIR = path.join(REPO, ".cursor", "hooks");

function parseArgs(argv) {
  const out = { dryRun: false, list: false, dir: DEFAULT_HOOKS_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "-n") out.dryRun = true;
    else if (a === "--list" || a === "-l") out.list = true;
    else if (a === "--dir") out.dir = path.resolve(argv[++i] ?? "");
    else if (a === "-h" || a === "--help") {
      console.log(`usage: node scripts/clean-coord-hooks.mjs [--dry-run] [--list] [--dir <hooks-path>]`);
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const hooksDir = args.dir;

if (args.list) {
  const files = listWakeTempFiles({ hooksDir });
  if (!files.length) {
    console.log("(no ephemeral wake/listener files)");
    process.exit(0);
  }
  for (const f of files) console.log(f);
  process.exit(0);
}

const { removed, failed, dryRun } = cleanWakeTempFiles({ hooksDir, dryRun: args.dryRun });

if (!removed.length && !failed.length) {
  console.log("(nothing to clean)");
  process.exit(0);
}

const label = dryRun ? "would remove" : "removed";
for (const f of removed) console.log(`${label}: ${f}`);

if (failed.length) {
  for (const { file, error } of failed) console.error(`failed: ${file} (${error})`);
  process.exit(1);
}

console.log(`${dryRun ? "would remove" : "removed"} ${removed.length} file(s)`);
