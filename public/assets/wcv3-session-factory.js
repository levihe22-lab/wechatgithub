import { Wcv3RangeReader } from './wcv3-range-reader.js';
import { readWcv2Header, parseWcv2Frame, Wcv2RangeReader, buildWcv3Manifest, padIndexToHex, classifyPath, contentTypeFor } from './wcv2-reader.js';
import { deriveSessionKey, decryptWcv2Frame, decryptManifest } from './wcv3-crypto.js';
import { ManifestPlanner } from './manifest-planner.js';
import { hexToBytes } from './wcv3-header.js';

/**
 * Detect format by reading the first 4 bytes of the file.
 */
async function detectFormat(file) {
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const text = new TextDecoder().decode(magic);
  if (text === 'WCV2') return 'WCV2';
  if (text === 'WCV3') return 'WCV3';
  throw new Error('E_FORMAT');
}

/**
 * WCV3 session factory.
 */
export async function createWcv3Session(file, password) {
  const reader = new Wcv3RangeReader(file);
  const header = await reader.readHeader();
  const key = await deriveSessionKey(password, header.salt);

  let manifest;
  try {
    manifest = await decryptManifest(reader, header, key);
  } catch (err) {
    reader.clear();
    throw err;
  }

  const manifestRange = Object.freeze({
    offset: header.manifestOffset,
    length: header.manifestLength,
  });
  const planner = new ManifestPlanner(manifest, file.size, manifestRange);

  return Object.freeze({
    sessionKey: key,
    manifest,
    planner,
    reader,
    header,
    decryptedResources: new Map(),
    temporaryUrls: new Set(),
  });
}

/**
 * WCV2 session factory.
 */
export async function createWcv2Session(file, password) {
  const w2 = await readWcv2Header(file);
  const reader = new Wcv2RangeReader(file);

  // Read & decrypt manifest (record 0)
  const manifestFrameBytes = await reader.readRange(w2.manifestOffset, 16);
  const prefixLen = new DataView(manifestFrameBytes.buffer, manifestFrameBytes.byteOffset, 4).getUint32(0, true);
  const totalFrameLen = 4 + 12 + prefixLen;
  const fullManifestFrame = await reader.readRange(w2.manifestOffset, totalFrameLen);
  const manifestFrame = parseWcv2Frame(fullManifestFrame);

  const key = await deriveSessionKey(password, w2.salt, w2.iterations);
  let rawManifest;
  try {
    rawManifest = await decryptWcv2Frame(key, w2.packageId, 0, manifestFrame);
  } catch (err) {
    reader.clear();
    throw err;
  }

  let wcv2Manifest;
  try {
    wcv2Manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawManifest));
  } catch {
    throw new Error('E_FORMAT');
  } finally {
    rawManifest.fill(0);
  }

  if (!Array.isArray(wcv2Manifest.entries) || wcv2Manifest.entries.length === 0) {
    throw new Error('E_FORMAT');
  }

  // Scan resource frames with chunked reads (~35 reads instead of 9440)
  let offset = w2.manifestOffset + totalFrameLen;
  const resources = [];
  const recordIndexById = {};
  const CHUNK = 4 * 1024 * 1024; // 4 MiB
  let i = 0;
  let buf = null;
  let bufStart = 0;

  while (i < wcv2Manifest.entries.length) {
    if (!buf || offset - bufStart + 16 > buf.byteLength) {
      const readLen = Math.min(CHUNK, file.size - offset);
      buf = new Uint8Array(await file.slice(offset, offset + readLen).arrayBuffer());
      bufStart = offset;
    }

    const relative = offset - bufStart;
    const cLen = new DataView(buf.buffer, buf.byteOffset + relative, 4).getUint32(0, true);
    const frameLen = 4 + 12 + cLen;
    const idx = i + 1;
    const entry = wcv2Manifest.entries[i];

    const id = padIndexToHex(idx);
    resources.push({
      id,
      type: classifyPath(entry.path),
      contentType: contentTypeFor(entry.path),
      offset,
      length: frameLen,
      path: entry.path,
    });
    recordIndexById[id] = idx;
    offset += frameLen;
    i++;
  }

  // Build WCV3-compatible manifest
  const manifest = buildWcv3Manifest(wcv2Manifest, resources);
  const manifestRange = Object.freeze({
    offset: w2.manifestOffset,
    length: totalFrameLen,
  });
  const planner = new ManifestPlanner(manifest, file.size, manifestRange);

  // WCV3-compatible header
  const packageIdBytes = Uint8Array.from(
    w2.packageId.padEnd(16, '\0').slice(0, 16),
    (c) => c.charCodeAt(0),
  );
  const header = Object.freeze({
    salt: w2.salt,
    packageId: packageIdBytes,
    manifestResourceId: hexToBytes(padIndexToHex(0)),
    manifestOffset: w2.manifestOffset,
    manifestLength: totalFrameLen,
  });

  return Object.freeze({
    format: 'WCV2',
    sessionKey: key,
    manifest,
    planner,
    reader,
    header,
    _wcv2PackageId: w2.packageId,
    _wcv2RecordById: recordIndexById,
    decryptedResources: new Map(),
    temporaryUrls: new Set(),
  });
}

/**
 * Auto-detect format and create the appropriate session.
 */
export async function createSession(file, password) {
  const fmt = await detectFormat(file);
  if (fmt === 'WCV2') return createWcv2Session(file, password);
  return createWcv3Session(file, password);
}
