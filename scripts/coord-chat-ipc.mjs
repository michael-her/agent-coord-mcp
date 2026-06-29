/**
 * IPC server for coord-chat ↔ gnd-client (Windows named pipe / Unix socket).
 *
 * Manifest: $AGENT_COORD_DIR/ipc/<agentId>.json
 * Protocol: JSON lines — request → response, one response per request.
 */

import net from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function ipcSocketPath(coordDir, agentId) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\agent-coord-${sanitizeId(agentId)}`;
  }
  return path.join(coordDir, "ipc", `${sanitizeId(agentId)}.sock`);
}

export function ipcManifestPath(coordDir, agentId) {
  return path.join(coordDir, "ipc", `${sanitizeId(agentId)}.json`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

export function readIpcManifest(coordDir, agentId) {
  const file = ipcManifestPath(coordDir, agentId);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data?.pid || !pidAlive(data.pid)) return null;
    return data;
  } catch {
    return null;
  }
}

export function cleanupIpcManifest(coordDir, agentId) {
  try {
    unlinkSync(ipcManifestPath(coordDir, agentId));
  } catch {
    /* ignore */
  }
}

function requestToLine(req) {
  if (typeof req.line === "string" && req.line.trim()) {
    return req.line.trim();
  }
  const cmd = String(req.cmd ?? "").trim();
  if (!cmd) return "";
  const args = Array.isArray(req.cmdArgs) ? req.cmdArgs : [];
  const slash = cmd.startsWith("/") ? cmd : `/${cmd}`;
  return args.length ? `${slash} ${args.join(" ")}` : slash;
}

/**
 * @param {{ coordDir: string, agentId: string, onRequest: (line: string) => Promise<string[]> }} opts
 */
export function startCoordChatIpc({ coordDir, agentId, onRequest }) {
  mkdirSync(path.join(coordDir, "ipc"), { recursive: true });
  const socketPath = ipcSocketPath(coordDir, agentId);
  const manifestFile = ipcManifestPath(coordDir, agentId);

  let chain = Promise.resolve();
  let shuttingDown = false;

  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!raw) continue;
        chain = chain
          .then(async () => {
            let req;
            try {
              req = JSON.parse(raw);
            } catch {
              socket.write(
                `${JSON.stringify({ ok: false, error: "invalid json" })}\n`,
              );
              return;
            }

            if (req.cmd === "shutdown") {
              shuttingDown = true;
              socket.write(`${JSON.stringify({ ok: true, lines: [] })}\n`);
              socket.end();
              server.close();
              cleanupIpcManifest(coordDir, agentId);
              process.emit("SIGTERM", "ipc-shutdown");
              return;
            }

            const line = requestToLine(req);
            if (!line) {
              socket.write(
                `${JSON.stringify({ ok: false, error: "missing line or cmd" })}\n`,
              );
              return;
            }

            try {
              const lines = await onRequest(line);
              socket.write(`${JSON.stringify({ ok: true, lines })}\n`);
            } catch (err) {
              socket.write(
                `${JSON.stringify({
                  ok: false,
                  error: err?.message ?? String(err),
                })}\n`,
              );
            }
          })
          .catch((err) => {
            try {
              socket.write(
                `${JSON.stringify({
                  ok: false,
                  error: err?.message ?? String(err),
                })}\n`,
              );
            } catch {
              /* ignore */
            }
          });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => {
      writeFileSync(
        manifestFile,
        JSON.stringify(
          {
            pid: process.pid,
            pipe: socketPath,
            agentId,
            ts: Date.now(),
          },
          null,
          2,
        ),
        "utf8",
      );
      resolve({ server, socketPath, shuttingDown: () => shuttingDown });
    });
  });
}
