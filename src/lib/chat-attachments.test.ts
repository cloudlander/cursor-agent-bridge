import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMultimodalAcpPrompt,
  collectReferencedManagedPaths,
  ensureOutputsDir,
  messagesHaveMultimodalContent,
  pruneManagedStorage,
  saveChatUpload,
  uploadsRoot,
} from "./chat-attachments.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-att-"));
  tmpDirs.push(dir);
  return dir;
}

describe("chat-attachments", () => {
  it("detects multimodal messages", () => {
    expect(messagesHaveMultimodalContent([{ role: "user", content: "hi" }])).toBe(
      false,
    );
    expect(
      messagesHaveMultimodalContent([
        {
          role: "user",
          content: "look",
          attachments: [{ name: "a.png", mimeType: "image/png", path: "/x/a.png" }],
        },
      ]),
    ).toBe(true);
    expect(
      messagesHaveMultimodalContent([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
        },
      ]),
    ).toBe(true);
  });

  it("saves uploads under workspace", () => {
    const ws = mkWorkspace();
    const saved = saveChatUpload(ws, "photo.png", "image/png", Buffer.from("PNG"));
    expect(fs.existsSync(saved.path)).toBe(true);
    expect(saved.name).toBe("photo.png");
    expect(saved.mimeType).toBe("image/png");
  });

  it("builds ACP blocks with image from attachments", () => {
    const ws = mkWorkspace();
    const png = Buffer.from("iVBORw0KGgo=", "base64");
    const saved = saveChatUpload(ws, "x.png", "image/png", png);
    const blocks = buildMultimodalAcpPrompt(
      [
        { role: "user", content: "describe", attachments: [saved] },
      ],
      "User: describe\n\nAssistant:",
      ws,
    );
    expect(blocks[0]).toEqual({ type: "text", text: "User: describe\n\nAssistant:" });
    expect(blocks[1]?.type).toBe("image");
    if (blocks[1]?.type === "image") {
      expect(blocks[1].mimeType).toBe("image/png");
      expect(blocks[1].data).toBe(png.toString("base64"));
    }
  });

  it("pruneManagedStorage removes files past TTL", () => {
    const ws = mkWorkspace();
    const root = uploadsRoot(ws);
    fs.mkdirSync(root, { recursive: true });
    const oldFile = path.join(root, "old.bin");
    fs.writeFileSync(oldFile, "x");
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, oldTime / 1000, oldTime / 1000);
    pruneManagedStorage(ws, { maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it("pruneManagedStorage enforces quota on unreferenced files first", () => {
    const ws = mkWorkspace();
    const root = uploadsRoot(ws);
    fs.mkdirSync(root, { recursive: true });
    const keep = path.join(root, "keep.bin");
    const drop = path.join(root, "drop.bin");
    fs.writeFileSync(keep, Buffer.alloc(400 * 1024));
    fs.writeFileSync(drop, Buffer.alloc(400 * 1024));
    const now = Date.now();
    fs.utimesSync(drop, (now - 60_000) / 1000, (now - 60_000) / 1000);
    fs.utimesSync(keep, now / 1000, now / 1000);
    pruneManagedStorage(ws, {
      maxAgeMs: 365 * 24 * 60 * 60 * 1000,
      quotaBytes: 500 * 1024,
      keepPaths: new Set([fs.realpathSync(keep)]),
    });
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(drop)).toBe(false);
  });

  it("collectReferencedManagedPaths gathers attachment and markdown paths", () => {
    const ws = mkWorkspace();
    const saved = saveChatUpload(ws, "doc.txt", "text/plain", Buffer.from("x"));
    const outputRel = ".cursor-api-proxy/outputs/chart.png";
    const outputAbs = path.join(ws, outputRel);
    fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
    fs.writeFileSync(outputAbs, "png");
    const keep = collectReferencedManagedPaths(
      [
        {
          messages: [
            {
              role: "user",
              content: "see",
              attachments: [saved],
            },
            {
              role: "assistant",
              content: `Download [report](${outputAbs}) or ![img](/api/workspace-file?path=${encodeURIComponent(outputAbs)})`,
            },
          ],
        },
      ],
      ws,
    );
    expect(keep.has(fs.realpathSync(saved.path))).toBe(true);
    expect(keep.has(fs.realpathSync(outputAbs))).toBe(true);
  });

  it("ensureOutputsDir creates managed outputs directory", () => {
    const ws = mkWorkspace();
    const dir = ensureOutputsDir(ws);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(dir).toBe(path.join(ws, ".cursor-api-proxy", "outputs"));
  });

  it("uses resource_link for large text attachments", () => {
    const ws = mkWorkspace();
    const big = "x".repeat(600 * 1024);
    const saved = saveChatUpload(ws, "big.txt", "text/plain", Buffer.from(big, "utf8"));
    const blocks = buildMultimodalAcpPrompt(
      [{ role: "user", content: "read", attachments: [saved] }],
      "User: read\n\nAssistant:",
      ws,
    );
    expect(blocks[1]).toMatchObject({ type: "resource_link", name: "big.txt" });
  });

  it("builds image block from data URL in content", () => {
    const ws = mkWorkspace();
    const data = Buffer.from("abc").toString("base64");
    const blocks = buildMultimodalAcpPrompt(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
          ],
        },
      ],
      "User: see\n\nAssistant:",
      ws,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: "image", mimeType: "image/png", data });
  });
});
