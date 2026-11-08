import type * as http from "node:http";

import type { BridgeConfig } from "./config.js";
import { publicBasePath } from "./http-public-path.js";

export type BridgePublicContext = {
  mount: string;
  appSegment: string;
  externalPathname: string;
  publicBase: string;
};

const CTX = Symbol.for("cursor.bridgePublicContext");

export function setBridgePublicContext(
  req: http.IncomingMessage,
  ctx: BridgePublicContext,
): void {
  (req as http.IncomingMessage & { [CTX]?: BridgePublicContext })[CTX] = ctx;
}

export function getBridgePublicContext(
  req: http.IncomingMessage,
): BridgePublicContext | undefined {
  return (req as http.IncomingMessage & { [CTX]?: BridgePublicContext })[CTX];
}

export function bridgeContextFrom(
  mount: string,
  config: BridgeConfig,
  externalPathname: string,
): BridgePublicContext {
  return {
    mount,
    appSegment: config.appSegment,
    externalPathname,
    publicBase: publicBasePath(mount, config.appSegment),
  };
}
