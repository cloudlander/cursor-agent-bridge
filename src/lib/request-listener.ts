import * as fs from "node:fs";
import * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import type { AcpModelCacheRef } from "./acp-model-catalog.js";
import type { ModelCacheRef } from "./handlers/models.js";
import { enforceBridgeApiKeyIfRequired } from "./bridge-api-auth.js";
import { handleHealth } from "./handlers/health.js";
import { handleModels } from "./handlers/models.js";
import { handleChatCompletions } from "./handlers/chat-completions.js";
import { handleCompletions } from "./handlers/completions.js";
import { handleResponses } from "./handlers/responses.js";
import { handleAnthropicMessages } from "./handlers/anthropic-messages.js";
import {
  adminDashboardMatches,
  handleAdminDashboard,
} from "./admin-dashboard.js";
import { handleAnthropicCountTokens } from "./handlers/anthropic-count-tokens.js";
import { json, readBody } from "./http.js";
import { applyBridgeIncomingPath } from "./bridge-incoming-path.js";
import { appendSessionLine, logIncoming } from "./request-log.js";
import type { ToolSessionRegistry } from "./tool-session-registry.js";

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
};

export type BridgeRequestRuntime = {
  toolSessions: ToolSessionRegistry;
};

export function createRequestListener(
  opts: BridgeServerOptions,
  runtime: BridgeRequestRuntime,
) {
  const { config } = opts;
  const modelCacheRef: ModelCacheRef = { current: undefined };
  const acpModelCacheRef: AcpModelCacheRef = { current: undefined };
  const lastRequestedModelRef: { current?: string } = {};

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const protocol = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
    const url = new URL(
      req.url || "/",
      `${protocol}://${req.headers.host || "localhost"}`,
    );
    const remoteAddress = req.socket?.remoteAddress ?? "unknown";
    const method = req.method ?? "?";
    let pathname = url.pathname;

    const pathPhase = applyBridgeIncomingPath(req, config, res);
    if (pathPhase.kind === "healthz") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
      } else {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("method not allowed\n");
      }
      return;
    }
    if (
      pathPhase.kind === "bootstrap" ||
      pathPhase.kind === "not_found"
    ) {
      return;
    }

    const urlAfter = new URL(
      req.url || "/",
      `${protocol}://${req.headers.host || "localhost"}`,
    );
    pathname = urlAfter.pathname;

    // Skip request logging for the admin dashboard's own traffic
    // (status/log/stats polls, asset loads, control actions). These are
    // self-referential noise that pollutes the live log tail the dashboard
    // reads from the sessions log file.
    const isAdminDashboardReq = adminDashboardMatches(req, config);

    if (!isAdminDashboardReq) {
      logIncoming(method, pathname, remoteAddress);
      res.on("finish", () => {
        appendSessionLine(
          config.sessionsLogPath,
          method,
          pathname,
          remoteAddress,
          res.statusCode,
        );
      });
    }

    try {
      if (req.method === "GET" && pathname === "/api/agent/models") {
        await handleModels(res, {
          config,
          modelCacheRef,
          acpModelCacheRef,
          filterForAcpCatalog: true,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/api/agent/chat") {
        const raw = await readBody(req);
        await handleChatCompletions(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (isAdminDashboardReq) {
        handleAdminDashboard(req, res, opts);
        return;
      }

      if (!enforceBridgeApiKeyIfRequired(req, res, config, pathname)) {
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        handleHealth(res, { version: opts.version, config });
        return;
      }

      if (req.method === "GET" && pathname === "/v1/models") {
        await handleModels(res, { config, modelCacheRef });
        return;
      }

      if (req.method === "POST" && pathname === "/v1/completions") {
        const raw = await readBody(req);
        await handleCompletions(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        await handleChatCompletions(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/responses") {
        const raw = await readBody(req);
        await handleResponses(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        const raw = await readBody(req);
        handleAnthropicCountTokens(res, raw);
        return;
      }

      if (req.method === "POST" && pathname === "/v1/messages") {
        const raw = await readBody(req);
        await handleAnthropicMessages(
          req,
          res,
          {
            config,
            lastRequestedModelRef,
            modelCacheRef,
            toolSessions: runtime.toolSessions,
          },
          raw,
          method,
          pathname,
          remoteAddress,
        );
        return;
      }

      if (pathname === "/v1/embeddings") {
        json(res, 404, {
          error: {
            message: "Embeddings are not supported by this proxy.",
            code: "not_found",
          },
        });
      } else {
        json(res, 404, { error: { message: "Not found", code: "not_found" } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Proxy error: ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      try {
        fs.appendFileSync(
          config.sessionsLogPath,
          `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} ${msg.slice(0, 200).replace(/\n/g, " ")}\n`,
        );
      } catch {
        /* ignore */
      }
      if (!res.headersSent) {
        json(res, 500, {
          error: { message: msg, code: "internal_error" },
        });
      } else {
        res.end();
      }
    }
  };
}
