import * as fs from "node:fs";
import * as path from "node:path";

export type McpServerDef = Record<string, unknown>;

export type PluginContents = {
  manifest: Record<string, unknown>;
  skills: { name: string; dirName: string; dir: string; description?: string }[];
  commands: { name: string; file: string }[];
  agents: { name: string; file: string }[];
  rules: { name: string; file: string }[];
  mcpServers: Record<string, McpServerDef>;
  hasHooks: boolean;
  /** `${env:NAME}` style variables referenced by the plugin's MCP configuration. */
  variables: string[];
};

const MANIFEST_DIRS = [".cursor-plugin", ".claude-plugin", ".agents/plugins"];
const MCP_FILES = [".cursor-mcp.json", "mcp.json", ".mcp.json"];

export const PLUGIN_ROOT_VARS = [
  "CURSOR_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "PLUGIN_ROOT",
  "pluginRoot",
  "pluginDir",
];

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True when `target` is `root` or inside it (symlink-resolved). */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(realOrSelf(root), realOrSelf(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function findManifestFile(dir: string, base: string): string | null {
  for (const d of MANIFEST_DIRS) {
    const f = path.join(dir, d, base);
    if (isFile(f)) return f;
  }
  return null;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function asList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * Resolve a manifest-declared path. Relative to the plugin root first, then to the
 * manifest directory (some plugins write `../x` relative to `.cursor-plugin/`).
 * Anything that escapes the plugin root is rejected.
 */
function resolveInside(root: string, manifestDir: string, rel: string): string | null {
  for (const base of [root, manifestDir]) {
    const p = path.resolve(base, rel);
    if ((isDir(p) || isFile(p)) && isInside(root, p)) return p;
  }
  return null;
}

function discoverSkills(root: string, manifestDir: string, declared: string[]) {
  const roots = declared.length ? declared : ["skills"];
  const found: PluginContents["skills"] = [];
  const seen = new Set<string>();
  const add = (dir: string) => {
    const file = path.join(dir, "SKILL.md");
    if (!isFile(file) || seen.has(dir)) return;
    seen.add(dir);
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const dirName = path.basename(dir);
    found.push({ name: fm.name || dirName, dirName, dir, description: fm.description });
  };
  for (const rel of roots) {
    const base = resolveInside(root, manifestDir, rel);
    if (!base || !isDir(base)) continue;
    add(base);
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith(".")) add(path.join(base, e.name));
    }
  }
  return found;
}

function discoverFiles(
  root: string,
  manifestDir: string,
  declared: string[],
  fallback: string,
  exts: string[],
) {
  const roots = declared.length ? declared : [fallback];
  const out: { name: string; file: string }[] = [];
  for (const rel of roots) {
    const base = resolveInside(root, manifestDir, rel);
    if (!base) continue;
    const files = isDir(base)
      ? fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(base, e.name))
      : [base];
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (exts.includes(ext)) out.push({ name: path.basename(f, ext), file: f });
    }
  }
  return out;
}

function normalizeMcpMap(raw: Record<string, unknown> | null): Record<string, McpServerDef> {
  if (!raw) return {};
  const map = (raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : raw) as Record<string, unknown>;
  const out: Record<string, McpServerDef> = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v as McpServerDef;
  }
  return out;
}

const VAR_RE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function collectVariables(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    for (const m of value.matchAll(VAR_RE)) {
      if (!PLUGIN_ROOT_VARS.includes(m[1])) into.add(m[1]);
    }
  } else if (Array.isArray(value)) {
    for (const v of value) collectVariables(v, into);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectVariables(v, into);
  }
  return into;
}

export function analyzePlugin(root: string): PluginContents {
  const manifestFile = findManifestFile(root, "plugin.json");
  const manifest = manifestFile ? (readJsonFile(manifestFile) ?? {}) : {};
  const manifestDir = manifestFile ? path.dirname(manifestFile) : root;

  const skills = discoverSkills(root, manifestDir, asList(manifest.skills));
  const commands = discoverFiles(root, manifestDir, asList(manifest.commands), "commands", [".md", ".mdc"]);
  const agents = discoverFiles(root, manifestDir, asList(manifest.agents), "agents", [".md"]);
  const rules = discoverFiles(root, manifestDir, asList(manifest.rules), "rules", [".mdc", ".md"]);

  let mcpServers: Record<string, McpServerDef> = {};
  const declared = manifest.mcpServers;
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    mcpServers = normalizeMcpMap({ mcpServers: declared });
  } else {
    const files = asList(declared);
    const candidates = files.length ? files : MCP_FILES;
    for (const rel of candidates) {
      const p = resolveInside(root, manifestDir, rel);
      if (p && isFile(p)) {
        mcpServers = { ...mcpServers, ...normalizeMcpMap(readJsonFile(p)) };
        if (!files.length) break;
      }
    }
  }

  return {
    manifest,
    skills,
    commands,
    agents,
    rules,
    mcpServers,
    hasHooks: isFile(path.join(root, "hooks", "hooks.json")) || isFile(path.join(root, "hooks.json")),
    variables: [...collectVariables(mcpServers)].sort(),
  };
}
