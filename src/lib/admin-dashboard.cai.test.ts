import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import { caiRestartKillCommand, isCaiDeployment } from "./admin-dashboard.js";

describe("isCaiDeployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true when app.sh exists and CDSW_API_KEY is set", () => {
    vi.stubEnv("CDSW_API_KEY", "test-key");
    vi.stubEnv("CDSW_APP_PORT", "");
    expect(isCaiDeployment()).toBe(fs.existsSync("app.sh"));
  });

  it("caiRestartKillCommand targets the bridge pid", () => {
    expect(caiRestartKillCommand(42)).toContain("kill -TERM 42");
  });

  it("is false without CDSW env", () => {
    vi.stubEnv("CDSW_API_KEY", "");
    vi.stubEnv("CDSW_APP_PORT", "");
    vi.stubEnv("CDSW_PUBLIC_PORT", "");
    vi.stubEnv("CDSW_READONLY_PORT", "");
    expect(isCaiDeployment()).toBe(false);
  });
});
