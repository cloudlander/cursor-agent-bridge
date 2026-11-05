import * as fs from "node:fs";
import * as path from "node:path";

export type ModelRouterRoute = {
  model: string;
  when: string;
};

export type ModelRouterTable = {
  routes: ModelRouterRoute[];
};

export const MODEL_ROUTER_MAX_ROUTES = 5;

/** Shipped default route table (also committed as repo-root `model-router.json`). */
export const DEFAULT_MODEL_ROUTER_TABLE: ModelRouterTable = {
  routes: [
    {
      model: "composer-2.5",
      when: "Small, localized changes: typo fixes, single-file edits, adding a unit test, explaining a short code snippet, or formatting and comment-only updates where speed matters more than deep reasoning.",
    },
    {
      model: "claude-4.6-sonnet-medium",
      when: "Everyday feature work in one or two modules: implement an API endpoint, fix a regression with a clear stack trace, write integration tests, or refactor a class without changing system-wide architecture.",
    },
    {
      model: "claude-4.6-sonnet-medium-thinking",
      when: "Multi-step problems that need visible reasoning: design a data model and migration plan, compare two implementation approaches with tradeoffs, debug intermittent failures from logs, or plan a feature before coding.",
    },
    {
      model: "claude-opus-5-5-high",
      when: "Large or cross-cutting code changes: refactor across many packages, reconcile conflicting patterns, performance work that touches hot paths, or subtle bugs that span services, configs, and tests.",
    },
    {
      model: "claude-opus-5-thinking-max",
      when: "Highest-complexity work: greenfield system architecture, security-sensitive flows, distributed-system failure modes, or open-ended research where the agent must explore alternatives before committing to a design.",
    },
  ],
};

export function defaultModelRouterConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, "model-router.json");
}

/**
 * When the router config file is missing, seed the workspace copy from
 * `DEFAULT_MODEL_ROUTER_TABLE` (does not overwrite an existing file).
 */
export function ensureModelRouterConfigFile(configPath: string): void {
  if (fs.existsSync(configPath)) return;
  saveModelRouterTable(configPath, DEFAULT_MODEL_ROUTER_TABLE);
}

export function loadModelRouterTable(configPath: string): ModelRouterTable {
  if (!fs.existsSync(configPath)) {
    return { routes: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid model router config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid model router config at ${configPath}: expected object`);
  }
  const routesRaw = (raw as { routes?: unknown }).routes;
  if (!Array.isArray(routesRaw)) {
    throw new Error(
      `Invalid model router config at ${configPath}: "routes" must be an array`,
    );
  }
  if (routesRaw.length > MODEL_ROUTER_MAX_ROUTES) {
    throw new Error(
      `Model router config at ${configPath} has ${routesRaw.length} routes; at most ${MODEL_ROUTER_MAX_ROUTES} are allowed`,
    );
  }
  const routes: ModelRouterRoute[] = [];
  for (const entry of routesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const model = String((entry as { model?: unknown }).model ?? "").trim();
    const when = String((entry as { when?: unknown }).when ?? "").trim();
    if (!model || !when) continue;
    routes.push({ model, when });
  }
  return { routes };
}

export function validateModelRouterTableAtStartup(
  configPath: string,
  enabled: boolean,
): ModelRouterTable {
  if (!enabled) return { routes: [] };
  return loadModelRouterTable(configPath);
}

/** Validates and writes the route table (creates parent dirs). */
export function saveModelRouterTable(
  configPath: string,
  table: ModelRouterTable,
): void {
  if (table.routes.length > MODEL_ROUTER_MAX_ROUTES) {
    throw new Error(
      `At most ${MODEL_ROUTER_MAX_ROUTES} routes are allowed (got ${table.routes.length})`,
    );
  }
  const normalized: ModelRouterTable = {
    routes: table.routes.map((r) => ({
      model: r.model.trim(),
      when: r.when.trim(),
    })),
  };
  for (const route of normalized.routes) {
    if (!route.model || !route.when) {
      throw new Error('Each route must include non-empty "model" and "when"');
    }
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf-8",
  );
}
