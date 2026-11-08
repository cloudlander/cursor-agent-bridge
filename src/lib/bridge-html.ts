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
  function setMountCookie(mount) {
    if (!mount) return;
    document.cookie = "cursor_bridge_mount=" + encodeURIComponent(mount) + "; path=/; SameSite=Lax";
  }
  var p = location.pathname;
  var needle = "/" + APP;
  var i = p.indexOf(needle);
  if (i >= 0) {
    var after = p[i + needle.length];
    if ((i === 0 || p[i - 1] === "/") && (after === undefined || after === "/" || after === "")) {
      var m0 = i === 0 ? "" : p.slice(0, i).replace(/\\/$/, "");
      setMountCookie(SERVER_MOUNT || m0);
      location.replace(p.slice(0, i + needle.length) + "/");
      return;
    }
  }
  var mount = SERVER_MOUNT || p.replace(/\\/?index\\.html$/i, "").replace(/\\/$/, "");
  setMountCookie(mount);
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
  html = rewriteRootAbsoluteAttr(html, "href", ctx);
  html = rewriteRootAbsoluteAttr(html, "src", ctx);
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
