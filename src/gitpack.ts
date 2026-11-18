// Git object model, pkt-line framing and packfiles. Node stdlib only (node:crypto, node:zlib).
//
// Everything here is byte-exact by construction: object ids are SHA-1 over `<type> <size>\0<data>`,
// packs are version 2 with plain (undeltified) entries, and the trailer is the SHA-1 of every
// byte before it. The suite's client verifies hashes, checksums and entry counts on every clone.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const SHA1_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return SHA1_RE.test(value);
}

/** The git object id of `data` as `type`: SHA-1 of `<type> <size>\0<data>`. */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const OBJ_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const OBJ_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// -------------------------------------------------------------------------------------------
// pkt-line
// -------------------------------------------------------------------------------------------

/** The longest pkt-line the suite accepts (65520 bytes of frame, length included). */
export const PKT_LINE_MAX = 65_520;

/** One pkt-line: 4 hex digits of length (including the 4), then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode several lines (strings, or the literals 'flush' / 'delim') into one buffer. */
export function encodePktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/**
 * Parse a whole pkt-line stream. Throws on a bad length, a truncated frame, or trailing bytes.
 * An empty buffer parses to no packets (a delete-only push has no pack, not a bad one).
 */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (hex === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} out of range`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/**
 * Decode pkt-lines up to and including the first flush, and report how many bytes that
 * consumed. A receive-pack body is command pkt-lines, a flush, then raw pack bytes — the pack
 * must never be fed to the pkt-line parser (its "PACK" header reads as a bad length).
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: PktPacket[]; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, consumed: offset + 4 };
    }
    if (hex === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (hex === '0002') {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`pkt-line length ${length} out of range`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

/** Split one sideband payload into its band and data. Band 1 = pack, 2 = progress, 3 = error. */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Chunk `data` into sideband packets of at most `chunkSize` data bytes each. */
export function sidebandChunks(band: 1 | 2 | 3, data: Buffer, chunkSize = 65_000): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    out.push(sidebandPacket(band, data.subarray(offset, Math.min(data.length, offset + chunkSize))));
  }
  if (data.length === 0) out.push(sidebandPacket(band, Buffer.alloc(0)));
  return out;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

/** Write a version-2 pack of plain objects (no deltas): header, entries, SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = OBJ_TYPE_CODE[object.type];
    const size = object.data.length;
    // Type/size varint: first byte holds the type in bits 4-6 and the low 4 size bits.
    const sizeBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      sizeBytes.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>= 7;
    }
    sizeBytes.push(first);
    parts.push(Buffer.from(sizeBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A valid 0-object pack (32 bytes): what an empty fetch answers with. */
export function emptyPack(): Buffer {
  return writePack([]);
}

export interface PackEntry {
  readonly oid: string;
  readonly type: ObjType;
  readonly data: Buffer;
  readonly delta: boolean;
}

export interface PackRead {
  readonly version: number;
  readonly declaredCount: number;
  readonly entries: PackEntry[];
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/** Apply a git delta to a base buffer (the standard copy/insert instruction stream). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const sourceSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const targetSize = readDeltaVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${out.length} bytes, expected ${targetSize}`);
  }
  return out;
}

/** Read a pack (v2/v3), inflating entries and resolving OFS_DELTA / REF_DELTA chains. */
export function readPack(pack: Buffer): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!expected.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const rawEntries: Array<{ type: number; data: Buffer; ofsBase?: number; refBase?: string }> = [];
  const entryOffsets: number[] = [];
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    entryOffsets.push(offset);
    const first = pack[offset] as number;
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let pos = offset + 1;
    // NOTE: the parentheses around the `as` casts are load-bearing. Without them,
    // `pack[pos - 1] as number & 0x80` parses as an assertion to the *type* `number & 0x80`
    // and the loop tests `!== 0` instead of the continuation bit — it then eats the deflate
    // stream and every entry fails to inflate.
    while ((((pack[pos - 1] as number) & 0x80) !== 0)) {
      size |= ((pack[pos] as number) & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    offset = pos;
    if (type === 6) {
      // OFS_DELTA: negative offset varint.
      let byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const dataStart = offset;
      const inflated = inflateOne(pack, dataStart);
      offset = dataStart + inflated.consumed;
      rawEntries.push({ type, data: inflated.data, ofsBase: entryOffsets[index] as number - baseOffset });
    } else if (type === 7) {
      const refBase = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const dataStart = offset;
      const inflated = inflateOne(pack, dataStart);
      offset = dataStart + inflated.consumed;
      rawEntries.push({ type, data: inflated.data, refBase });
    } else {
      if (OBJ_CODE_TYPE[type] === undefined) throw new Error(`unknown pack object type ${type}`);
      const dataStart = offset;
      const inflated = inflateOne(pack, dataStart);
      if (inflated.data.length !== size) throw new Error(`pack entry inflated to ${inflated.data.length} bytes, header says ${size}`);
      offset = dataStart + inflated.consumed;
      rawEntries.push({ type, data: inflated.data });
    }
  }
  const objects = new Map<string, GitObject>();
  const entries: PackEntry[] = [];
  let deltaCount = 0;
  const resolve = (index: number, seen: Set<number>): GitObject => {
    const raw = rawEntries[index] as { type: number; data: Buffer; ofsBase?: number; refBase?: string };
    if (raw.type !== 6 && raw.type !== 7) {
      const type = OBJ_CODE_TYPE[raw.type] as ObjType;
      return { type, data: raw.data };
    }
    if (seen.has(index)) throw new Error('delta cycle in pack');
    seen.add(index);
    let base: GitObject;
    if (raw.type === 6) {
      const baseIndex = entryOffsets.indexOf(raw.ofsBase as number);
      if (baseIndex < 0) throw new Error('OFS_DELTA base outside the pack');
      base = resolve(baseIndex, seen);
    } else {
      const found = objects.get(raw.refBase as string);
      if (found === undefined) throw new Error(`REF_DELTA base ${raw.refBase} is not in the pack`);
      base = found;
    }
    return { type: base.type, data: applyDelta(base.data, raw.data) };
  };
  for (let index = 0; index < rawEntries.length; index += 1) {
    const object = resolve(index, new Set<number>());
    const oid = hashObject(object.type, object.data);
    const isDelta = (rawEntries[index] as { type: number }).type === 6 || (rawEntries[index] as { type: number }).type === 7;
    if (isDelta) deltaCount += 1;
    entries.push({ oid, type: object.type, data: object.data, delta: isDelta });
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return { version, declaredCount, entries, objects, deltaCount };
}

/**
 * Inflate exactly one zlib stream starting at `start` in `pack`, and report how many input bytes
 * it consumed. A streaming inflater does NOT work here: fed the rest of the pack, it never emits
 * 'end' once the next entry's bytes follow the stream. `inflateSync` throws on a truncated
 * stream and ignores trailing bytes, so the shortest prefix that inflates cleanly is the stream
 * itself — found by binary search over the end offset.
 */
function inflateOne(pack: Buffer, start: number): { data: Buffer; consumed: number } {
  // One entry's deflate stream ends exactly where the next entry (or the trailer) begins, and
  // its length is not stored anywhere, so find it: inflateSync throws on a truncated stream
  // ("unexpected end of file") and ignores bytes after a complete stream, so the shortest
  // prefix that inflates cleanly is the stream itself. A binary search over the end offset
  // finds it in log2(remaining) attempts.
  const maxEnd = pack.length - 20; // the 20-byte trailer is never part of an entry
  let lo = start + 1;
  let hi = maxEnd;
  let found: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(pack.subarray(start, mid));
      found = data;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (found === null) throw new Error('zlib stream did not terminate');
  return { data: found, consumed: lo - start };
}

/** Verify a pack's trailer checksum without parsing its entries. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 32) return { ok: false, actual: '', expected: '' };
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return { ok: actual === expected, actual, expected };
}

// -------------------------------------------------------------------------------------------
// object parsing
// -------------------------------------------------------------------------------------------

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly timestamp: number;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const match = / (\d+) [+-]\d{4}$/.exec(author);
      if (match) timestamp = Number(match[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, timestamp };
}

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
  readonly timestamp: number;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  let timestamp = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) {
      tagger = line.slice(7);
      const match = / (\d+) [+-]\d{4}$/.exec(tagger);
      if (match) timestamp = Number(match[1]);
    }
  }
  return { object, type, tag, tagger, message, timestamp };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries sorted git-style (directories sort as if named `name/`). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
    const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. `timestamp` is seconds since the epoch; zone is always +0000. */
export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** Build an annotated tag object. */
export function buildTag(input: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger} ${input.timestamp} +0000`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}
