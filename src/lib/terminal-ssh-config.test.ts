import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadTerminalSshConfig } from "./terminal-ssh-config.js";

let testAgentSocket: net.Server | undefined;

afterEach(() => {
  testAgentSocket?.close();
  testAgentSocket = undefined;
});

function tempAgentSocket(): string {
  const sockPath = path.join(
    os.tmpdir(),
    `terminal-ssh-agent-test-${process.pid}-${Date.now()}.sock`,
  );
  const server = net.createServer();
  server.listen(sockPath);
  testAgentSocket = server;
  return sockPath;
}

describe("loadTerminalSshConfig", () => {
  it("defaults to localhost:2222 when enabled", () => {
    const cfg = loadTerminalSshConfig({
      CURSOR_BRIDGE_TERMINAL: "1",
      USER: "cdsw",
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(2222);
    expect(cfg.username).toBe("cdsw");
  });

  it("can disable terminal entirely", () => {
    const cfg = loadTerminalSshConfig({
      CURSOR_BRIDGE_TERMINAL: "0",
      CURSOR_BRIDGE_TERMINAL_SSH_PORT: "2222",
    });
    expect(cfg.enabled).toBe(false);
  });

  it("uses SSH_AUTH_SOCK when present", () => {
    const sock = tempAgentSocket();
    const cfg = loadTerminalSshConfig({
      CURSOR_BRIDGE_TERMINAL: "1",
      USER: "cdsw",
      SSH_AUTH_SOCK: sock,
    });
    expect(cfg.agent).toBe(sock);
  });

  it("can override agent socket", () => {
    const sock = tempAgentSocket();
    const cfg = loadTerminalSshConfig({
      CURSOR_BRIDGE_TERMINAL: "1",
      SSH_AUTH_SOCK: "/no/such.sock",
      CURSOR_BRIDGE_TERMINAL_SSH_AGENT: sock,
    });
    expect(cfg.agent).toBe(sock);
  });
});
