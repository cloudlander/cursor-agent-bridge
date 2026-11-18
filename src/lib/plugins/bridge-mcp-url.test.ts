import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../config.js";
import {
  applyRemoteMcpDirect,
  ensureRemoteMcpClients,
  readRemoteMcpClients,
} from "./bridge-mcp-url.js";

const DRIVE = "https://api.cursor.com/rest-mcp/google-drive/mcp";

describe("applyRemoteMcpDirect", () => {
  it("keeps the Cursor URL until a client is registered", () => {
    expect(applyRemoteMcpDirect({ type: "http", url: DRIVE }, {})).toEqual({
      type: "http",
      url: DRIVE,
    });
  });

  it("points Google Drive at Google with the registered static client", () => {
    const out = applyRemoteMcpDirect(
      { type: "http", url: `${DRIVE}/` },
      { [DRIVE]: { clientId: "cid", clientSecret: "sec" } },
    );
    expect(out.url).toBe("https://drivemcp.googleapis.com/mcp/v1");
    expect(out.auth).toMatchObject({ CLIENT_ID: "cid", CLIENT_SECRET: "sec" });
    expect((out.auth as { scopes: string[] }).scopes).toContain(
      "https://www.googleapis.com/auth/drive.readonly",
    );
  });

  it("leaves other URLs unchanged", () => {
    const def = { url: "https://example.com/mcp" };
    expect(applyRemoteMcpDirect(def, { [DRIVE]: { clientId: "cid" } })).toBe(def);
  });
});

describe("ensureRemoteMcpClients", () => {
  let dir: string;
  let config: BridgeConfig;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-mcp-"));
    vi.stubEnv("CURSOR_BRIDGE_PLUGINS_DIR", dir);
    config = {} as BridgeConfig;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers once and caches the client", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ client_id: "cid", client_secret: "sec" }), { status: 201 }),
    );
    const first = await ensureRemoteMcpClients(config, [{ url: DRIVE }], fetchImpl as typeof fetch);
    expect(first).toEqual({ registered: [DRIVE], errors: [] });
    expect(readRemoteMcpClients(config)[DRIVE]).toEqual({ clientId: "cid", clientSecret: "sec" });

    const second = await ensureRemoteMcpClients(config, [{ url: DRIVE }], fetchImpl as typeof fetch);
    expect(second.registered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports registration failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const out = await ensureRemoteMcpClients(config, [{ url: DRIVE }], fetchImpl as typeof fetch);
    expect(out.registered).toEqual([]);
    expect(out.errors[0]).toContain("HTTP 500");
    expect(readRemoteMcpClients(config)).toEqual({});
  });
});
