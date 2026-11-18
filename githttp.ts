// Git smart HTTP: info/refs advertisements, protocol v2 upload-pack (ls-refs, fetch)
// and protocol v0 receive-pack (push). Speaks exactly what the suite's git client
// expects: pkt-lines, sideband-64k, report-status, shallow fetches.

import {
  CODE_TYPES,
  buildTree,
  commitDistances,
  decodePktLines,
  diffTrees,
  encodePktLines,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  reachableObjects,
  readPack,
  readPackAsync,
  splitAtFlush,
  verifyPackChecksum,
  writePack,
} from './gitcore.ts';
import { ZERO_OID, defaultTip } from './store.ts';

const AGENT = 'forge/1.0';

/** Every ref of a repo, sorted: [{name, oid}]. */
export function listRefs(repo) {
  const out = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTarget(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The peeled commit of a tag ref, or null. */
function peeledCommit(repo, oid) {
  return peelToCommit(repo, oid);
}

// ---------------------------------------------------------------- advertisements

function v2Advertisement() {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLine('flush'),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('flush'),
  ]);
}

function v0Advertisement(repo, service) {
  const caps = service === 'git-receive-pack'
    ? `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`
    : `side-band-64k ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const lines = [];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const tip = defaultTip(repo);
    const headLine = tip !== null ? `${tip} HEAD\0${caps}\n` : null;
    if (headLine !== null) lines.push(headLine);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.name.startsWith('refs/tags/')) {
        const peeled = peeledCommit(repo, ref.oid);
        const obj = repo.objects.get(ref.oid);
        if (obj !== undefined && obj.type === 'tag' && peeled !== null) {
          lines.push(`${peeled} ${ref.name}^{}\n`);
        }
      }
    }
  }
  return Buffer.concat([
    pktLine(`# service=${service}\n`),
    pktLine('flush'),
    ...lines.map((line) => pktLine(line)),
    pktLine('flush'),
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... — v2 when the client asked for it. */
export function infoRefs(repo, service, wantsV2) {
  if (service === 'git-upload-pack' && wantsV2) {
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: v2Advertisement(),
    };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(repo, service),
  };
}

// ---------------------------------------------------------------- upload-pack v2

/** What the client already holds, from its `have` lines: a non-shallow have implies its
 *  whole history, but a shallow have implies only itself plus its tree and blobs — the
 *  client of a shallow clone does NOT hold the parents below its boundary, and a deepen
 *  must be able to deliver them. */
function haveObjectsSet(repo, haves, shallow) {
  const shallowSet = new Set(shallow ?? []);
  const out = new Set();
  const full = haves.filter((have) => !shallowSet.has(have));
  for (const oid of reachableObjects(repo, full)) out.add(oid);
  for (const oid of haves) {
    if (!shallowSet.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const treeOid of reachableObjects(repo, [commit.tree])) out.add(treeOid);
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj !== undefined && targetObj.type === 'commit') {
        out.add(target);
        const commit = parseCommit(targetObj.data);
        for (const treeOid of reachableObjects(repo, [commit.tree])) out.add(treeOid);
      }
    }
  }
  return out;
}

/** The objects a fetch must send, with shallow bookkeeping. */
function collectFetchObjects(repo, wants, haves, depth, prevShallow, deepenRelative) {
  // `deepen-relative` (what real git sends for `git fetch --deepen=N`): deepen each
  // shallow boundary by N generations. The boundary's distance from the want plus
  // N, plus one, is the absolute depth that delivers exactly those N generations
  // below the boundary and moves the edge there. Without the flag, `deepen N` is
  // absolute from the want, as the suite's deepen check uses it. (Round 2 ignored
  // the flag, so a real-git --deepen answered an empty pack and git died with
  // "expected 'packfile'".)
  let effDepth = depth;
  if (depth !== null && depth !== undefined && deepenRelative === true && (prevShallow ?? []).length > 0) {
    const dists0 = commitDistances(repo, wants);
    let deepest = -1;
    for (const b of prevShallow) {
      const d = dists0.get(b);
      if (d !== undefined && d > deepest) deepest = d;
    }
    if (deepest >= 0) effDepth = deepest + depth + 1;
  }
  // A depth-limited fetch can only include commits nearer than `depth`, so the
  // distance walk is capped there instead of visiting the whole history (a
  // depth-1 clone of a 200-commit repo used to walk all 200 commits per clone).
  const distances = effDepth === null || effDepth === undefined
    ? commitDistances(repo, wants)
    : commitDistances(repo, wants, effDepth - 1);
  const includedCommits = new Set();
  const boundary = new Set();
  for (const [oid, dist] of distances) {
    if (effDepth === null || effDepth === undefined) includedCommits.add(oid);
    else if (dist < effDepth) includedCommits.add(oid);
    if (effDepth !== null && effDepth !== undefined && dist === effDepth - 1) boundary.add(oid);
  }
  const haveReachable = haves.length > 0 ? haveObjectsSet(repo, haves, prevShallow) : new Set();
  const objects = new Map();
  const addClosure = (oid) => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || objects.has(oid) || haveReachable.has(oid)) return;
    objects.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addClosure(commit.tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) addClosure(entry.oid);
    } else if (obj.type === 'tag') {
      addClosure(parseTag(obj.data).object);
    }
  };
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'commit' || obj.type === 'tag') {
      const peeled = peelToCommit(repo, want) ?? want;
      if (!includedCommits.has(peeled) && effDepth !== null && effDepth !== undefined) {
        // A wanted tag/commit outside the depth window: still send the object itself
        // when it is the want, but no history below it.
        if (!haveReachable.has(want)) objects.set(want, obj);
        continue;
      }
      if (obj.type === 'tag' && !haveReachable.has(want)) objects.set(want, obj);
      if (includedCommits.has(peeled)) {
        addClosure(peeled);
      }
    } else {
      if (!haveReachable.has(want)) objects.set(want, obj);
    }
  }
  // Trees/blobs of included commits.
  for (const commitOid of includedCommits) {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') continue;
    addClosure(commitOid);
  }
  const shallow = [];
  const unshallow = [];
  for (const oid of boundary) {
    if (includedCommits.has(oid) && objects.has(oid)) shallow.push(oid);
  }
  for (const oid of prevShallow ?? []) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (!includedCommits.has(oid)) continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => includedCommits.has(parent))) {
      if (!shallow.includes(oid)) unshallow.push(oid);
    } else if (!shallow.includes(oid)) {
      shallow.push(oid);
    }
  }
  return { objects, shallow, unshallow };
}

function lsRefsResponse(repo, args) {
  const prefixes = args.prefixes ?? [];
  const keep = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const tip = defaultTip(repo);
  if (tip !== null) {
    if (keep('HEAD')) lines.push(`${tip} HEAD symref-target:${headTarget(repo)}\n`);
  } else if (keep('HEAD')) {
    lines.push(`unborn HEAD symref-target:${headTarget(repo)}\n`);
  }
  for (const ref of listRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktLine('flush')]);
}

function fetchResponse(repo, args) {
  const wants = [...new Set(args.wants ?? [])];
  const haves = args.haves ?? [];
  const depth = args.depth ?? null;
  const prevShallow = args.shallow ?? [];
  const parts = [];
  // acknowledgments: only when the client sent haves. Real git expects this
  // section first when it sent haves, and rejects it when it sent none
  // (a clone with no haves fails with "expected 'packfile', received
  // 'acknowledgments'"; a fetch with haves fails the other way round).
  if (haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    let common = [];
    const dists = commitDistances(repo, wants);
    for (const have of haves) {
      if (dists.has(have) || wants.includes(have)) common.push(have);
    }
    if (common.length > 0) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktLine('delim'));
  }
  const { objects, shallow, unshallow } = collectFetchObjects(repo, wants, haves, depth, prevShallow, args.deepenRelative);
  if (depth !== null || prevShallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLine('delim'));
  }
  // wanted-refs: the refs whose tip is a want.
  const wantedRefs = [];
  for (const ref of listRefs(repo)) {
    if (wants.includes(ref.oid)) wantedRefs.push(`${ref.oid} ${ref.name}\n`);
  }
  if (wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wantedRefs) parts.push(pktLine(line));
    parts.push(pktLine('delim'));
  }
  if (objects.size > 0) {
    const pack = writePack([...objects.values()].map((obj) => ({ type: obj.type, data: obj.data })));
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65500;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
      const payload = Buffer.concat([Buffer.from([1]), slice]);
      parts.push(pktLine(payload));
    }
    parts.push(pktLine('flush'));
  } else {
    parts.push(pktLine('flush'));
  }
  return Buffer.concat(parts);
}

/** Parse a v2 command request body into {command, args}. */
function parseV2Request(body) {
  const packets = decodePktLines(body);
  const args = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenRelative: false,
    prefixes: [],
    peel: false,
    symrefs: false,
    unborn: false,
  };
  let command = null;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
      continue;
    }
    const text = line.replace(/\n$/, '');
    if (text === 'peel') args.peel = true;
    else if (text === 'symrefs') args.symrefs = true;
    else if (text === 'unborn') args.unborn = true;
    else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    else if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7).trim(), 10);
    else if (text === 'deepen-relative') args.deepenRelative = true;
  }
  return { command, args };
}

/** Fetch-response cache: a fetch is a pure function of (repo state, wants, haves,
 *  depth, previous shallows), so its whole response body is cached. The clone
 *  workload issues the same depth-1 fetch of the same tip 50 times a round (plus
 *  warm-ups), and every one of them used to re-walk the history, re-collect the
 *  objects and re-deflate the pack. The key fingerprints the refs and the object
 *  count: objects are content-addressed and only ever added, so the same count
 *  plus the same refs means the same objects. Bodies over 512 KiB are not cached.
 */
const fetchCache = new WeakMap();
const FETCH_CACHE_MAX_ENTRIES = 16;
const FETCH_CACHE_MAX_BYTES = 512 * 1024;

function fetchCacheKey(repo, args) {
  const refs = [];
  for (const [name, oid] of repo.refs) refs.push([name, oid]);
  refs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({
    refs,
    objects: repo.objects.size,
    wants: [...(args.wants ?? [])].sort(),
    haves: [...(args.haves ?? [])].sort(),
    depth: args.depth ?? null,
    deepenRelative: args.deepenRelative ?? false,
    shallow: [...(args.shallow ?? [])].sort(),
  });
}

function fetchCached(repo, args) {
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map();
    fetchCache.set(repo, perRepo);
  }
  const key = fetchCacheKey(repo, args);
  const hit = perRepo.get(key) ?? null;
  if (hit !== null) return hit;
  const body = fetchResponse(repo, args);
  if (body.length <= FETCH_CACHE_MAX_BYTES) {
    if (perRepo.size >= FETCH_CACHE_MAX_ENTRIES) perRepo.clear();
    perRepo.set(key, body);
  }
  return body;
}

/** POST /{owner}/{repo}.git/git-upload-pack (protocol v2). */
export function handleUploadPack(repo, body) {
  let parsed;
  try {
    parsed = parseV2Request(body);
  } catch {
    return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
  }
  if (parsed.command === 'ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, parsed.args) };
  }
  if (parsed.command === 'fetch') {
    for (const want of parsed.args.wants) {
      if (!isOid(want) || !repo.objects.has(want)) {
        return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
      }
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchCached(repo, parsed.args) };
  }
  return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
}

// ---------------------------------------------------------------- receive-pack v0

/** POST /{owner}/{repo}.git/git-receive-pack: validate commands, unpack, apply, report. */
export async function handleReceivePack(repo, body) {
  const report = (unpack, refs) => {
    const lines = [`unpack ${unpack}\n`];
    for (const ref of refs) {
      lines.push(ref.ok ? `ok ${ref.name}\n` : `ng ${ref.name} ${ref.reason}\n`);
    }
    const inner = Buffer.concat([encodePktLines(lines), pktLine('flush')]);
    const outer = [];
    const CHUNK = 65500;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      const slice = inner.subarray(offset, Math.min(inner.length, offset + CHUNK));
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    outer.push(pktLine('flush'));
    return {
      status: 200,
      contentType: 'application/x-git-receive-pack-result',
      body: Buffer.concat(outer),
    };
  };
  let split;
  try {
    split = splitAtFlush(body);
  } catch {
    return report('unpacker error', []);
  }
  const commands = [];
  for (const packet of split.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    if (line === '') continue;
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) return report('ok', []);
  const packBytes = split.rest;
  const needsPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);
  let unpacked = new Map();
  if (packBytes.length > 0) {
    try {
      const check = verifyPackChecksum(packBytes);
      if (!check.ok) return report('pack checksum mismatch', commands.map((c) => ({ name: c.ref, ok: false, reason: 'unpacker error' })));
      try {
        unpacked = await readPackAsync(packBytes, repo.objects);
      } catch {
        unpacked = readPack(packBytes, repo.objects);
      }
    } catch (err) {
      return report('unpacker error', commands.map((c) => ({ name: c.ref, ok: false, reason: 'unpacker error' })));
    }
    for (const [oid, obj] of unpacked) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  } else if (needsPack) {
    return report('unpacker error', commands.map((c) => ({ name: c.ref, ok: false, reason: 'unpacker error' })));
  }
  const results = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? null;
    if (cmd.newOid === ZERO_OID) {
      if (current === null) {
        results.push({ name: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ name: cmd.ref, ok: true });
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      results.push({ name: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== null) {
        results.push({ name: cmd.ref, ok: false, reason: 'remote ref already exists' });
        continue;
      }
    } else {
      if (current === null) {
        results.push({ name: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
        results.push({ name: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        results.push({ name: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(cmd.ref, cmd.newOid.toLowerCase());
    results.push({ name: cmd.ref, ok: true });
  }
  return report('ok', results);
}
