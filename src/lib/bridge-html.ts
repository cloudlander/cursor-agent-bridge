import type { BridgePublicContext } from "./bridge-request-context.js";

const ROOT_EXEMPT = new Set(["/healthz", "/health"]);

/** Paths under the bridge that should be prefixed in HTML (leading /). */
function shouldRewritePath(p: string): boolean {
  if (!p.startsWith("/")) return false;
  if (ROOT_EXEMPT.has(p)) return false;
  if (p === "/") return true;
  const prefixes = [
    "/static/",
    "/api/",
    "/chat",
    "/plugins",
    "/wiki",
    "/apps",
    "/callback",
  ];
  if (prefixes.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))) {
    return true;
  }
  return false;
}

function injectConfigScript(ctx: BridgePublicContext): string {
  const seg = JSON.stringify(ctx.appSegment);
  const mount = JSON.stringify(ctx.mount);
  const base = JSON.stringify(ctx.publicBase);
  return `<script>
window.__BRIDGE_APP_SEGMENT__=${seg};
window.__BRIDGE_MOUNT__=${mount};
window.__BRIDGE_PUBLIC_BASE__=${base};
(function () {
  function segmentBoundaryIndex(p, appSeg) {
    var needle = "/" + appSeg;
    var searchFrom = 0;
    while (searchFrom < p.length) {
      var i = p.indexOf(needle, searchFrom);
      if (i < 0) return -1;
      var after = p[i + needle.length];
      if ((i === 0 || p[i - 1] === "/") && (after === undefined || after === "/" || after === "")) {
        return i;
      }
      searchFrom = i + 1;
    }
    return -1;
  }
  function mountFromLocation(appSeg) {
    if (typeof location === "undefined") return "";
    var i = segmentBoundaryIndex(location.pathname, appSeg);
    if (i < 0) return "";
    return i === 0 ? "" : location.pathname.slice(0, i).replace(/\\/+$/, "");
  }
  function maybeSyncMountFromLocation() {
    var appSeg = window.__BRIDGE_APP_SEGMENT__;
    if (!appSeg || window.__BRIDGE_MOUNT__) return;
    var locMount = mountFromLocation(appSeg);
    if (!locMount) return;
    window.__BRIDGE_MOUNT__ = locMount;
    window.__BRIDGE_PUBLIC_BASE__ = locMount + "/" + appSeg;
  }
  function bridgeExempt(p) {
    return p === "/healthz" || p === "/health";
  }
  function fixRootPathAttr(el, attr) {
    var val = el.getAttribute(attr);
    if (!val || !val.startsWith("/") || bridgeExempt(val) || /^https?:\\/\\//i.test(val)) return;
    var pub = window.__BRIDGE_PUBLIC_BASE__ || "";
    if (!pub) return;
    var appSeg = window.__BRIDGE_APP_SEGMENT__;
    var serverOnly = "/" + appSeg;
    if (val === serverOnly || val.indexOf(serverOnly + "/") === 0) {
      el.setAttribute(attr, pub + val.slice(serverOnly.length));
      return;
    }
    var prefixes = ["/static/", "/api/", "/chat", "/plugins", "/wiki", "/apps", "/callback"];
    var ok = val === "/" || prefixes.some(function (pre) {
      return val === pre.replace(/\\/$/, "") || val.indexOf(pre) === 0;
    });
    if (ok) el.setAttribute(attr, pub + val);
  }
  function fixAllRootPathAttrs() {
    if (!window.__BRIDGE_PUBLIC_BASE__ || !document.querySelectorAll) return;
    var sel = "link[href], script[src], a[href]";
    document.querySelectorAll(sel).forEach(function (el) {
      if (el.getAttribute("href")) fixRootPathAttr(el, "href");
      if (el.getAttribute("src")) fixRootPathAttr(el, "src");
    });
  }
  maybeSyncMountFromLocation();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fixAllRootPathAttrs);
  } else {
    fixAllRootPathAttrs();
  }
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(function (ms) {
      for (var m = 0; m < ms.length; m++) {
        var nodes = ms[m].addedNodes;
        for (var n = 0; n < nodes.length; n++) {
          var el = nodes[n];
          if (!el || el.nodeType !== 1) continue;
          var tag = el.tagName;
          if (tag === "LINK" && el.getAttribute("href")) fixRootPathAttr(el, "href");
          if (tag === "SCRIPT" && el.getAttribute("src")) fixRootPathAttr(el, "src");
          if (tag === "A" && el.getAttribute("href")) fixRootPathAttr(el, "href");
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
</script>`;
}

export function bootstrapRedirectHtml(
  ctx: Pick<BridgePublicContext, "appSegment"> & { mount?: string },
): string {
  const seg = JSON.stringify(ctx.appSegment);
  const serverMount = JSON.stringify(ctx.mount ?? "");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Redirecting…</title>
<script>
(function () {
  var APP = ${seg};
  var SERVER_MOUNT = ${serverMount};
  var p = location.pathname;
  var needle = "/" + APP;
  var i = p.indexOf(needle);
  if (i >= 0) {
    var after = p[i + needle.length];
    if ((i === 0 || p[i - 1] === "/") && (after === undefined || after === "/" || after === "")) {
      location.replace(p.slice(0, i + needle.length) + "/");
      return;
    }
  }
  var mount = SERVER_MOUNT || p.replace(/\\/?index\\.html$/i, "").replace(/\\/$/, "");
  location.replace((mount ? mount : "") + "/" + APP + "/");
})();
</script>
</head><body><p>Redirecting to the bridge dashboard…</p></body></html>`;
}

function rewriteRootAbsoluteAttr(
  html: string,
  attr: "href" | "src",
  ctx: BridgePublicContext,
): string {
  const re = new RegExp(
    `(${attr}\\s*=\\s*)(["'])(\\/[^"']*)(\\2)`,
    "gi",
  );
  return html.replace(re, (full, prefix, quote, pathPart: string, endQuote) => {
    if (!shouldRewritePath(pathPart)) return full;
    const target = `${ctx.publicBase}${pathPart === "/" ? "/" : pathPart}`;
    return `${prefix}${quote}${target}${endQuote}`;
  });
}

export function prepareBridgeHtml(
  raw: string,
  ctx: BridgePublicContext,
): string {
  let html = raw;
  const headIdx = html.search(/<head[^>]*>/i);
  const inject = injectConfigScript(ctx);
  if (headIdx >= 0) {
    const close = html.indexOf(">", headIdx);
    if (close >= 0) {
      html = `${html.slice(0, close + 1)}\n${inject}\n${html.slice(close + 1)}`;
    }
  } else {
    html = inject + html;
  }
  html = rewriteRootAbsoluteAttr(html, "href", ctx);
  html = rewriteRootAbsoluteAttr(html, "src", ctx);
  const bridgePathTag = `<script src="${ctx.publicBase}/static/bridge-path.js"></script>`;
  if (!html.includes("bridge-path.js")) {
    html = html.replace(
      /(<script\s+src="[^"]*\/static\/[^"]+\.js"[^>]*>)/i,
      `${bridgePathTag}\n$1`,
    );
    if (!html.includes("bridge-path.js")) {
      html = html.replace(/<\/head>/i, `${bridgePathTag}\n</head>`);
    }
  }
  return html;
}
