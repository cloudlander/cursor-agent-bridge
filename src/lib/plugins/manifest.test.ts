import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { analyzePlugin, collectVariables } from "./manifest.js";

describe("analyzePlugin", () => {
  it("discovers skills and env placeholders", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plg-"));
    const skillDir = path.join(root, "skills", "demo-skill");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: test\n---\n",
    );
    fs.mkdirSync(path.join(root, ".cursor-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "demo" }),
    );
    fs.writeFileSync(
      path.join(root, ".cursor-plugin", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          srv: { url: "https://example.com", headers: { Authorization: "Bearer ${env:MY_TOKEN}" } },
        },
      }),
    );
    const c = analyzePlugin(root);
    expect(c.skills).toHaveLength(1);
    expect(c.skills[0].name).toBe("demo-skill");
    expect(c.mcpServers.srv).toBeTruthy();
    expect(collectVariables(c.mcpServers).has("MY_TOKEN")).toBe(true);
  });
});
