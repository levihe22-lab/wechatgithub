import { MAX_FRAME_LENGTH } from './wcv3-header.js';

const decoder = new TextDecoder();

/* ── WCV2 header ────────────────────────────────── */
export async function readWcv2Header(file) {
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const magic = decoder.decode(prefix.subarray(0, 4));
  if (magic !== 'WCV2') throw new Error('E_FORMAT');

  const headerLen = new DataView(prefix.buffer).getUint32(4, true);
  if (headerLen < 1 || headerLen > 65536) throw new Error('E_FORMAT');

  const headerBytes = new Uint8Array(await file.slice(8, 8 + headerLen).arrayBuffer());
  const raw = JSON.parse(decoder.decode(headerBytes));

  const salt = Uint8Array.from(atob(raw.salt), (c) => c.charCodeAt(0));
  if (salt.byteLength !== 16 || raw.iterations < 1 || raw.iterations > 20000000) throw new Error('E_FORMAT');
  if (typeof raw.id !== 'string' || raw.id.length < 8) throw new Error('E_FORMAT');

  return Object.freeze({
    packageId: raw.id,
    salt,
    iterations: raw.iterations,
    recordCount: raw.recordCount | 0,
    manifestOffset: 8 + headerLen,
  });
}

/* ── WCV2 frame ─────────────────────────────────── */
export function parseWcv2Frame(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16 || bytes.byteLength > MAX_FRAME_LENGTH) {
    throw new Error('E_FORMAT');
  }
  const ciphertextLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (ciphertextLen + 16 !== bytes.byteLength) throw new Error('E_FORMAT');
  return { iv: bytes.slice(4, 16), ciphertext: bytes.slice(16) };
}

/* ── WCV2 range reader ─────────────────────────── */
export class Wcv2RangeReader {
  constructor(file) {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size)) {
      throw new Error('E_FORMAT');
    }
    this.file = file;
  }

  async readRange(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < 0 || length < 1 || length > MAX_FRAME_LENGTH
        || offset + length > this.file.size) throw new Error('E_FORMAT');
    return new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer());
  }

  async readFrame(offset, length) {
    return parseWcv2Frame(await this.readRange(offset, length));
  }

  clear() { this.file = null; }
}

/* ── Manifest builder ───────────────────────────── */
const PATH_TYPES = Object.freeze([
  [/^data\/contacts\.json$/i, 'contacts', 'application/json'],
  [/^data\/dates\.json$/i, 'dates', 'application/json'],
  [/^data\/search_index\.json$/i, 'search-shard', 'application/json'],
  [/^data\/messages\/page_(\d+)\.json$/i, 'message-page', 'application/json'],
  [/^data\/media\/Image\//i, 'image', null],
  [/^data\/media\/Video\//i, 'video', null],
  [/^data\/media\/Voice\//i, 'voice', null],
]);

export function classifyPath(path) {
  for (const [re, type] of PATH_TYPES) {
    if (re.test(path)) return type;
  }
  return 'path-records';
}

export function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (/\.(png|jpg|jpeg|gif|webp|bmp)$/i.test(lower)) return 'image/' + lower.split('.').pop();
  if (/\.(mp4|mov|avi|mkv)$/i.test(lower)) return 'video/' + lower.split('.').pop();
  if (/\.(mp3|wav|ogg|aac|amr|silk)$/i.test(lower)) return 'audio/' + lower.split('.').pop();
  return 'application/octet-stream';
}

export function padIndexToHex(index) {
  return index.toString(16).padStart(32, '0');
}

export function buildWcv3Manifest(wcv2Manifest, resources) {
  const resourceById = new Map(resources.map((r) => [r.id, r]));

  let contactsResource = null;
  let datesResource = null;
  const searchShards = {};
  const messagePages = {};

  for (const r of resources) {
    if (r.type === 'contacts') contactsResource = r.id;
    else if (r.type === 'dates') datesResource = r.id;
  }

  // search-shard: use single search_index.json as the search shard
  const shard = resources.find((r) => r.type === 'search-shard');
  if (shard) searchShards['all'] = shard.id;

  // message pages
  for (const r of resources) {
    if (r.type === 'message-page') {
      const match = r.path?.match(/page_(\d+)\.json$/i);
      if (match) messagePages[`page_${match[1]}`] = r.id;
    }
  }

  const pageIds = Object.keys(messagePages).sort((a, b) => {
    const na = parseInt(a.replace('page_', ''), 10);
    const nb = parseInt(b.replace('page_', ''), 10);
    return na - nb;
  });

  return Object.freeze({
    format: 'WCV3',
    version: 3,
    resources: resources.map((r) => Object.freeze({ ...r })),
    contactsResource,
    datesResource,
    messagePages,
    searchShards,
    conversations: [{
      id: 'conversation',
      pages: pageIds.map((k) => messagePages[k]),
    }],
  });
}
