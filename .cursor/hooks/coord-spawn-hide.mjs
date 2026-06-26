// Windows: hide child-process console windows (MCP node, SDK spawns).
// Preload via: node --import .cursor/hooks/coord-spawn-hide.mjs ...

import cp from "node:child_process";

if (process.platform === "win32") {
  const CREATE_NO_WINDOW = 0x08000000;

  function hideOpts(options) {
    const opts = { ...(options ?? {}) };
    if (opts.windowsHide === false) return opts;
    opts.windowsHide = true;
    opts.creationFlags = (opts.creationFlags ?? 0) | CREATE_NO_WINDOW;
    return opts;
  }

  function wrap(name, optionsIndex) {
    const orig = cp[name].bind(cp);
    cp[name] = (...args) => {
      if (args.length > optionsIndex && args[optionsIndex] && typeof args[optionsIndex] === "object") {
        args[optionsIndex] = hideOpts(args[optionsIndex]);
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
