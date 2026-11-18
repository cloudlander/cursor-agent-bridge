(function (root) {
  function callbackPath(pathname) {
    const path = String(pathname || "").replace(/\/+$/, "") || "/";
    return path === "/callback" || path.endsWith("/callback");
  }

  function rewriteLoopbackOAuthCallback(pasted, publicCallback) {
    const raw = String(pasted || "").trim();
    let source;
    try {
      source = new URL(raw);
    } catch {
      throw new Error("Paste the full callback address from the browser bar.");
    }
    if (source.protocol !== "http:" && source.protocol !== "https:") {
      throw new Error("Paste the full callback address from the browser bar.");
    }
    const host = source.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      throw new Error("Paste the localhost callback address from the browser bar.");
    }
    if (!callbackPath(source.pathname)) {
      throw new Error("The address should end with /callback.");
    }
    const code = (source.searchParams.get("code") || "").trim();
    const state = (source.searchParams.get("state") || "").trim();
    if (!code || !state) {
      throw new Error("The address needs both code and state.");
    }

    let dest;
    try {
      dest = new URL(String(publicCallback || ""));
    } catch {
      throw new Error("This app callback URL is not valid.");
    }
    if (dest.protocol !== "http:" && dest.protocol !== "https:") {
      throw new Error("This app callback URL is not valid.");
    }
    if (!callbackPath(dest.pathname)) {
      throw new Error("This app callback URL is not valid.");
    }
    dest.hash = "";
    dest.search = "";
    dest.searchParams.set("code", code);
    dest.searchParams.set("state", state);
    return dest.toString();
  }

  root.rewriteLoopbackOAuthCallback = rewriteLoopbackOAuthCallback;
})(typeof globalThis !== "undefined" ? globalThis : this);
