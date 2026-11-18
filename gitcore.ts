// Pure git: object hashing, packfiles, pkt-lines, reachability, trees and merges.
// No I/O, no state of its own: every function works on a repository record from store.ts
// (its `objects` map) or on plain buffers. SHA-1 throughout, as the suite speaks sha1.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID } from './store.ts';

export const TYPE_CODES = Object.freeze({ commit: 1, tree: 2, blob: 3, tag: 4 });
export const CODE_TYPES = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });

export function sha1(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The id of a loose object: sha1("<type> <len>\0" + data). */
export function hashObject(type, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.from(`${type} ${buf.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, buf]));
}

export function objectHeader(type, size) {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

export function isOid(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

// ---------------------------------------------------------------- trees

/** Parse a tree object's entries: [{mode, name, oid}]. */
export function parseTree(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries = [];
  let offset = 0;
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode terminator');
    const mode = buf.subarray(offset, space).toString('ascii');
    const nul = buf.indexOf(0, space + 1);
    if (nul < 0) throw new Error('malformed tree: no name terminator');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries sorted the way git sorts them. */
export function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into path -> {oid, mode}. */
export function flattenTree(repo, treeOid, prefix, out) {
  const result = out ?? new Map();
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return result;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, result);
    else result.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return result;
}

/**
 * Build the nested tree objects for a flat file map and store them; returns the root tree oid.
 * Directories are created as needed; empty directories are dropped, as git does.
 */
export function treeFromFiles(repo, files) {
  const build = (dirPrefix) => {
    const entries = [];
    const subdirs = new Map();
    for (const [path, file] of files) {
      if (dirPrefix !== '' && !path.startsWith(`${dirPrefix}/`)) continue;
      const rest = dirPrefix === '' ? path : path.slice(dirPrefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: file.mode, name: rest, oid: file.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!subdirs.has(dir)) subdirs.set(dir, true);
      }
    }
    for (const dir of [...subdirs.keys()].sort()) {
      const childPrefix = dirPrefix === '' ? dir : `${dirPrefix}/${dir}`;
      const childOid = build(childPrefix);
      if (childOid !== null) entries.push({ mode: '40000', name: dir, oid: childOid });
    }
    if (entries.length === 0) return null;
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  const root = build('');
  if (root === null) {
    const data = buildTree([]);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  }
  return root;
}

// ---------------------------------------------------------------- commits and tags

/** Parse a commit object: {tree, parents, author, committer, message}. */
export function parseCommit(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const headerText = buf.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. `epochSec` is the author/committer time. */
export function buildCommit({ tree, parents, author, committer, message, epochSec }) {
  const when = `${epochSec} +0000`;
  const who = (ident) => `${ident} ${when}`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who(author)}`);
  lines.push(`committer ${who(committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** Parse an annotated tag object: {object, type, tag, tagger, message}. */
export function parseTag(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headerEnd = blank < 0 ? buf.length : blank;
  const headerText = buf.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/** Peel a tag object to its target commit oid (following nested tags). */
export function peelToCommit(repo, oid) {
  let current = oid;
  const seen = new Set();
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    current = parseTag(obj.data).object;
  }
}

// ---------------------------------------------------------------- reachability

/** Walk commit parents from `tips` (BFS); returns Map oid -> distance (0 = a tip).
 *  The queue is an index pointer (no shift(): the old shift() made this O(n^2) on
 *  long histories). `maxDepth` caps the walk: with it, only commits at distance
 *  <= maxDepth are returned and only those below maxDepth are expanded, so a
 *  depth-limited fetch visits just the commits it can include. */
export function commitDistances(repo, tips, maxDepth) {
  const dist = new Map();
  const queue = [];
  let head = 0;
  for (const tip of tips) {
    const peeled = peelToCommit(repo, tip) ?? tip;
    if (repo.objects.get(peeled)?.type === 'commit' && !dist.has(peeled)) {
      dist.set(peeled, 0);
      queue.push(peeled);
    }
  }
  const cap = maxDepth === undefined || maxDepth === null ? Infinity : maxDepth;
  while (head < queue.length) {
    const oid = queue[head++];
    const depth = dist.get(oid);
    if (depth >= cap) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent) && repo.objects.has(parent)) {
        dist.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

/** True when `ancestor` is reachable from `oid` (or equal to it). A targeted DFS
 *  from the tip that stops the moment the ancestor is found: the old full-history
 *  BFS walked (and parsed) every commit on every push, which is O(history) per
 *  push even when the ancestor is the direct parent, as it is for a fast-forward. */
export function isAncestor(repo, ancestor, oid) {
  if (ancestor === oid) return true;
  const start = peelToCommit(repo, oid) ?? oid;
  if (start === ancestor) return true;
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the nearest common ancestor, or null. */
export function mergeBase(repo, a, b) {
  const da = commitDistances(repo, [a]);
  if (da.has(b)) return b;
  const db = commitDistances(repo, [b]);
  if (db.has(a)) return a;
  let best = null;
  let bestScore = Infinity;
  for (const [oid, depthA] of da) {
    const depthB = db.get(oid);
    if (depthB === undefined) continue;
    const score = depthA + depthB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

/** All object ids reachable from a set of tips (commits, trees, blobs, tags). */
export function reachableObjects(repo, tips) {
  const out = new Set();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

// ---------------------------------------------------------------- packs

function applyDelta(base, delta) {
  let pos = 0;
  const readDeltaVarint = () => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[pos++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readDeltaVarint();
  const out = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/**
 * Parse a packfile (v2) into objects. Resolves OFS and REF deltas; REF-delta bases may
 * come from `haveObjects` (objects the sender already holds). Throws on a bad pack.
 */
export function readPack(pack, haveObjects) {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buf[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = null;
    let baseOid = null;
    if (typeCode === 6) {
      byte = buf[offset++];
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    // The last entry runs to the pack trailer (20 bytes): no search needed.
    const end = i === count - 1 ? buf.length - 20 : findDeflateEnd(buf, offset, size);
    const data = inflateSync(buf.subarray(offset, end));
    if (data.length !== size) throw new Error('pack entry size mismatch');
    entries.push({ offset: entryOffset, typeCode, baseOffset, baseOid, data });
    offset = end;
  }
  const objects = new Map();
  const byOffset = new Map(entries.map((e) => [e.offset, e]));
  let oidIndex = null;
  const resolvedByOffset = new Map();
  const resolve = (entry, seen) => {
    if (resolvedByOffset.has(entry.offset)) return resolvedByOffset.get(entry.offset);
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let resolved;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      resolved = { type: CODE_TYPES[entry.typeCode], data: entry.data };
    } else {
      let base = null;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry, seen);
      } else {
        // Fast path: direct objects are indexed by oid once (one hash each), so a
        // REF-delta base that is a plain object is found without re-resolving and
        // re-hashing every entry for every delta (the old loop was O(n^2) hashes).
        if (oidIndex === null) {
          oidIndex = new Map();
          for (const direct of entries) {
            if (direct.typeCode >= 1 && direct.typeCode <= 4) {
              const resolvedDirect = resolve(direct, new Set());
              oidIndex.set(hashObject(resolvedDirect.type, resolvedDirect.data), direct);
            }
          }
        }
        const baseEntry = oidIndex.get(entry.baseOid);
        if (baseEntry !== undefined) {
          base = resolve(baseEntry, new Set(seen));
        } else {
          for (const candidate of entries) {
            if (candidate.offset === entry.offset) continue;
            const tried = resolve(candidate, new Set(seen));
            if (hashObject(tried.type, tried.data) === entry.baseOid) {
              base = tried;
              break;
            }
          }
        }
        if (base === null && haveObjects !== undefined && haveObjects.has(entry.baseOid)) {
          base = haveObjects.get(entry.baseOid);
        }
        if (base === null) throw new Error('ref-delta base not available');
      }
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolvedByOffset.set(entry.offset, resolved);
    return resolved;
  };
  for (const entry of entries) {
    const resolved = resolve(entry, new Set());
    const oid = hashObject(resolved.type, resolved.data);
    objects.set(oid, resolved);
  }
  return objects;
}

/** Find where a raw deflate stream starting at `offset` ends (binary search: inflateSync
 *  tolerates trailing bytes but fails on a truncated stream). */
function findDeflateEnd(buf, offset, expectedSize) {
  let lo = offset + 1;
  let hi = buf.length - 20; // leave room for the pack trailer
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const data = inflateSync(buf.subarray(offset, mid));
      ok = data.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (answer < 0) throw new Error('could not find the end of a deflate stream in the pack');
  return answer;
}

function writePackObjectHeader(type, size) {
  const typeCode = TYPE_CODES[type];
  const bytes = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a packfile (v2, no deltas) from objects; entries are zlib-deflated raw. */
export function writePack(objects) {
  const list = [...objects];
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** Inflate one pack entry's deflate stream with a streaming Inflate, returning its
 *  data and the offset just past the stream. The stream's bytesWritten once the
 *  stream ends is exactly the consumed input length, so this needs one inflate
 *  and no binary search with throwing probes (the sync findDeflateEnd spends
 *  ~0.1 ms per throwing probe). Rejects when the stream errors, yields the wrong
 *  size, or does not finish promptly; the caller falls back to the sync reader. */
export function inflateEntryAsync(buf, offset, expectedSize) {
  return new Promise((resolve, reject) => {
    const inf = createInflate();
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => done(new Error('inflate timed out')), 1000);
    const done = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      inf.destroy();
      if (err !== null && err !== undefined) reject(err);
      else resolve(result);
    };
    inf.on('data', (chunk) => chunks.push(chunk));
    inf.on('error', (err) => done(err));
    inf.on('end', () => {
      const data = Buffer.concat(chunks);
      if (data.length !== expectedSize) done(new Error('pack entry size mismatch'));
      else done(null, { data, end: offset + inf.bytesWritten });
    });
    inf.write(buf.subarray(offset));
  });
}

/** Async readPack: same objects and delta resolution as readPack, but each
 *  entry is inflated with one streaming Inflate instead of the binary search.
 *  Any failure rejects so the caller can fall back to the sync reader. */
export async function readPackAsync(pack, haveObjects) {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buf[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = null;
    let baseOid = null;
    if (typeCode === 6) {
      byte = buf[offset++];
      let base = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[offset++];
        base = ((base + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, end } = await inflateEntryAsync(buf, offset, size);
    entries.push({ offset: entryOffset, typeCode, baseOffset, baseOid, data });
    offset = end;
  }
  const objects = new Map();
  const byOffset = new Map(entries.map((e) => [e.offset, e]));
  let oidIndex = null;
  const resolvedByOffset = new Map();
  const resolve = (entry, seen) => {
    if (resolvedByOffset.has(entry.offset)) return resolvedByOffset.get(entry.offset);
    if (seen.has(entry.offset)) throw new Error('delta cycle in pack');
    seen.add(entry.offset);
    let resolved;
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      resolved = { type: CODE_TYPES[entry.typeCode], data: entry.data };
    } else {
      let base = null;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseEntry, seen);
      } else {
        if (oidIndex === null) {
          oidIndex = new Map();
          for (const direct of entries) {
            if (direct.typeCode >= 1 && direct.typeCode <= 4) {
              const resolvedDirect = resolve(direct, new Set());
              oidIndex.set(hashObject(resolvedDirect.type, resolvedDirect.data), direct);
            }
          }
        }
        const baseEntry = oidIndex.get(entry.baseOid);
        if (baseEntry !== undefined) {
          base = resolve(baseEntry, new Set(seen));
        } else {
          for (const candidate of entries) {
            if (candidate.offset === entry.offset) continue;
            const tried = resolve(candidate, new Set(seen));
            if (hashObject(tried.type, tried.data) === entry.baseOid) {
              base = tried;
              break;
            }
          }
        }
        if (base === null && haveObjects !== undefined && haveObjects.has(entry.baseOid)) {
          base = haveObjects.get(entry.baseOid);
        }
        if (base === null) throw new Error('ref-delta base not available');
      }
      resolved = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolvedByOffset.set(entry.offset, resolved);
    return resolved;
  };
  for (const entry of entries) {
    const resolved = resolve(entry, new Set());
    const oid = hashObject(resolved.type, resolved.data);
    objects.set(oid, resolved);
  }
  return objects;
}

/** Verify a packfile's trailer checksum. */
export function verifyPackChecksum(pack) {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 20) return { ok: false };
  const actual = buf.subarray(buf.length - 20).toString('hex');
  const expected = sha1(buf.subarray(0, buf.length - 20));
  return { ok: actual === expected, expected, actual };
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (payload string or bytes); 'flush' and 'delim' are controls. */
export function pktLine(payload) {
  if (payload === 'flush') return Buffer.from('0000', 'ascii');
  if (payload === 'delim') return Buffer.from('0001', 'ascii');
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line payload too large');
  const len = data.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), data]);
}

export function encodePktLines(lines) {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

/**
 * Decode a buffer of pkt-lines into packets: {kind: 'data'|'flush'|'delim', payload}.
 * Throws on a malformed length. `allowPartial` tolerates a trailing incomplete line.
 */
export function decodePktLines(buf, allowPartial) {
  const packets = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      if (allowPartial === true) break;
      throw new Error('truncated pkt-line length');
    }
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) {
        if (allowPartial === true) break;
        throw new Error('truncated pkt-line payload');
      }
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return packets;
}

/** Split a buffer at the first flush pkt-line: [packetsBeforeFlush, rest]. The rest is raw
 *  pack data, not pkt-lines, so decoding stops at the flush instead of trying to parse
 *  the pack header ("PACK") as a length. */
export function splitAtFlush(buf) {
  const packets = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const lenHex = buf.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      return { packets, rest: buf.subarray(offset + 4) };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------- diffs and merges

/** Diff two trees: [{path, status: 'added'|'modified'|'removed', oldOid, newOid}]. */
export function diffTrees(repo, oldTreeOid, newTreeOid) {
  const oldFiles = oldTreeOid === null ? new Map() : flattenTree(repo, oldTreeOid, '', new Map());
  const newFiles = newTreeOid === null ? new Map() : flattenTree(repo, newTreeOid, '', new Map());
  const out = [];
  for (const [path, file] of newFiles) {
    const old = oldFiles.get(path);
    if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: file.oid });
    else if (old.oid !== file.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: file.oid });
  }
  for (const [path, file] of oldFiles) {
    if (!newFiles.has(path)) out.push({ path, status: 'removed', oldOid: file.oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Count added/removed lines between two blobs with a simple LCS over lines. */
export function lineDiff(oldData, newData) {
  const oldLines = oldData === null ? [] : oldData.toString('utf8').split('\n');
  const newLines = newData === null ? [] : newData.toString('utf8').split('\n');
  if (oldLines.length > 400 || newLines.length > 400) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const n = oldLines.length;
  const m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += n - i;
  additions += m - j;
  return { additions, deletions };
}

/**
 * Three-way merge of trees for a squash merge: apply the head's changes (baseTree -> headTree)
 * onto the base tip's tree. Returns {treeOid, conflicts} where conflicts are paths changed on
 * both sides with different results.
 */
export function threeWayMerge(repo, baseTreeOid, headTreeOid, baseTipTreeOid) {
  const baseFiles = baseTreeOid === null ? new Map() : flattenTree(repo, baseTreeOid, '', new Map());
  const headFiles = headTreeOid === null ? new Map() : flattenTree(repo, headTreeOid, '', new Map());
  const tipFiles = baseTipTreeOid === null ? new Map() : flattenTree(repo, baseTipTreeOid, '', new Map());
  const merged = new Map(tipFiles);
  const conflicts = [];
  const headDiff = diffTrees(repo, baseTreeOid, headTreeOid);
  const tipDiff = diffTrees(repo, baseTreeOid, baseTipTreeOid);
  const tipChanged = new Map(tipDiff.map((d) => [d.path, d]));
  for (const change of headDiff) {
    const tipChange = tipChanged.get(change.path);
    if (tipChange !== undefined && tipChange.newOid !== change.newOid) {
      conflicts.push(change.path);
      continue;
    }
    if (change.status === 'removed') merged.delete(change.path);
    else merged.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  const treeOid = treeFromFiles(repo, merged);
  return { treeOid, conflicts };
}
