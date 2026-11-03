import * as path from "node:path";

import type { BridgeConfig } from "../lib/config.js";
import {
  exportSessionBundle,
  importSessionBundle,
} from "../lib/session-portable.js";

export type HandleSessionsExportOptions = {
  config: BridgeConfig;
  outDir: string;
  days: number;
  output?: NodeJS.WritableStream;
};

export type HandleSessionsImportOptions = {
  config: BridgeConfig;
  bundleDir: string;
  merge: boolean;
  output?: NodeJS.WritableStream;
};

function writeLine(
  stream: NodeJS.WritableStream,
  line: string,
): void {
  stream.write(`${line}\n`);
}

export async function handleSessionsExport(
  opts: HandleSessionsExportOptions,
): Promise<void> {
  const out = opts.output ?? process.stdout;
  const summary = await exportSessionBundle(opts.config, {
    outDir: opts.outDir,
    days: opts.days,
  });
  writeLine(
    out,
    `Exported sessions (last ${opts.days} day(s)) → ${path.resolve(opts.outDir)}`,
  );
  writeLine(out, `  manifest: ${summary.manifestPath}`);
  writeLine(out, `  web threads: ${summary.webThreads}`);
  writeLine(out, `  API sessions: ${summary.apiSessions}`);
  writeLine(out, `  agent transcripts: ${summary.agentTranscripts}`);
  writeLine(out, `  ACP sessions: ${summary.acpSessions}`);
}

export async function handleSessionsImport(
  opts: HandleSessionsImportOptions,
): Promise<void> {
  const out = opts.output ?? process.stdout;
  const summary = await importSessionBundle(opts.config, {
    bundleDir: opts.bundleDir,
    merge: opts.merge,
  });
  writeLine(
    out,
    `Imported session bundle from ${path.resolve(opts.bundleDir)}`,
  );
  writeLine(out, `  web threads merged: ${summary.webThreadsMerged}`);
  writeLine(out, `  API sessions merged: ${summary.apiSessionsMerged}`);
  writeLine(out, `  agent transcript files: ${summary.agentTranscriptFiles}`);
  writeLine(out, `  ACP session dirs touched: ${summary.acpSessionDirs}`);
}
