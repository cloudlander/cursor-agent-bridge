(function (global) {
  function detectPublicBase() {
    const seg = global.__BRIDGE_APP_SEGMENT__;
    const serverBase = global.__BRIDGE_PUBLIC_BASE__ || "";
    const serverMount = global.__BRIDGE_MOUNT__ || "";
    if (!seg) return serverBase;
    if (serverMount) return serverBase;
    if (typeof location === "undefined") return serverBase;
    var p = location.pathname;
    var needle = "/" + seg;
    var i = p.indexOf(needle);
    if (i < 0) return serverBase;
    var after = p[i + needle.length];
    if (
      !(i === 0 || p[i - 1] === "/") ||
      !(after === undefined || after === "/" || after === "")
    ) {
      return serverBase;
    }
    var mount = i === 0 ? "" : p.slice(0, i).replace(/\/+$/, "");
    return (mount ? mount : "") + "/" + seg;
  }

  function bridgePath(p) {
    if (!p || /^https?:\/\//i.test(p)) return p;
    if (p === "/healthz" || p === "/health") return p;
    const base = detectPublicBase();
    const rel = p.startsWith("/") ? p : "/" + p;
    if (!base) return rel;
    return base + (rel === "/" ? "/" : rel);
  }
  global.bridgePath = bridgePath;
  global.__bridgeDetectPublicBase = detectPublicBase;
})(typeof window !== "undefined" ? window : globalThis);
