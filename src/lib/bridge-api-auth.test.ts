import type * as http from "node:http";
import { describe, expect, it } from "vitest";

import {
  enforceBridgeApiKeyIfRequired,
  passesCaiApplicationInboundAuth,
  pathRequiresBridgeApiKey,
  remoteUserPermIsUnauthorized,
} from "./bridge-api-auth.js";
import type { BridgeConfig } from "./config.js";

function mockReq(headers: http.IncomingHttpHeaders): http.IncomingMessage {
  return { headers } as http.IncomingMessage;
}

describe("remoteUserPermIsUnauthorized", () => {
  it("detects explicit Unauthorized when both headers are present", () => {
    expect(
      remoteUserPermIsUnauthorized(
        mockReq({
          "remote-user": "alice",
          "remote-user-perm": "Unauthorized",
        }),
      ),
    ).toBe(true);
    expect(
      remoteUserPermIsUnauthorized(
        mockReq({
          "remote-user": "alice",
          "remote-user-perm": "admin",
        }),
      ),
    ).toBe(false);
    expect(remoteUserPermIsUnauthorized(mockReq({ "remote-user": "alice" }))).toBe(
      false,
    );
  });
});

describe("passesCaiApplicationInboundAuth", () => {
  it("passes when CAI application auth is required (bypass false)", () => {
    expect(passesCaiApplicationInboundAuth(false)).toBe(true);
    expect(passesCaiApplicationInboundAuth(true)).toBe(false);
  });
});

describe("enforceBridgeApiKeyIfRequired remote-user bypass", () => {
  const configBypass = {
    requiredKey: "secret",
    cdswBypassAuthentication: true,
  } as BridgeConfig;
  const configCaiAuth = {
    requiredKey: "secret",
    cdswBypassAuthentication: false,
  } as BridgeConfig;

  it("allows /v1 without API key when CAI auth is required", () => {
    const req = mockReq({
      "remote-user": "bob",
      "remote-user-perm": "read",
    });
    const res = {
      writeHead: () => {},
      end: () => {},
    } as unknown as http.ServerResponse;
    const ok = enforceBridgeApiKeyIfRequired(
      req,
      res,
      configCaiAuth,
      "/v1/models",
    );
    expect(ok).toBe(true);
  });

  it("allows /v1 without API key or remote-user headers when CAI auth is required", () => {
    const req = mockReq({});
    const res = {
      writeHead: () => {},
      end: () => {},
    } as unknown as http.ServerResponse;
    const ok = enforceBridgeApiKeyIfRequired(
      req,
      res,
      configCaiAuth,
      "/v1/models",
    );
    expect(ok).toBe(true);
  });

  it("still requires API key when bypass_authentication is true despite remote-user headers", () => {
    const req = mockReq({
      "remote-user": "bob",
      "remote-user-perm": "read",
    });
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: () => {},
    } as unknown as http.ServerResponse;
    const ok = enforceBridgeApiKeyIfRequired(
      req,
      res,
      configBypass,
      "/v1/models",
    );
    expect(ok).toBe(false);
    expect(status).toBe(401);
  });

  it("rejects immediately when remote-user-perm is Unauthorized", () => {
    const req = mockReq({
      authorization: "Bearer secret",
      "remote-user": "bob",
      "remote-user-perm": "Unauthorized",
    });
    let status = 0;
    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: () => {},
    } as unknown as http.ServerResponse;
    const ok = enforceBridgeApiKeyIfRequired(
      req,
      res,
      configCaiAuth,
      "/v1/models",
    );
    expect(ok).toBe(false);
    expect(status).toBe(401);
  });
});

describe("pathRequiresBridgeApiKey", () => {
  it("requires key for OpenAI and Anthropic API paths", () => {
    expect(pathRequiresBridgeApiKey("/v1/models")).toBe(true);
    expect(pathRequiresBridgeApiKey("/v1/chat/completions")).toBe(true);
    expect(pathRequiresBridgeApiKey("/v1/messages")).toBe(true);
    expect(pathRequiresBridgeApiKey("/health")).toBe(true);
  });

  it("does not require key for dashboard, chat, or plugins", () => {
    expect(pathRequiresBridgeApiKey("/")).toBe(false);
    expect(pathRequiresBridgeApiKey("/chat")).toBe(false);
    expect(pathRequiresBridgeApiKey("/plugins")).toBe(false);
    expect(pathRequiresBridgeApiKey("/api/plugins/catalog")).toBe(false);
    expect(pathRequiresBridgeApiKey("/api/plugins/mcp-login")).toBe(false);
    expect(pathRequiresBridgeApiKey("/api/status")).toBe(false);
    expect(pathRequiresBridgeApiKey("/healthz")).toBe(false);
  });
});
