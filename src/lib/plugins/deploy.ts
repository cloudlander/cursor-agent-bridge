import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BridgeConfig } from "../config.js";
import { rewriteBridgeRemoteMcpUrl } from "./bridge-mcp-url.js";
import {
  analyzePlugin,
  collectVariables,
  PLUGIN_ROOT_VARS,
  type McpServerDef,
  type PluginContents,
} from "./manifest.js";
import {
  ApiError,
  pluginPaths,
  writeFileAtomic,
  type DeployedItems,
  type InstalledPlugin,
  type PluginConfig,
  type ServerOverride,
} from "./store.js";

const PROXY_MARKER = ".cursor-api-proxy-owner";

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: false,
    filter: (src) => path.basename(src) !== ".git",
  });
}

function rmSafe(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function defaultCursorConfigDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".cursor");
}

/** Cursor config directories that should receive deployed plugin files. */
export function resolveDeployTargets(config: BridgeConfig): string[] {
  const dirs = new Set<string>();
  dirs.add(pluginPaths(config).runtimeDir);
  for (const d of config.configDirs) {
    if (d.trim()) dirs.add(path.resolve(d.trim()));
  }
  dirs.add(defaultCursorConfigDir());
  return [...dirs];
}

function readOwnerMarker(p: string): string | undefined {
  const f = path.join(p, PROXY_MARKER);
  try {
    return fs.readFileSync(f, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeOwnerMarker(dir: string, pluginId: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PROXY_MARKER), `${pluginId}\n`, "utf8");
}

function substituteValue(
  value: string,
  pluginRoot: string,
  cfg: PluginConfig,
): string {
  let out = value;
  for (const v of PLUGIN_ROOT_VARS) {
    out = out.replaceAll(`\${${v}}`, pluginRoot);
    out = out.replaceAll(`\${env:${v}}`, pluginRoot);
  }
  for (const [k, v] of Object.entries(cfg.env)) {
    out = out.replaceAll(`\${env:${k}}`, v);
    out = out.replaceAll(`\${${k}}`, v);
  }
  if (out.startsWith("./")) {
    out = path.join(pluginRoot, out.slice(2));
  }
  return out;
}

function substituteDeep(
  value: unknown,
  pluginRoot: string,
  cfg: PluginConfig,
): unknown {
  if (typeof value === "string") return substituteValue(value, pluginRoot, cfg);
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v, pluginRoot, cfg));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteDeep(v, pluginRoot, cfg);
    return out;
  }
  return value;
}

function mcpKey(plugin: InstalledPlugin, serverName: string): string {
  return `plugin-${plugin.name}-${serverName}`;
}

function buildMcpEntry(
  plugin: InstalledPlugin,
  pluginRoot: string,
  serverName: string,
  def: McpServerDef,
  ov?: ServerOverride,
): McpServerDef | null {
  if (ov?.disabled) return null;
  const merged = substituteDeep(
    JSON.parse(JSON.stringify(def)),
    pluginRoot,
    plugin.config,
  ) as McpServerDef;
  if (ov?.url && typeof merged.url === "string") merged.url = ov.url;
  if (typeof merged.url === "string" && !ov?.url) {
    merged.url = rewriteBridgeRemoteMcpUrl(merged.url);
  }
  if (merged.command && typeof merged.command === "string") {
    merged.command = substituteValue(String(merged.command), pluginRoot, plugin.config);
  }
  if (Array.isArray(merged.args)) {
    merged.args = merged.args.map((a) =>
      typeof a === "string" ? substituteValue(a, pluginRoot, plugin.config) : a,
    );
  }
  const env =
    merged.env && typeof merged.env === "object" && !Array.isArray(merged.env)
      ? { ...(merged.env as Record<string, string>) }
      : {};
  for (const [k, v] of Object.entries(plugin.config.env)) env[k] = v;
  if (ov?.env) Object.assign(env, ov.env);
  if (Object.keys(env).length) merged.env = env;

  const headers =
    merged.headers && typeof merged.headers === "object" && !Array.isArray(merged.headers)
      ? { ...(merged.headers as Record<string, string>) }
      : {};
  for (const [k, v] of Object.entries(plugin.config.headers)) headers[k] = v;
  if (ov?.headers) Object.assign(headers, ov.headers);
  if (Object.keys(headers).length) merged.headers = headers;

  if (ov?.auth && typeof merged.auth === "object" && merged.auth) {
    merged.auth = { ...(merged.auth as Record<string, unknown>), ...ov.auth };
  } else if (ov?.auth) merged.auth = ov.auth;

  return merged;
}

function readMcpJson(configDir: string): Record<string, McpServerDef> {
  const file = path.join(configDir, "mcp.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const map =
    raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : raw;
  const out: Record<string, McpServerDef> = {};
  if (map && typeof map === "object") {
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v as McpServerDef;
    }
  }
  return out;
}

function writeMcpJson(configDir: string, servers: Record<string, McpServerDef>): void {
  const file = path.join(configDir, "mcp.json");
  const body = JSON.stringify({ mcpServers: servers }, null, 2);
  writeFileAtomic(file, body, 0o600);
}

function deploySkills(
  plugin: InstalledPlugin,
  contents: PluginContents,
  configDir: string,
  warnings: string[],
): string[] {
  const skillsRoot = path.join(configDir, "skills");
  fs.mkdirSync(skillsRoot, { recursive: true });
  const deployed: string[] = [];
  for (const sk of contents.skills) {
    const dest = path.join(skillsRoot, sk.dirName);
    const owner = readOwnerMarker(dest);
    if (fs.existsSync(dest) && owner && owner !== plugin.id) {
      warnings.push(`skill ${sk.dirName} owned by ${owner}; skipped`);
      continue;
    }
    if (fs.existsSync(dest)) rmSafe(dest);
    copyTree(sk.dir, dest);
    writeOwnerMarker(dest, plugin.id);
    deployed.push(sk.dirName);
  }
  return deployed;
}

function deployFlatFiles(
  plugin: InstalledPlugin,
  items: { name: string; file: string }[],
  sub: "commands" | "agents",
  configDir: string,
  warnings: string[],
): string[] {
  const root = path.join(configDir, sub);
  fs.mkdirSync(root, { recursive: true });
  const deployed: string[] = [];
  for (const item of items) {
    const ext = path.extname(item.file);
    const dest = path.join(root, `${item.name}${ext}`);
    const ownerDir = path.dirname(dest);
    const marker = path.join(ownerDir, PROXY_MARKER);
    if (fs.existsSync(dest)) {
      try {
        const prev = fs.readFileSync(marker, "utf8").trim();
        if (prev && prev !== plugin.id) {
          warnings.push(`${sub}/${item.name} owned by ${prev}; skipped`);
          continue;
        }
      } catch {
        warnings.push(`${sub}/${item.name} exists; skipped`);
        continue;
      }
    }
    fs.copyFileSync(item.file, dest);
    fs.writeFileSync(marker, `${plugin.id}\n`, "utf8");
    deployed.push(`${sub}/${item.name}${ext}`);
  }
  return deployed;
}

function deployMcp(
  plugin: InstalledPlugin,
  contents: PluginContents,
  pluginRoot: string,
  configDir: string,
): string[] {
  const existing = readMcpJson(configDir);
  const keys: string[] = [];
  for (const [name, def] of Object.entries(contents.mcpServers)) {
    const key = mcpKey(plugin, name);
    const built = buildMcpEntry(
      plugin,
      pluginRoot,
      name,
      def,
      plugin.config.servers[name],
    );
    if (!built) continue;
    existing[key] = built;
    keys.push(key);
  }
  writeMcpJson(configDir, existing);
  return keys;
}

function undeployFromTarget(plugin: InstalledPlugin, configDir: string, deployed?: DeployedItems): void {
  if (!deployed) return;
  const skillsRoot = path.join(configDir, "skills");
  for (const name of deployed.skills) {
    const dest = path.join(skillsRoot, name);
    if (readOwnerMarker(dest) === plugin.id) rmSafe(dest);
  }
  for (const rel of [...deployed.commands, ...deployed.agents]) {
    const dest = path.join(configDir, rel);
    if (fs.existsSync(dest)) {
      const marker = path.join(path.dirname(dest), PROXY_MARKER);
      try {
        if (fs.readFileSync(marker, "utf8").trim() === plugin.id) fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
    }
  }
  if (deployed.mcpServers.length) {
    const existing = readMcpJson(configDir);
    let changed = false;
    for (const k of deployed.mcpServers) {
      if (existing[k]) {
        delete existing[k];
        changed = true;
      }
    }
    if (changed) writeMcpJson(configDir, existing);
  }
}

export function undeployPlugin(plugin: InstalledPlugin, config: BridgeConfig): void {
  for (const dir of resolveDeployTargets(config)) {
    undeployFromTarget(plugin, dir, plugin.deployed);
  }
}

export function deployPluginToTarget(
  plugin: InstalledPlugin,
  pluginRoot: string,
  contents: PluginContents,
  configDir: string,
): DeployedItems {
  const warnings: string[] = [];
  if (contents.hasHooks) {
    warnings.push("hooks are not deployed (security)");
  }
  undeployFromTarget(plugin, configDir, plugin.deployed);
  const skills = deploySkills(plugin, contents, configDir, warnings);
  const commands = deployFlatFiles(plugin, contents.commands, "commands", configDir, warnings);
  const agents = deployFlatFiles(plugin, contents.agents, "agents", configDir, warnings);
  const mcpServers = deployMcp(plugin, contents, pluginRoot, configDir);
  return { skills, commands, agents, mcpServers, warnings };
}

export function deployInstalledPlugin(
  plugin: InstalledPlugin,
  config: BridgeConfig,
): DeployedItems {
  if (!plugin.enabled) {
    undeployPlugin(plugin, config);
    return { skills: [], commands: [], agents: [], mcpServers: [], warnings: [] };
  }
  const pluginRoot = path.join(pluginPaths(config).installedDir, plugin.id.replace(/\//g, "__"));
  if (!fs.existsSync(pluginRoot)) {
    throw new ApiError(404, `installed files missing for ${plugin.id}`);
  }
  const contents = analyzePlugin(pluginRoot);
  const merged: DeployedItems = {
    skills: [],
    commands: [],
    agents: [],
    mcpServers: [],
    warnings: [],
  };
  for (const dir of resolveDeployTargets(config)) {
    fs.mkdirSync(dir, { recursive: true });
    const part = deployPluginToTarget(plugin, pluginRoot, contents, dir);
    merged.skills = [...new Set([...merged.skills, ...part.skills])];
    merged.commands = [...new Set([...merged.commands, ...part.commands])];
    merged.agents = [...new Set([...merged.agents, ...part.agents])];
    merged.mcpServers = [...new Set([...merged.mcpServers, ...part.mcpServers])];
    merged.warnings.push(...part.warnings);
  }
  return merged;
}

/** Copy materialized runtime config into a chat-only temp `.cursor` directory. */
export function seedChatOnlyCursorDir(cursorDir: string, config: BridgeConfig): void {
  const runtime = pluginPaths(config).runtimeDir;
  if (!fs.existsSync(runtime)) return;
  for (const sub of ["skills", "commands", "agents"] as const) {
    const src = path.join(runtime, sub);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(cursorDir, sub));
  }
  const mcp = path.join(runtime, "mcp.json");
  if (fs.existsSync(mcp)) {
    fs.copyFileSync(mcp, path.join(cursorDir, "mcp.json"));
  }
}

export function listConfigVariables(contents: PluginContents): string[] {
  return [...collectVariables(contents.mcpServers)].sort();
}
