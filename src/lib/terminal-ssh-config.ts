import * as fs from "node:fs";
import * as os from "node:os";

import type { EnvSource } from "./env.js";

export type TerminalSshConfig = {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  /** PEM private key material, if resolved. */
  privateKey?: string;
  password?: string;
  /** OpenSSH agent socket (ssh2 `agent`), e.g. CDSW `SSH_AUTH_SOCK`. */
  agent?: string;
};

function envString(env: EnvSource, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

function envBool(env: EnvSource, keys: string[], defaultValue: boolean): boolean {
  const raw = envString(env, keys);
  if (raw === undefined) return defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
}

function envPort(env: EnvSource, keys: string[], defaultValue: number): number {
  const raw = envString(env, keys);
  if (!raw) return defaultValue;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : defaultValue;
}

function readKeyFile(path: string): string | undefined {
  try {
    const st = fs.statSync(path);
    if (!st.isFile()) return undefined;
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function resolveSshAgentSocket(env: EnvSource): string | undefined {
  const explicit = envString(env, ["CURSOR_BRIDGE_TERMINAL_SSH_AGENT"]);
  const sock =
    explicit && !/^(0|false|no|off)$/i.test(explicit)
      ? explicit
      : envString(env, ["SSH_AUTH_SOCK"]);
  if (!sock) return undefined;
  try {
    const st = fs.statSync(sock);
    if (st.isSocket()) return sock;
  } catch {
    /* ignore */
  }
  return undefined;
}

function resolvePrivateKey(env: EnvSource): string | undefined {
  const inline = envString(env, ["CURSOR_BRIDGE_TERMINAL_SSH_PRIVATE_KEY"]);
  if (inline) return inline.replace(/\\n/g, "\n");

  const keyPath = envString(env, ["CURSOR_BRIDGE_TERMINAL_SSH_KEY"]);
  if (keyPath) return readKeyFile(keyPath);

  const home = envString(env, ["HOME", "USERPROFILE"]) ?? os.homedir();
  for (const name of ["id_ed25519", "id_rsa"]) {
    const material = readKeyFile(`${home}/.ssh/${name}`);
    if (material) return material;
  }
  return undefined;
}

export function loadTerminalSshConfig(
  env: EnvSource = process.env,
): TerminalSshConfig {
  const port = envPort(env, ["CURSOR_BRIDGE_TERMINAL_SSH_PORT"], 2222);
  const enabled = envBool(env, ["CURSOR_BRIDGE_TERMINAL"], port > 0);
  const host =
    envString(env, ["CURSOR_BRIDGE_TERMINAL_SSH_HOST"]) ?? "127.0.0.1";
  const username =
    envString(env, ["CURSOR_BRIDGE_TERMINAL_SSH_USER"]) ??
    envString(env, ["USER", "LOGNAME", "USERNAME"]) ??
    "root";
  const password = envString(env, ["CURSOR_BRIDGE_TERMINAL_SSH_PASSWORD"]);
  const privateKey = resolvePrivateKey(env);
  const agent = resolveSshAgentSocket(env);

  return {
    enabled: enabled && port > 0,
    host,
    port,
    username,
    privateKey,
    password,
    agent,
  };
}
