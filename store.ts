// The forge's in-memory store: every repository, ref, object, issue, pull request, label
// and comment lives here. One process, no database, no filesystem: the trial mounts the
// entry read-only, so all state is memory. The suite drives one bearer token; the forge is
// a single-user forge and that token names the seeded scenario viewer, adaiversen
// (wire.ts's SCENARIO_SEED is constant, so the viewer login is fixed).

export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0'.repeat(40);

/** A monotonically increasing sequence: creation order, and the clock for ordering. */
let seqCounter = 1;
export function nextSeq() {
  return seqCounter++;
}

let dbIdCounter = 1;
let requestCounter = 1;
export function nextRequestId() {
  return `req_${Date.now().toString(36)}${(requestCounter++).toString(36)}`;
}

/** An opaque, stable global id: base64url of "<Kind>:<key>", never the plain database id. */
export function globalId(kind, key) {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Decode a global id made by globalId(); null when it is not one. */
export function decodeGlobalId(id) {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

export function isoNow() {
  return new Date().toISOString();
}

/** One repository: its git objects and refs plus its REST resources. */
export function createRepoRecord(name, isPrivate, description) {
  const dbId = dbIdCounter++;
  return {
    dbId,
    globalId: globalId('Repository', dbId),
    name,
    owner: VIEWER.login,
    private: isPrivate === true,
    description: typeof description === 'string' ? description : '',
    defaultBranch: DEFAULT_BRANCH,
    createdSeq: nextSeq(),
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    comments: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
  };
}

export const store = {
  repos: new Map(),
};

export function repoKey(owner, name) {
  return `${owner}/${name}`;
}

export function getRepo(owner, name) {
  return store.repos.get(repoKey(owner, name)) ?? null;
}

/** Create a repository owned by the viewer; null when the name is taken. */
export function createRepo(name, isPrivate, description) {
  if (store.repos.has(repoKey(VIEWER.login, name))) return null;
  const repo = createRepoRecord(name, isPrivate, description);
  store.repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}

export function deleteRepo(owner, name) {
  return store.repos.delete(repoKey(owner, name));
}

/** Every repository the viewer owns, in creation order. */
export function listViewerRepos() {
  const out = [];
  for (const repo of store.repos.values()) {
    if (repo.owner === VIEWER.login) out.push(repo);
  }
  out.sort((a, b) => a.createdSeq - b.createdSeq);
  return out;
}

/** The tip oid of a ref, or null. `ref` may be a branch name or a full ref. */
export function refTip(repo, ref) {
  if (ref === undefined || ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asHead = repo.refs.get(`refs/heads/${ref}`);
  if (asHead !== undefined) return asHead;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag !== undefined) return asTag;
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return ref.toLowerCase();
  return null;
}

/** The default branch tip, or null when the repository is unborn. */
export function defaultTip(repo) {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}
