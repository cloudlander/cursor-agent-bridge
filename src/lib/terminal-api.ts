import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import { json } from "./http.js";

export function terminalApiMatches(req: http.IncomingMessage): boolean {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  return req.method === "GET" && pathname === "/api/terminal/status";
}

export function handleTerminalApi(
  res: http.ServerResponse,
  config: BridgeConfig,
): void {
  const ssh = config.terminalSsh;
  json(res, 200, {
    enabled: !!ssh?.enabled,
    wsPath: "/api/terminal/ws",
    ssh: ssh?.enabled
      ? { host: ssh.host, port: ssh.port, username: ssh.username }
      : undefined,
  });
}
