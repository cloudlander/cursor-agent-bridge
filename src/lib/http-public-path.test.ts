import { describe, expect, it } from "vitest";

import {
  forwardedMountFromHeaders,
  isBootstrapPath,
  mountFromBootstrapPathname,
  mountFromCookie,
  publicPath,
  resolveEffectiveMount,
  splitPublicPath,
  validateAppSegment,
} from "./http-public-path.js";

describe("splitPublicPath", () => {
  const seg = "cursor-agent";

  it("strips mount and segment", () => {
    expect(splitPublicPath("/proxy/1080/cursor-agent/chat", seg)).toEqual({
      kind: "found",
      mount: "/proxy/1080",
      internal: "/chat",
    });
  });

  it("handles root under segment", () => {
    expect(splitPublicPath("/cursor-agent/", seg)).toEqual({
      kind: "found",
      mount: "",
      internal: "/",
    });
  });

  it("does not match cursor-agent-bridge", () => {
    expect(splitPublicPath("/cursor-agent-bridge/x", seg).kind).toBe("missing");
  });

  it("rejects mount with parent segments", () => {
    expect(splitPublicPath("/proxy/../1080/cursor-agent/x", seg).kind).toBe(
      "missing",
    );
  });
});

describe("isBootstrapPath", () => {
  const seg = "cursor-agent";

  it("bootstrap virtual roots", () => {
    expect(isBootstrapPath("/", seg)).toBe(true);
    expect(isBootstrapPath("/index.html", seg)).toBe(true);
    expect(isBootstrapPath("/proxy/1080/", seg)).toBe(true);
    expect(isBootstrapPath("/proxy/1080/index.html", seg)).toBe(true);
  });

  it("not bootstrap under app", () => {
    expect(isBootstrapPath("/cursor-agent/chat", seg)).toBe(false);
  });

  it("healthz is not bootstrap", () => {
    expect(isBootstrapPath("/healthz", seg)).toBe(false);
  });
});

describe("publicPath", () => {
  it("composes paths", () => {
    expect(publicPath("/api/status", "/proxy/1080", "agent-x")).toBe(
      "/proxy/1080/agent-x/api/status",
    );
    expect(publicPath("/", "", "cursor-agent")).toBe("/cursor-agent/");
  });
});

describe("validateAppSegment", () => {
  it("rejects reserved api", () => {
    expect(() => validateAppSegment("api")).toThrow();
  });
});

describe("resolveEffectiveMount", () => {
  const seg = "agent-0435a2";
  const headers = { "x-forwarded-prefix": "/proxy/8080" };

  it("prefers path mount", () => {
    expect(resolveEffectiveMount("/proxy/1080", headers, seg)).toBe(
      "/proxy/1080",
    );
  });

  it("uses forwarded prefix when path mount empty", () => {
    expect(resolveEffectiveMount("", headers, seg)).toBe("/proxy/8080");
  });

  it("uses cookie when no path or header", () => {
    expect(
      resolveEffectiveMount("", { cookie: "cursor_bridge_mount=%2Fproxy%2F8080" }, seg),
    ).toBe("/proxy/8080");
  });
});

describe("forwardedMountFromHeaders", () => {
  it("parses x-forwarded-uri", () => {
    expect(
      forwardedMountFromHeaders(
        { "x-forwarded-uri": "/proxy/8080/cursor-agent/chat" },
        "cursor-agent",
      ),
    ).toBe("/proxy/8080");
  });
});

describe("mountFromBootstrapPathname", () => {
  it("extracts /proxy/8080 from virtual root", () => {
    expect(mountFromBootstrapPathname("/proxy/8080/")).toBe("/proxy/8080");
  });
});

describe("mountFromCookie", () => {
  it("reads cursor_bridge_mount", () => {
    expect(
      mountFromCookie("foo=1; cursor_bridge_mount=%2Fproxy%2F8080"),
    ).toBe("/proxy/8080");
  });
});
