import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { EnvSource } from "./env.js";
import { validateAppSegment } from "./http-public-path.js";

const DEFAULT_SEGMENT = "cursor-agent";
const PERSIST_BASENAME = ".bridge-app-segment";

function caiDeployment(): boolean {
  const env = process.env;
  return Boolean(
    env.CDSW_API_KEY?.trim() ||
      env.CDSW_APP_PORT?.trim() ||
      env.CDSW_PUBLIC_PORT?.trim() ||
      env.CDSW_READONLY_PORT?.trim(),
  );
}

function randomAgentSegment(): string {
  const bytes = crypto.randomBytes(4);
  const hex = bytes.toString("hex");
  return `agent-${hex.slice(0, 6)}`;
}

function readPersisted(storageDir: string): string | undefined {
  const file = path.join(storageDir, PERSIST_BASENAME);
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      validateAppSegment(raw);
      return raw;
    }
  } catch {
    /* no file */
  }
  return undefined;
}

function writePersisted(storageDir: string, segment: string): void {
  try {
    fs.mkdirSync(storageDir, { recursive: true });
    const file = path.join(storageDir, PERSIST_BASENAME);
    fs.writeFileSync(file, `${segment}\n`, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/**
 * Resolve the public app path segment (stable across restarts via persist file).
 */
export function resolveAppSegment(
  sessionsLogPath: string,
  env: EnvSource = process.env,
): string {
  const explicit = env.CURSOR_BRIDGE_APP_SEGMENT?.trim();
  if (explicit) {
    validateAppSegment(explicit);
    return explicit;
  }

  const storageDir = path.dirname(path.resolve(sessionsLogPath));
  const persisted = readPersisted(storageDir);
  if (persisted) return persisted;

  const segment = caiDeployment() ? randomAgentSegment() : DEFAULT_SEGMENT;
  validateAppSegment(segment);
  writePersisted(storageDir, segment);
  return segment;
}
