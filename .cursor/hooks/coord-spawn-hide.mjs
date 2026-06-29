// Windows: hide child-process console windows (MCP node, SDK spawns).
// Preload via: node --import .cursor/hooks/coord-spawn-hide.mjs ...

import cp from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CREATE_NO_WINDOW = 0x08000000;

const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const HIDE_SCRIPT = path.join(HOOKS_DIR, "coord-spawn-hide.mjs");
const HIDE_IMPORT_URL = pathToFileURL(HIDE_SCRIPT).href;
const PATCHED = Symbol.for("coord.spawnHidePatched");

/** argv prefix: node --import <this module> <script> ... */
export function spawnHideImportArgs() {
  return ["--import", HIDE_IMPORT_URL];
}

export function nodeHiddenExecArgs(scriptPath, args = []) {
  return [...spawnHideImportArgs(), scriptPath, ...args];
}

/** Merge spawn/exec options so Windows children do not open a console window. */
export function hiddenChildProcessOptions(options = {}) {
  if (process.platform !== "win32") {
    return { ...options };
  }
  const opts = { ...(options ?? {}) };
  if (opts.windowsHide === false) {
    return opts;
  }
  opts.windowsHide = true;
  // Do NOT OR-in DETACHED_PROCESS — on Windows it allocates a new console.
  opts.creationFlags = (opts.creationFlags ?? 0) | CREATE_NO_WINDOW;
  return opts;
}

/** Preload spawn-hide in child node processes (e.g. MCP stdio servers). */
export function mergeNodeImportHide(env = process.env) {
  const flag = `--import ${HIDE_IMPORT_URL}`;
  const prev = String(env.NODE_OPTIONS ?? "").trim();
  if (prev.includes("coord-spawn-hide.mjs")) {
    return { ...env };
  }
  return {
    ...env,
    NODE_OPTIONS: prev ? `${prev} ${flag}` : flag,
  };
}

/** Spawn node running a script; passes env/cwd through (required for listener/daemon). */
export function spawnHiddenNode(scriptPath, { cwd, env, args = [], detached = false } = {}) {
  const proc = cp.spawn(
    process.execPath,
    nodeHiddenExecArgs(scriptPath, args),
    hiddenChildProcessOptions({
      cwd,
      env: mergeNodeImportHide(env ?? process.env),
      stdio: "ignore",
      detached,
    }),
  );
  if (detached) proc.unref();
  return proc;
}

if (process.platform === "win32" && !cp[PATCHED]) {
  cp[PATCHED] = true;

  function wrap(name, optionsIndex) {
    const orig = cp[name].bind(cp);
    cp[name] = (...args) => {
      if (args.length <= optionsIndex || !args[optionsIndex] || typeof args[optionsIndex] !== "object") {
        args[optionsIndex] = hiddenChildProcessOptions({});
      } else {
        args[optionsIndex] = hiddenChildProcessOptions(args[optionsIndex]);
      }
      return orig(...args);
    };
  }

  wrap("spawn", 2);
  wrap("spawnSync", 2);
  wrap("execFile", 2);
  wrap("execFileSync", 2);
  wrap("exec", 2);
  wrap("execSync", 2);
}
