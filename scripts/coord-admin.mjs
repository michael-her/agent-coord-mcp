#!/usr/bin/env node
/**
 * Admin CLI for gnd-client: list / invite / invited / uninvite / kick
 *
 * Usage:
 *   node scripts/coord-admin.mjs <cmd> [args] [--dir <coord>] [--repo <project>] [--id <self>]
 *
 * One-shot CLI spawns detached children (legacy). gnd-client uses coord-gnd-proxy.mjs instead.
 */

import {
  AdminCommandError,
  adminHelpText,
  buildAdminContext,
  parseAdminCliArgs,
  runAdminCommand,
} from "./coord-admin-lib.mjs";

const args = parseAdminCliArgs(process.argv.slice(2));
if (args.help) {
  console.log(adminHelpText());
  process.exit(0);
}
if (!args.cmd) {
  console.log(adminHelpText());
  process.exit(1);
}

const ctx = buildAdminContext({
  dir: args.dir,
  repo: args.repo,
  id: args.id,
});

try {
  const lines = await runAdminCommand(ctx, args.cmd, args.cmdArgs, {
    detachChildren: false,
  });
  for (const line of lines) {
    console.log(line);
  }
} catch (err) {
  console.error(err?.message ?? String(err));
  process.exit(err instanceof AdminCommandError ? err.exitCode : 1);
}
