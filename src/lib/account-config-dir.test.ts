import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  allowedAccountConfigDirs,
  pickAccountConfigDirForChat,
  resolveAllowedAccountConfigDir,
} from "./account-config-dir.js";
import type { BridgeConfig } from "./config.js";

function minimalConfig(configDirs: string[]): BridgeConfig {
  return {
    configDirs,
  } as BridgeConfig;
}

describe("account-config-dir", () => {
  it("resolveAllowedAccountConfigDir matches resolved pool paths", () => {
    const a = path.resolve("/acc/alpha");
    const b = path.resolve("/acc/beta");
    const config = minimalConfig([a, b]);
    expect(resolveAllowedAccountConfigDir(config, a)).toBe(a);
    expect(resolveAllowedAccountConfigDir(config, "/acc/unknown")).toBeUndefined();
  });

  it("allowedAccountConfigDirs resolves relative dirs", () => {
    const rel = "./accounts/x";
    const config = minimalConfig([rel]);
    const allowed = allowedAccountConfigDirs(config);
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toBe(path.resolve(rel));
  });

  it("pickAccountConfigDirForChat uses explicit account when valid", () => {
    const a = path.resolve("/pool/1");
    const b = path.resolve("/pool/2");
    const config = minimalConfig([a, b]);
    expect(pickAccountConfigDirForChat(config, b)).toBe(b);
    expect(pickAccountConfigDirForChat(config, "/nope")).toBeUndefined();
  });

  it("pickAccountConfigDirForChat requires explicit account", () => {
    const a = path.resolve("/pool/1");
    const config = minimalConfig([a]);
    expect(pickAccountConfigDirForChat(config)).toBeUndefined();
    expect(pickAccountConfigDirForChat(config, "")).toBeUndefined();
  });
});
