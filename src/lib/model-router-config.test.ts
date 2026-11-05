import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_ROUTER_TABLE,
  defaultModelRouterConfigPath,
  ensureModelRouterConfigFile,
  loadModelRouterTable,
  saveModelRouterTable,
} from "./model-router-config.js";

describe("loadModelRouterTable", () => {
  const files: string[] = [];
  afterEach(() => {
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    files.length = 0;
  });

  function writeJson(name: string, data: unknown): string {
    const file = path.join(os.tmpdir(), name);
    fs.writeFileSync(file, JSON.stringify(data));
    files.push(file);
    return file;
  }

  it("returns empty routes when file is missing", () => {
    const missing = path.join(os.tmpdir(), `missing-router-${Date.now()}.json`);
    expect(loadModelRouterTable(missing).routes).toEqual([]);
  });

  it("rejects more than five routes", () => {
    const file = writeJson(`router-${Date.now()}.json`, {
      routes: Array.from({ length: 6 }, (_, i) => ({
        model: `m${i}`,
        when: "x",
      })),
    });
    expect(() => loadModelRouterTable(file)).toThrow(/at most 5/);
  });

  it("defaultModelRouterConfigPath is under workspace", () => {
    expect(defaultModelRouterConfigPath("/proj")).toBe(
      path.join("/proj", "model-router.json"),
    );
  });

  it("ensureModelRouterConfigFile seeds defaults when missing", () => {
    const file = path.join(os.tmpdir(), `seed-router-${Date.now()}.json`);
    files.push(file);
    ensureModelRouterConfigFile(file);
    expect(loadModelRouterTable(file).routes).toEqual(
      DEFAULT_MODEL_ROUTER_TABLE.routes,
    );
    const before = fs.readFileSync(file, "utf-8");
    saveModelRouterTable(file, { routes: [{ model: "x", when: "y" }] });
    ensureModelRouterConfigFile(file);
    expect(fs.readFileSync(file, "utf-8")).not.toBe(before);
    expect(loadModelRouterTable(file).routes).toEqual([
      { model: "x", when: "y" },
    ]);
  });

  it("saveModelRouterTable writes readable JSON", () => {
    const file = path.join(os.tmpdir(), `save-router-${Date.now()}.json`);
    files.push(file);
    saveModelRouterTable(file, {
      routes: [{ model: "composer-2.5", when: "routine edits" }],
    });
    expect(loadModelRouterTable(file).routes).toEqual([
      { model: "composer-2.5", when: "routine edits" },
    ]);
  });
});
