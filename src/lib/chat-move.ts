import * as fs from "node:fs";
import * as path from "node:path";

import {
  collectReferencedManagedPaths,
  managedStorageRoots,
} from "./chat-attachments.js";
import type { BridgeConfig } from "./config.js";
import {
  readWorkspaceChatStore,
  relocateWebThread,
  type WebChatThread,
} from "./chat-store.js";
import { getGeneration } from "./web-chat-generation.js";
import { getWorkspace, resolveAgentWorkspace } from "./workspaces.js";

export class ChatMoveError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
  }
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function uniqueDestPath(dest: string): string {
  if (!fs.existsSync(dest)) return dest;
  const { dir, name, ext } = path.parse(dest);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${name}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function jsonEscaped(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/** Replace old file locations (absolute, URL-encoded and workspace-relative) inside a thread. */
function rewriteThreadPaths(
  thread: WebChatThread,
  moved: Array<{ from: string; to: string; fromRel: string; toRel: string }>,
  srcDir: string,
): WebChatThread {
  let json = JSON.stringify(thread);
  for (const m of moved) {
    const oldForms = new Set([m.from, path.join(srcDir, m.fromRel)]);
    for (const old of oldForms) {
      json = json.split(jsonEscaped(old)).join(jsonEscaped(m.to));
      json = json.split(encodeURIComponent(old)).join(encodeURIComponent(m.to));
    }
    if (m.fromRel !== m.toRel) {
      json = json
        .split(jsonEscaped(m.fromRel.split(path.sep).join("/")))
        .join(jsonEscaped(m.toRel.split(path.sep).join("/")));
    }
  }
  return JSON.parse(json) as WebChatThread;
}

export type MoveChatResult = {
  workspaceId: string;
  threadId: string;
  movedFiles: number;
};

/**
 * Move a web chat and the uploads/outputs it references into another workspace.
 * Files still referenced by other chats in the source workspace are copied, not removed.
 */
export async function moveChatToWorkspace(
  config: BridgeConfig,
  opts: { threadId: string; fromWorkspaceId: string; toWorkspaceId: string },
): Promise<MoveChatResult> {
  const { threadId, fromWorkspaceId, toWorkspaceId } = opts;
  if (fromWorkspaceId === toWorkspaceId) {
    throw new ChatMoveError("Chat is already in this workspace", 400, "invalid_request");
  }
  const [from, to] = await Promise.all([
    getWorkspace(config, fromWorkspaceId),
    getWorkspace(config, toWorkspaceId),
  ]);
  if (!from || !to) {
    throw new ChatMoveError("Workspace not found", 404, "not_found");
  }
  if (getGeneration(threadId)?.status === "running") {
    throw new ChatMoveError("Stop the running reply before moving this chat", 409, "chat_busy");
  }

  const srcStore = await readWorkspaceChatStore(config, from.id);
  const thread = srcStore.threads.find((t) => t.id === threadId);
  if (!thread) {
    throw new ChatMoveError("Chat not found in the source workspace", 404, "not_found");
  }

  const [src, dst] = await Promise.all(
    [from, to].map((w) =>
      resolveAgentWorkspace(config, { workspaceId: w.id, chatOnly: false, fromWebChat: true }),
    ),
  );
  const srcDir = realOrResolved(src.workspaceDir);
  const dstDir = realOrResolved(dst.workspaceDir);

  const managedRoots = managedStorageRoots(srcDir).map(realOrResolved);
  const files = [...collectReferencedManagedPaths([thread], srcDir)].filter((f) =>
    managedRoots.some((root) => isInside(root, f)),
  );
  const stillShared = collectReferencedManagedPaths(
    srcStore.threads.filter((t) => t.id !== threadId),
    srcDir,
  );

  const copied: Array<{ from: string; to: string; fromRel: string; toRel: string }> = [];
  try {
    for (const file of files) {
      const fromRel = path.relative(srcDir, file);
      const dest = uniqueDestPath(path.join(dstDir, fromRel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_FICLONE);
      copied.push({ from: file, to: dest, fromRel, toRel: path.relative(dstDir, dest) });
    }
    const moved = rewriteThreadPaths(thread, copied, srcDir);
    await relocateWebThread(config, {
      fromWorkspaceId: from.id,
      toWorkspaceId: to.id,
      thread: moved,
    });
  } catch (e) {
    for (const c of copied) fs.rmSync(c.to, { force: true });
    throw e;
  }

  for (const c of copied) {
    if (!stillShared.has(c.from)) fs.rmSync(c.from, { force: true });
  }
  return { workspaceId: to.id, threadId, movedFiles: copied.length };
}
