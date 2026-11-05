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

export function defaultModelRouterConfigPath(sessionsLogPath: string): string {
  return path.join(path.dirname(sessionsLogPath), "model-router.json");
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
