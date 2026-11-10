import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { startBridgeServer } from "./server.js";
import { appendSessionLine } from "./request-log.js";
import { run, runStreaming } from "./process.js";
import type { BridgeConfig } from "./config.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([
    { id: "claude-3-opus", name: "Claude 3 Opus" },
    { id: "claude-3-sonnet", name: "Claude 3 Sonnet" },
    { id: "gpt-5.6-sol-low", name: "GPT-5.6 Sol Low" },
    { id: "gpt-5.6-sol-high", name: "GPT-5.6 Sol High" },
  ]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({
    code: 0,
    stdout: "Hello from agent",
    stderr: "",
  }),
  runStreaming: vi.fn().mockImplementation((_cmd, _args, opts) => {
    // Simulate streaming response
    if (opts.onLine) {
      opts.onLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "Hello" }] },
        }),
      );
      opts.onLine(JSON.stringify({ type: "result", subtype: "success" }));
    }
    return Promise.resolve({ code: 0, stderr: "" });
  }),
}));

vi.mock("./request-log.js", () => ({
  logIncoming: vi.fn(),
  logTrafficRequest: vi.fn(),
  logTrafficResponse: vi.fn(),
  logModelResolution: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

const tmpLogPath = "/tmp/cursor-proxy-test-sessions.log";

function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0, // Let OS assign a free port
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: tmpLogPath,
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    verboseFull: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: overrides.configDirs ?? [],
    multiPort: overrides.multiPort ?? false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    authKeepalive: {
      enabled: false,
      intervalMs: 240_000,
      skewSec: 300,
      mode: "refresh",
    },
    appSegment: "cursor-agent",
    ...overrides,
  };
}

async function fetchServer(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string }> {
  const port = (server.address() as { port: number })?.port;
  const url = `http://127.0.0.1:${port}${path}`;

  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("startBridgeServer", () => {
  let servers: (http.Server | https.Server)[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
  });

  it("responds 200 on GET /health", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(servers[0], "/health");
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.ok).toBe(true);
    expect(data.version).toBe("1.0.0");
    expect(data.defaultModel).toBe("default");
    expect(data.mode).toBe("ask");
    expect(data.perRequestMode).toBe(true);
  });

  it("responds 200 on GET /v1/models", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(servers[0], "/v1/models");
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("list");
    expect(data.data).toHaveLength(4);
    expect(data.data[0].id).toBe("claude-3-opus");
  });

  it("returns 401 when requiredKey is set and Authorization is missing", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status, body } = await fetchServer(servers[0], "/health");
    expect(status).toBe(401);
    const data = JSON.parse(body);
    expect(data.error.message).toBe("Invalid API key");
  });

  it("GET /healthz bypasses requiredKey", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status, body } = await fetchServer(servers[0], "/healthz");
    expect(status).toBe(200);
    expect(body).toBe("ok\n");
  });

  it("serves dashboard GET / without Authorization when requiredKey is set", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status, body } = await fetchServer(servers[0], "/");
    expect(status).toBe(200);
    expect(body).toMatch(/Redirecting|cursor-agent/);
  });

  it("GET /api/agent-auth reports unauthenticated without API key or accounts", async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    const prevToken = process.env.CURSOR_AUTH_TOKEN;
    const prevHome = process.env.HOME;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cap-auth-"));

    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ configDirs: [] }),
    });

    const { status, body } = await fetchServer(servers[0], "/api/agent-auth");
    expect(status).toBe(200);
    const auth = JSON.parse(body) as { authenticated: boolean; viaApiKey: boolean };
    expect(auth.authenticated).toBe(false);
    expect(auth.viaApiKey).toBe(false);

    if (prevKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prevKey;
    if (prevToken === undefined) delete process.env.CURSOR_AUTH_TOKEN;
    else process.env.CURSOR_AUTH_TOKEN = prevToken;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it("serves GET /chat without Authorization when requiredKey is set", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status, body } = await fetchServer(servers[0], "/chat");
    expect(status).toBe(200);
    expect(body).toContain("chat-app.js");
  });

  it("serves GET /plugins and plugin API without Authorization when requiredKey is set", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const page = await fetchServer(servers[0], "/plugins");
    expect(page.status).toBe(200);
    expect(page.body).toContain("plugins-app.js");

    const marketplaces = await fetchServer(servers[0], "/api/plugins/marketplaces");
    expect(marketplaces.status).toBe(200);
    expect(JSON.parse(marketplaces.body).marketplaces).toBeDefined();

    const sync = await fetchServer(servers[0], "/api/plugins/sync-cli-cache", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(sync.status).toBe(200);
    expect(JSON.parse(sync.body).imported).toBeDefined();

    const mcpLogin = await fetchServer(servers[0], "/api/plugins/mcp-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ marketplaceId: "missing", name: "plugin" }),
    });
    expect(mcpLogin.status).not.toBe(401);
    expect(mcpLogin.status).toBe(404);
  });

  it("serves GET /api/upstream-sync without Authorization when requiredKey is set", async () => {
    vi.stubEnv("CURSOR_BRIDGE_UPSTREAM_SYNC", "");
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const res = await fetchServer(servers[0], "/api/upstream-sync");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body) as { options: { enabled: boolean } };
    expect(data.options.enabled).toBe(false);
  });

  it("GET /api/agent/models bypasses requiredKey", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status, body } = await fetchServer(servers[0], "/api/agent/models");
    expect(status).toBe(200);
    expect(JSON.parse(body).object).toBe("list");
  });

  it("POST /api/agent/chat bypasses requiredKey and reaches the agent", async () => {
    const accountDir = "/tmp/cursor-proxy-test-account";
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        requiredKey: "secret123",
        configDirs: [accountDir],
      }),
    });

    const { status, body } = await fetchServer(servers[0], "/api/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "default",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
        accountConfigDir: accountDir,
      }),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].message.content).toBe("Hello from agent");
  });

  it("does not append session logs for dashboard /api/status and /api/log polling", async () => {
    const appendSessionLineMock = vi.mocked(appendSessionLine);
    appendSessionLineMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const statusRes = await fetchServer(servers[0], "/api/status");
    expect(statusRes.status).toBe(200);

    const logRes = await fetchServer(servers[0], "/api/log");
    expect(logRes.status).toBe(200);

    // finish handlers run after response completion; flush microtasks before assert.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(appendSessionLineMock).not.toHaveBeenCalled();
  });

  it("POST /api/log/clear archives and truncates sessions log", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    // Ensure starting state.
    try {
      fs.unlinkSync(tmpLogPath);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(
      tmpLogPath,
      [
        `${new Date("2026-01-01T00:00:00.000Z").toISOString()} GET /v1/chat/completions ::1 200`,
        `${new Date("2026-01-01T00:00:01.000Z").toISOString()} GET /health ::1 200`,
      ].join("\n") + "\n",
      "utf8",
    );

    const { status, body } = await fetchServer(servers[0], "/api/log/clear", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(typeof data.archivePath).toBe("string");
    expect(fs.existsSync(data.archivePath)).toBe(true);

    const archived = fs.readFileSync(data.archivePath, "utf8");
    expect(archived).toContain("GET /v1/chat/completions");

    const live = fs.readFileSync(tmpLogPath, "utf8");
    expect(live).toBe("");

    // Clean up archive so other tests won't see it.
    try {
      fs.unlinkSync(data.archivePath);
    } catch {
      /* ignore */
    }

    try {
      fs.unlinkSync(tmpLogPath);
    } catch {
      /* ignore */
    }
  });

  it("returns 200 when requiredKey matches Authorization", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status } = await fetchServer(servers[0], "/health", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(status).toBe(200);
  });

  it("accepts x-api-key when requiredKey is set (Claude Code)", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status } = await fetchServer(servers[0], "/health", {
      headers: { "x-api-key": "secret123" },
    });
    expect(status).toBe(200);
  });

  it("returns Anthropic-shaped 401 for /v1/messages when key is wrong", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ requiredKey: "secret123" }),
    });

    const { status, body } = await fetchServer(servers[0], "/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3-opus", max_tokens: 16, messages: [] }),
      headers: { "content-type": "application/json", "x-api-key": "wrong" },
    });
    expect(status).toBe(401);
    const data = JSON.parse(body);
    expect(data.type).toBe("error");
    expect(data.error.type).toBe("authentication_error");
  });

  it("POST /v1/messages/count_tokens returns input_tokens without calling the agent", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/messages/count_tokens",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hello" }],
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(typeof data.input_tokens).toBe("number");
    expect(data.input_tokens).toBeGreaterThan(0);
  });

  it("returns 404 for unknown path", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(servers[0], "/unknown");
    expect(status).toBe(404);
    const data = JSON.parse(body);
    expect(data.error.code).toBe("not_found");
  });

  it("returns 200 for POST /v1/completions (non-streaming)", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(servers[0], "/v1/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        prompt: "function add(a, b) {\n  ",
      }),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("text_completion");
    expect(data.choices[0].text).toBe("Hello from agent");
  });

  it("returns 200 for POST /v1/chat/completions (non-streaming)", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("chat.completion");
    expect(data.choices[0].message.content).toBe("Hello from agent");
  });

  it("returns OpenAI Responses shape for POST /v1/responses", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        instructions: "Be helpful.",
        input: "Hi",
      }),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.object).toBe("response");
    expect(data.status).toBe("completed");
    expect(data.output[0].type).toBe("message");
    expect(data.output[0].content[0].type).toBe("output_text");
    expect(data.output[0].content[0].text).toBe("Hello from agent");
    expect(data.output_text).toBe("Hello from agent");
    expect(data.usage.input_tokens).toBeGreaterThan(0);
    expect(data.usage.output_tokens).toBeGreaterThan(0);
  });

  it("maps Chat Completions reasoning_effort to a Cursor model variant", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).toContain("gpt-5.6-sol-high");
  });

  it("maps Responses reasoning.effort to a Cursor model variant", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        reasoning: { effort: "low" },
        input: "Hi",
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).toContain("gpt-5.6-sol-low");
  });

  it("rejects reasoning effort unavailable for the model family", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          reasoning_effort: "max",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(400);
    expect(JSON.parse(body).error.code).toBe("unsupported_reasoning_effort");
  });

  it("streams OpenAI Responses semantic SSE events", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        input: "Hi",
        stream: true,
      }),
    });
    expect(status).toBe(200);
    expect(body).toContain("event: response.created");
    expect(body).toContain("event: response.output_text.delta");
    expect(body).toContain('"delta":"Hello"');
    expect(body).toContain("event: response.completed");
    expect(body).toContain("data: [DONE]");
  });

  it("keeps the prompt out of argv and passes it via stdin when promptViaStdin is true (non-streaming)", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ promptViaStdin: true }),
    });

    const marker = "UNIQUE_PROMPT_MARKER_argv_e2big";
    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [{ role: "user", content: marker }],
      }),
    });
    expect(status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = runMock.mock.calls[0];
    // Prompt must NOT be in argv (would blow ARG_MAX / spawn E2BIG on long prompts).
    expect(args.some((a: string) => a.includes(marker))).toBe(false);
    // Prompt must be delivered via stdin instead.
    expect(opts?.stdinContent).toContain(marker);
  });

  it("appends the prompt to argv (no stdin) when promptViaStdin is false (non-streaming)", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ promptViaStdin: false }),
    });

    const marker = "UNIQUE_PROMPT_MARKER_argv_default";
    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [{ role: "user", content: marker }],
      }),
    });
    expect(status).toBe(200);
    expect(runMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = runMock.mock.calls[0];
    expect(args.some((a: string) => a.includes(marker))).toBe(true);
    expect(opts?.stdinContent).toBeUndefined();
  });

  it("returns display model when request is default and defaultModel is set", async () => {
    servers = await startBridgeServer({
      version: "0.1.0",
      config: createTestConfig({ defaultModel: "composer-1.5" }),
    });

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.model).toBe("composer-1.5");
  });

  it("echoes default when request is default and defaultModel is unset", async () => {
    servers = await startBridgeServer({
      version: "0.1.0",
      config: createTestConfig({ defaultModel: "default" }),
    });

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "default",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.model).toBe("default");
  });

  it("returns 400 for invalid body.mode on POST /v1/chat/completions", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });

    const { status, body } = await fetchServer(
      servers[0],
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-opus",
          mode: "bogus",
          messages: [{ role: "user", content: "Hi" }],
        }),
      },
    );
    expect(status).toBe(400);
    const data = JSON.parse(body);
    expect(data.error.code).toBe("invalid_mode");
  });

  it("maps a DSH plan system prompt to Cursor plan mode", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ dshAutoMode: true }),
    });

    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [
          {
            role: "system",
            content:
              "You are an AI agent powered by DeepSeek Harness.\nYou are in plan mode.",
          },
          { role: "user", content: "Plan this" },
        ],
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).toContain("--mode");
    expect(args).toContain("plan");
  });

  it("maps a normal DSH system prompt to Cursor agent mode", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ dshAutoMode: true }),
    });

    const { status } = await fetchServer(servers[0], "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        messages: [
          {
            role: "system",
            content: "You are an AI agent powered by DeepSeek Harness.",
          },
          { role: "user", content: "Do this" },
        ],
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).not.toContain("--mode");
  });

  it("infers DSH plan mode for the Responses API", async () => {
    const runMock = vi.mocked(run);
    runMock.mockClear();
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({ dshAutoMode: true }),
    });

    const { status } = await fetchServer(servers[0], "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-opus",
        instructions:
          "You are an AI agent powered by DeepSeek Harness.\nYou are in plan mode.",
        input: "Plan this",
      }),
    });
    expect(status).toBe(200);
    const [, args] = runMock.mock.calls[0];
    expect(args).toContain("--mode");
    expect(args).toContain("plan");
  });

  it("should spawn multiple servers when multiPort is true", async () => {
    servers = await startBridgeServer({
      version: "1.0.0",
      config: createTestConfig({
        configDirs: ["/dir1", "/dir2"],
        multiPort: true,
        port: 10000,
      }),
    });

    expect(servers.length).toBe(2);


    const res1 = await fetchServer(servers[0], "/health");
    const res2 = await fetchServer(servers[1], "/health");

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });
});
