import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { BodyTooLargeError } from "./http.js";
import { saveMultipartFieldToFile } from "./multipart-upload.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mockMultipartRequest(body: Buffer, boundary = "abc123"): http.IncomingMessage {
  const req = Readable.from([body]) as http.IncomingMessage;
  req.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  return req;
}

function buildMultipart(
  boundary: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disp = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`;
    chunks.push(Buffer.from(disp));
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    chunks.push(Buffer.from("\r\n"));
    chunks.push(part.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

describe("saveMultipartFieldToFile", () => {
  it("writes the file field to disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-up-"));
    tmpDirs.push(dir);
    const dest = path.join(dir, "out.bin");
    const boundary = "testboundary";
    const payload = buildMultipart(boundary, [
      {
        name: "file",
        filename: "hello.txt",
        contentType: "text/plain",
        data: Buffer.from("hello multipart"),
      },
    ]);
    const req = mockMultipartRequest(payload, boundary);
    const saved = await saveMultipartFieldToFile(req, "file", dest, 1024 * 1024);
    expect(saved.filename).toBe("hello.txt");
    expect(saved.mimeType).toBe("text/plain");
    expect(saved.bytesWritten).toBe("hello multipart".length);
    expect(fs.readFileSync(dest, "utf8")).toBe("hello multipart");
  });

  it("rejects file fields over maxBytes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-up-"));
    tmpDirs.push(dir);
    const dest = path.join(dir, "big.bin");
    const boundary = "limboundary";
    const payload = buildMultipart(boundary, [
      {
        name: "file",
        filename: "big.bin",
        data: Buffer.alloc(64),
      },
    ]);
    const req = mockMultipartRequest(payload, boundary);
    await expect(saveMultipartFieldToFile(req, "file", dest, 32)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(fs.existsSync(dest)).toBe(false);
  });
});
