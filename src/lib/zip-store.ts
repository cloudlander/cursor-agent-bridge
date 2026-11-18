import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/** One file inside a zip. `mode` is a Unix permission mask (for example `0o644`). */
export type ZipFile = {
  name: string;
  data: Buffer;
  mode?: number;
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const UTF8 = 0x800;

function need(buf: Buffer, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > buf.length) {
    throw new ZipError("truncated zip");
  }
}

/**
 * Write a zip archive (UTF-8 names, store or raw deflate). No zip64.
 * Names are stored as given; callers must already use safe relative paths.
 */
export function zipFiles(files: readonly ZipFile[]): Buffer {
  if (files.length > 0xffff) throw new ZipError("too many files");
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    if (name.length > 0xffff) throw new ZipError("file name too long");
    const raw = file.data;
    if (raw.length > 0xffffffff) throw new ZipError("file too large");
    const compressed = raw.length === 0 ? raw : deflateRawSync(raw);
    const method = compressed.length > 0 && compressed.length < raw.length ? 8 : 0;
    const payload = method === 8 ? compressed : raw;
    const crc = crc32(raw) >>> 0;
    const mode = (file.mode ?? 0o644) & 0o777;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(mode << 16, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
    if (offset > 0xffffffff) throw new ZipError("archive too large");
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new ZipError("zip end of central directory not found");
}

/**
 * Read a zip produced by {@link zipFiles} or a compatible store/deflate archive.
 * Rejects encryption, zip64, and data-descriptor entries. Does not interpret paths.
 */
export function unzipFiles(
  buf: Buffer,
  limits: { maxFiles: number; maxFileBytes: number; maxUncompressed: number },
): ZipFile[] {
  if (buf.length < 22) throw new ZipError("truncated zip");
  const eocd = findEocd(buf);
  need(buf, eocd, 22);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipError("multi-disk zip is not supported");
  }
  const count = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  if (count !== total) throw new ZipError("multi-disk zip is not supported");
  if (count > limits.maxFiles) throw new ZipError("too many files");
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError("zip64 is not supported");
  }
  need(buf, centralOffset, centralSize);

  const files: ZipFile[] = [];
  let cursor = centralOffset;
  const centralEnd = centralOffset + centralSize;
  let uncompressed = 0;
  const seen = new Set<string>();
  for (let n = 0; n < count; n++) {
    need(buf, cursor, 46);
    if (buf.readUInt32LE(cursor) !== CENTRAL) throw new ZipError("bad central directory");
    const flags = buf.readUInt16LE(cursor + 8);
    if (flags & 0x1) throw new ZipError("encrypted zip is not supported");
    if (flags & 0x8) throw new ZipError("zip data descriptors are not supported");
    const method = buf.readUInt16LE(cursor + 10);
    if (method !== 0 && method !== 8) throw new ZipError("unsupported zip compression");
    const crc = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const rawSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    if (
      compressedSize === 0xffffffff ||
      rawSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new ZipError("zip64 is not supported");
    }
    if (rawSize > limits.maxFileBytes) throw new ZipError("file too large");
    uncompressed += rawSize;
    if (uncompressed > limits.maxUncompressed) throw new ZipError("uncompressed zip is too large");
    need(buf, cursor + 46, nameLen);
    const madeBy = buf.readUInt16LE(cursor + 4) >> 8;
    const mode = madeBy === 3 ? (buf.readUInt32LE(cursor + 38) >>> 16) & 0o777 : 0o644;
    const utf8 = (flags & UTF8) !== 0;
    const name = buf.toString(utf8 ? "utf8" : "latin1", cursor + 46, cursor + 46 + nameLen);
    if (seen.has(name)) throw new ZipError("duplicate zip entry");
    seen.add(name);
    cursor += 46 + nameLen + extraLen + commentLen;
    if (cursor > centralEnd) throw new ZipError("truncated zip");

    if (name.endsWith("/")) continue;
    need(buf, localOffset, 30);
    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new ZipError("bad local header");
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    need(buf, dataStart, compressedSize);
    const payload = buf.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      if (payload.length !== rawSize) throw new ZipError("zip size mismatch");
      data = Buffer.from(payload);
    } else {
      try {
        data = inflateRawSync(payload, { maxOutputLength: rawSize });
      } catch {
        throw new ZipError("bad deflate data");
      }
      if (data.length !== rawSize) throw new ZipError("zip size mismatch");
    }
    if ((crc32(data) >>> 0) !== crc) throw new ZipError("zip checksum mismatch");
    files.push({ name, data, mode });
  }
  return files;
}
