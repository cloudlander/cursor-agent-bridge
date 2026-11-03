import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMultimodalAcpPrompt,
  messagesHaveMultimodalContent,
  saveChatUpload,
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
