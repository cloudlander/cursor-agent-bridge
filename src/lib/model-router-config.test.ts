import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadModelRouterTable } from "./model-router-config.js";

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
});
