import type * as http from "node:http";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import { WebSocket, WebSocketServer } from "ws";

import type { BridgeConfig } from "./config.js";
import { bridgeContextFrom, setBridgePublicContext } from "./bridge-request-context.js";
import {
  externalPathnameFromRequest,
  splitPublicPath,
} from "./http-public-path.js";
import type { TerminalSshConfig } from "./terminal-ssh-config.js";

const TERMINAL_WS_PATH = "/api/terminal/ws";

export function terminalWsPathname(pathname: string): boolean {
  return pathname === TERMINAL_WS_PATH;
}

function pathnameForUpgrade(
  req: http.IncomingMessage,
  config: BridgeConfig,
): string {
  const external = externalPathnameFromRequest(req);
  const split = splitPublicPath(external, config.appSegment);
  if (split.kind === "found") return split.internal;
  return external;
}

type ResizeMessage = {
  type: "resize";
  cols: number;
  rows: number;
};

function parseResizePayload(text: string): ResizeMessage | undefined {
  try {
    const parsed = JSON.parse(text) as ResizeMessage;
    if (
      parsed?.type === "resize" &&
      Number.isFinite(parsed.cols) &&
      Number.isFinite(parsed.rows)
    ) {
      return {
        type: "resize",
        cols: Math.max(1, Math.floor(parsed.cols)),
        rows: Math.max(1, Math.floor(parsed.rows)),
      };
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function parseResize(data: WebSocket.RawData): ResizeMessage | undefined {
  if (typeof data === "string") return parseResizePayload(data);
  if (Buffer.isBuffer(data)) return parseResizePayload(data.toString("utf8"));
  if (Array.isArray(data)) {
    return parseResizePayload(Buffer.concat(data).toString("utf8"));
  }
  return undefined;
}

function bridgeSshSession(
  ws: WebSocket,
  ssh: TerminalSshConfig,
): void {
  const conn = new Client();
  let shell: ClientChannel | undefined;
  let closed = false;

  const teardown = (reason?: string) => {
    if (closed) return;
    closed = true;
    try {
      shell?.end();
    } catch {
      /* ignore */
    }
    shell = undefined;
    try {
      conn.end();
    } catch {
      /* ignore */
    }
    if (ws.readyState === WebSocket.OPEN) {
      const msg = reason ? `Session closed: ${reason}` : "Session closed";
      try {
        ws.send(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
      } catch {
        /* ignore */
      }
      ws.close(1000);
    }
  };

  ws.on("close", () => teardown());
  ws.on("error", () => teardown());

  conn.on("ready", () => {
    conn.shell(
      { term: "xterm-256color", cols: 80, rows: 24 },
      (err, stream) => {
        if (err || closed) {
          teardown(err?.message ?? "shell failed");
          return;
        }
        shell = stream;
        stream.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });
        stream.on("close", () => teardown());
        stream.stderr.on("data", (chunk: Buffer) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
        });

        ws.on("message", (data, isBinary) => {
          if (closed || !shell) return;
          if (!isBinary) {
            const resize = parseResize(data);
            if (resize) {
              shell.setWindow(resize.rows, resize.cols, 0, 0);
              return;
            }
          }
          const buf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(String(data));
          shell.write(buf);
        });
      },
    );
  });

  conn.on("error", (err) => {
    teardown(err.message);
  });

  const connectOpts: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    tryKeyboard: true,
  };
  if (ssh.privateKey) connectOpts.privateKey = ssh.privateKey;
  if (ssh.password) connectOpts.password = ssh.password;
  if (ssh.agent) connectOpts.agent = ssh.agent;

  conn.on("keyboard-interactive", (_name, _desc, _lang, _prompts, finish) => {
    if (ssh.password) finish([ssh.password]);
    else finish([]);
  });

  conn.connect(connectOpts);
}

export function attachTerminalWebSocket(
  server: http.Server,
  config: BridgeConfig,
): WebSocketServer | undefined {
  const ssh = config.terminalSsh;
  if (!ssh?.enabled) return undefined;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const pathname = pathnameForUpgrade(req, config);
    if (!terminalWsPathname(pathname)) return;

    const ctx = bridgeContextFrom("", config, externalPathnameFromRequest(req));
    setBridgePublicContext(req, ctx);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      bridgeSshSession(ws, ssh);
    });
  });

  return wss;
}
