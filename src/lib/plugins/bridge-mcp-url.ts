/**
 * Cursor IDE routes some official MCP plugins through api.cursor.com (requires
 * x-cursor-auth). cursor-api-proxy uses Google/Atlassian OAuth locally instead.
 */
const CURSOR_REST_MCP_DIRECT: Record<string, string> = {
  "https://api.cursor.com/rest-mcp/google-drive/mcp": "https://drivemcp.googleapis.com/mcp/v1",
};

export function rewriteBridgeRemoteMcpUrl(url: string): string {
  const trimmed = url.trim();
  const direct = CURSOR_REST_MCP_DIRECT[trimmed];
  if (direct) return direct;
  const norm = trimmed.replace(/\/+$/, "");
  for (const [from, to] of Object.entries(CURSOR_REST_MCP_DIRECT)) {
    if (from.replace(/\/+$/, "") === norm) return to;
  }
  return url;
}
