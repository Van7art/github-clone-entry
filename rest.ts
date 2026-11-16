// GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels
// and pull requests. Every reply is JSON with an X-GitHub-Request-Id; errors carry a
// string message. The bearer token names the viewer (adaiversen); a repository under any
// other owner is a 404, never a 403; no token is a 401.

import {
  buildCommit,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  lineDiff,
  mergeBase,
  parseCommit,
  parseTree,
  threeWayMerge,
  treeFromFiles,
} from './gitcore.ts';
import {
  VIEWER,
  createRepo,
  defaultTip,
  deleteRepo,
  getRepo,
  globalId,
  isoNow,
  listViewerRepos,
  nextSeq,
  refTip,
} from './store.ts';

const AUTHOR = `${VIEWER.name} <${VIEWER.email}>`;

function epochNow() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- shapes

export function repoJson(repo) {
  return {
    id: repo.globalId,
    databaseId: repo.dbId,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    created_at: isoNow(),
    updated_at: isoNow(),
    has_issues: true,
    has_pull_requests: true,
  };
}

function labelJson(label) {
  return { name: label.name, color: label.color ?? 'ededed', description: label.description ?? '' };
}

export function issueJson(repo, issue) {
  return {
    id: issue.globalId,
    node_id: issue.globalId,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo, issue, comment) {
  return {
    id: comment.id,
    node_id: comment.globalId,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function pullJson(repo, pull) {
  return {
    id: pull.globalId,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------- git-backed file commits

/**
 * Commit one file on a branch (creating the branch from the default tip, or the
 * repository itself, when needed). Returns {status, commitSha, blobSha} or {error, status}.
 */
export function commitFile(repo, branchName, path, contentBuf, message, expectedSha) {
  const branchRef = `refs/heads/${branchName}`;
  let tip = repo.refs.get(branchRef) ?? null;
  let parentTreeOid = null;
  let files = new Map();
  if (tip !== null) {
    const commit = parseCommit(repo.objects.get(tip).data);
    parentTreeOid = commit.tree;
    files = flattenTree(repo, commit.tree, '', new Map());
  }
  const existing = files.get(path) ?? null;
  if (existing !== null) {
    if (expectedSha !== undefined && expectedSha !== null && expectedSha.toLowerCase() !== existing.oid.toLowerCase()) {
      return { error: 'sha does not match the current file', status: 409 };
    }
  }
  const blobOid = hashObject('blob', contentBuf);
  repo.objects.set(blobOid, { type: 'blob', data: Buffer.from(contentBuf) });
  files.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = treeFromFiles(repo, files);
  const parents = tip !== null ? [tip] : [];
  const commitData = buildCommit({
    tree: treeOid,
    parents,
    author: AUTHOR,
    committer: AUTHOR,
    message,
    epochSec: epochNow(),
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(branchRef, commitOid);
  return {
    status: existing !== null ? 200 : 201,
    commitSha: commitOid,
    blobSha: blobOid,
    created: existing === null,
  };
}

/** Delete one file on a branch. Returns {status, commitSha} or {error, status}. */
export function deleteFile(repo, branchName, path, message) {
  const branchRef = `refs/heads/${branchName}`;
  const tip = repo.refs.get(branchRef) ?? null;
  if (tip === null) return { error: 'Not Found', status: 404 };
  const commit = parseCommit(repo.objects.get(tip).data);
  const files = flattenTree(repo, commit.tree, '', new Map());
  if (!files.has(path)) return { error: 'Not Found', status: 404 };
  files.delete(path);
  const treeOid = treeFromFiles(repo, files);
  const commitData = buildCommit({
    tree: treeOid,
    parents: [tip],
    author: AUTHOR,
    committer: AUTHOR,
    message,
    epochSec: epochNow(),
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(branchRef, commitOid);
  return { status: 200, commitSha: commitOid };
}

/** Walk commits from a tip, newest first (depth-first, parents after children). */
export function listCommits(repo, tipOid) {
  const out = [];
  const seen = new Set();
  const stack = [tipOid];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    out.push({ sha: oid, commit });
    for (const parent of commit.parents) stack.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------- pull requests

/** The merge-base commit of a pull request (head tip vs base tip). */
function pullMergeBase(repo, pull) {
  const headTip = refTip(repo, pull.head.ref);
  const baseTip = refTip(repo, pull.base.ref);
  if (headTip === null || baseTip === null) return null;
  return mergeBase(repo, headTip, baseTip);
}

/** Whether a pull request merges cleanly onto its base right now. */
export function pullMergeable(repo, pull) {
  if (pull.state !== 'open') return false;
  const base = pullMergeBase(repo, pull);
  if (base === null) return false;
  const baseCommit = parseCommit(repo.objects.get(base).data);
  const headTip = refTip(repo, pull.head.ref);
  const baseTip = refTip(repo, pull.base.ref);
  if (headTip === null || baseTip === null) return false;
  const headCommit = parseCommit(repo.objects.get(headTip).data);
  const baseTipCommit = parseCommit(repo.objects.get(baseTip).data);
  const { conflicts } = threeWayMerge(repo, baseCommit.tree, headCommit.tree, baseTipCommit.tree);
  return conflicts.length === 0;
}

/** The files a pull request changes (merge-base tree -> head tree), with line counts. */
export function pullFiles(repo, pull) {
  const base = pullMergeBase(repo, pull);
  const headTip = refTip(repo, pull.head.ref);
  if (base === null || headTip === null) return [];
  const baseCommit = parseCommit(repo.objects.get(base).data);
  const headCommit = parseCommit(repo.objects.get(headTip).data);
  const changes = diffTrees(repo, baseCommit.tree, headCommit.tree);
  const out = [];
  for (const change of changes) {
    const oldData = change.oldOid === null ? null : repo.objects.get(change.oldOid)?.data ?? null;
    const newData = change.newOid === null ? null : repo.objects.get(change.newOid)?.data ?? null;
    const counts = lineDiff(oldData, newData);
    out.push({
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

/**
 * Squash-merge a pull request onto its base. Returns {status, sha, message} or an error.
 * 404 unknown, 405 conflicted, 200 merged.
 */
export function mergePull(repo, pull, method) {
  if (pull.state !== 'open') return { error: 'Pull request is not open', status: 405 };
  const base = pullMergeBase(repo, pull);
  const headTip = refTip(repo, pull.head.ref);
  const baseTip = refTip(repo, pull.base.ref);
  if (base === null || headTip === null || baseTip === null) {
    return { error: 'Pull request cannot be merged', status: 405 };
  }
  const baseCommit = parseCommit(repo.objects.get(base).data);
  const headCommit = parseCommit(repo.objects.get(headTip).data);
  const baseTipCommit = parseCommit(repo.objects.get(baseTip).data);
  const { treeOid, conflicts } = threeWayMerge(repo, baseCommit.tree, headCommit.tree, baseTipCommit.tree);
  if (conflicts.length > 0) return { error: 'Merge conflict', status: 405 };
  const message = method === 'squash'
    ? `${pull.title} (#${pull.number})`
    : `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: AUTHOR,
    committer: AUTHOR,
    message,
    epochSec: epochNow(),
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.updatedAt = isoNow();
  pull.mergeCommitSha = commitOid;
  pull.base.sha = commitOid;
  return { status: 200, sha: commitOid, merged: true, message: `Pull request successfully merged` };
}

// ---------------------------------------------------------------- issues

export function createIssueRecord(repo, title, body, labelNames) {
  const number = repo.nextIssue++;
  const now = isoNow();
  const issue = {
    number,
    globalId: globalId('Issue', `${repo.dbId}:${number}`),
    title,
    body: body ?? '',
    state: 'open',
    labels: [...(labelNames ?? [])],
    createdAt: now,
    updatedAt: now,
    createdSeq: nextSeq(),
    updatedSeq: nextSeq(),
    comments: [],
    user: VIEWER.login,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function createPullRecord(repo, title, body, headRef, baseRef) {
  const number = repo.nextPull++;
  const now = isoNow();
  const headSha = refTip(repo, headRef);
  const baseSha = refTip(repo, baseRef);
  const pull = {
    number,
    globalId: globalId('PullRequest', `${repo.dbId}:${number}`),
    title,
    body: body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    createdAt: now,
    updatedAt: now,
    createdSeq: nextSeq(),
    updatedSeq: nextSeq(),
  };
  repo.pulls.set(number, pull);
  return pull;
}

// ---------------------------------------------------------------- routing

function parsePage(query) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.per_page ?? '30', 10) || 30));
  return { page, perPage };
}

function pageOf(items, query) {
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, perPage, total: items.length };
}

function notFound(message) {
  return { status: 404, json: { message: message ?? 'Not Found' } };
}

function badRequest(message) {
  return { status: 400, json: { message: message ?? 'Bad Request' } };
}

function unprocessable(message) {
  return { status: 422, json: { message: message ?? 'Validation Failed' } };
}

/** Route one REST request. `segments` are the path parts after /api/v3. */
export function routeRest(method, segments, query, body, host) {
  const notFoundRepo = () => notFound('Not Found');
  const needRepo = (owner, name) => {
    if (owner !== VIEWER.login) return null;
    return getRepo(owner, name);
  };

  // GET /api/v3/ (root) and GET /api/v3/meta
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        json: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { installed_version: '1.0.0' } };
  }
  if (segments[0] === 'rate_limit' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      json: { resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0, used: 0 } },
    };
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, json: { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email } };
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = listViewerRepos();
      const { items, page, perPage, total } = pageOf(repos, query);
      const headers = {};
      if ((page - 1) * perPage + items.length < total) {
        headers.link = `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(total / perPage)}>; rel="last"`;
      }
      return { status: 200, json: items.map(repoJson), headers };
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        return unprocessable('Validation Failed: name is required');
      }
      const repo = createRepo(name, body.private === true, body.description);
      if (repo === null) return unprocessable('Repository already exists');
      return { status: 201, json: repoJson(repo) };
    }
    return notFound();
  }

  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET') return notFound();
    if (segments[1] === VIEWER.login) {
      return { status: 200, json: { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email } };
    }
    return notFound();
  }

  if (segments[0] !== 'repos' || segments.length < 3) return null;
  const owner = segments[1];
  const name = segments[2];
  const rest = segments.slice(3);
  const repo = needRepo(owner, name);
  if (repo === null) {
    // A repository under another owner, or a missing one: 404, never 403.
    if (method === 'GET' || method === 'PATCH' || method === 'DELETE' || method === 'POST' || method === 'PUT') {
      return notFoundRepo();
    }
    return notFoundRepo();
  }

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      return { status: 200, json: repoJson(repo) };
    }
    if (method === 'DELETE') {
      deleteRepo(owner, name);
      return { status: 204, json: null };
    }
    return notFound();
  }

  const head = rest[0];

  // branches
  if (head === 'branches' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    const branches = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, json: branches };
  }

  // branches/{branch}
  if (head === 'branches' && rest.length === 2) {
    if (method !== 'GET') return notFound();
    const branchName = decodeURIComponent(rest[1]);
    const oid = repo.refs.get(`refs/heads/${branchName}`) ?? null;
    if (oid === null) return notFound('Not Found');
    return { status: 200, json: { name: branchName, commit: { sha: oid }, protected: false } };
  }

  // git/refs
  if (head === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'GET') {
      const refs = [];
      for (const [refName, oid] of [...repo.refs.entries()].sort()) {
        const obj = repo.objects.get(oid);
        refs.push({
          ref: refName,
          node_id: globalId('Ref', `${repo.dbId}:${refName}`),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${refName}`,
          object: { sha: oid, type: obj?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` },
        });
      }
      return { status: 200, json: refs };
    }
    if (method !== 'POST') return notFound();
    const ref = typeof body?.ref === 'string' ? body.ref : '';
    const sha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : '';
    if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
      return unprocessable('Validation Failed: ref and sha are required');
    }
    if (repo.refs.has(ref)) return unprocessable('Reference already exists');
    repo.refs.set(ref, sha);
    return { status: 201, json: { ref, object: { sha, type: repo.objects.get(sha).type }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` } };
  }

  // git/refs/{ref...}
  if (head === 'git' && rest[1] === 'refs' && rest.length >= 3) {
    const refName = rest.slice(2).map(decodeURIComponent).join('/');
    const oid = repo.refs.get(refName) ?? null;
    if (method === 'GET') {
      if (oid === null) return notFound('Not Found');
      const obj = repo.objects.get(oid);
      return {
        status: 200,
        json: {
          ref: refName,
          node_id: globalId('Ref', `${repo.dbId}:${refName}`),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${refName}`,
          object: { sha: oid, type: obj?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${oid}` },
        },
      };
    }
    if (method === 'PATCH') {
      if (oid === null) return notFound('Not Found');
      const sha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!isOid(sha) || !repo.objects.has(sha)) return unprocessable('Validation Failed: sha is required');
      if (body?.force !== true && !isAncestor(repo, oid, sha)) {
        return unprocessable('Validation Failed: Update is not a fast forward');
      }
      repo.refs.set(refName, sha);
      return { status: 200, json: { ref: refName, object: { sha, type: repo.objects.get(sha).type } } };
    }
    if (method === 'DELETE') {
      if (oid === null) return notFound('Not Found');
      repo.refs.delete(refName);
      return { status: 204, json: null };
    }
    return notFound();
  }

  // git/commits, git/trees, git/blobs
  if (head === 'git' && rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
    const sha = decodeURIComponent(rest[2]).toLowerCase();
    const obj = repo.objects.get(sha) ?? null;
    if (obj === null || obj.type !== 'commit') return notFound('Not Found');
    const commit = parseCommit(obj.data);
    return {
      status: 200,
      json: {
        sha,
        node_id: globalId('Commit', `${repo.dbId}:${sha}`),
        url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}`,
        author: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
        committer: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
        message: commit.message,
        tree: { sha: commit.tree },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      },
    };
  }
  if (head === 'git' && rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
    const sha = decodeURIComponent(rest[2]).toLowerCase();
    const obj = repo.objects.get(sha) ?? null;
    if (obj === null || obj.type !== 'tree') return notFound('Not Found');
    const tree = [];
    if (query.recursive === '1') {
      const flat = flattenTree(repo, sha, '', new Map());
      for (const [filePath, entry] of [...flat.entries()].sort()) {
        const child = repo.objects.get(entry.oid);
        tree.push({ path: filePath, mode: entry.mode, type: 'blob', sha: entry.oid, size: child?.data.length ?? 0 });
      }
    } else {
      for (const entry of parseTree(obj.data)) {
        const child = repo.objects.get(entry.oid);
        tree.push({
          path: entry.name,
          mode: entry.mode,
          type: child?.type === 'tree' ? 'tree' : 'blob',
          sha: entry.oid,
          size: child?.type === 'blob' ? child.data.length : undefined,
        });
      }
    }
    return { status: 200, json: { sha, url: `/api/v3/repos/${owner}/${name}/git/trees/${sha}`, tree, truncated: false } };
  }
  if (head === 'git' && rest[1] === 'blobs' && rest.length === 3 && method === 'GET') {
    const sha = decodeURIComponent(rest[2]).toLowerCase();
    const obj = repo.objects.get(sha) ?? null;
    if (obj === null || obj.type !== 'blob') return notFound('Not Found');
    return {
      status: 200,
      json: {
        sha,
        size: obj.data.length,
        url: `/api/v3/repos/${owner}/${name}/git/blobs/${sha}`,
        content: obj.data.toString('base64'),
        encoding: 'base64',
      },
    };
  }

  // commits
  if (head === 'commits' && rest.length === 1) {
    if (method !== 'GET') return notFound();
    const tip = refTip(repo, query.sha) ?? defaultTip(repo);
    if (tip === null) return { status: 200, json: [] };
    const commits = listCommits(repo, tip).map(({ sha, commit }) => ({
      sha,
      commit: {
        message: commit.message,
        author: { name: VIEWER.name, email: VIEWER.email },
        committer: { name: VIEWER.name, email: VIEWER.email },
      },
      author: { login: VIEWER.login, id: VIEWER.id },
    }));
    return { status: 200, json: commits };
  }

  // commits/{sha}
  if (head === 'commits' && rest.length === 2 && method === 'GET') {
    const sha = decodeURIComponent(rest[1]).toLowerCase();
    const obj = repo.objects.get(sha) ?? null;
    if (obj === null || obj.type !== 'commit') return notFound('Not Found');
    const commit = parseCommit(obj.data);
    return {
      status: 200,
      json: {
        sha,
        commit: {
          message: commit.message,
          author: { name: VIEWER.name, email: VIEWER.email },
          committer: { name: VIEWER.name, email: VIEWER.email },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        author: { login: VIEWER.login, id: VIEWER.id },
      },
    };
  }

  // contents
  if (head === 'contents') {
    const path = rest.slice(1).map(decodeURIComponent).join('/');
    if (method === 'GET') {
      const tip = refTip(repo, query.ref) ?? defaultTip(repo);
      if (tip === null) return notFound('Not Found');
      const commit = parseCommit(repo.objects.get(tip).data);
      const files = flattenTree(repo, commit.tree, '', new Map());
      const file = files.get(path);
      if (file !== undefined) {
        const data = repo.objects.get(file.oid).data;
        return {
          status: 200,
          json: {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: path.split('/').pop(),
            path,
            content: data.toString('base64'),
            sha: file.oid,
          },
        };
      }
      // A directory listing.
      const prefix = path === '' ? '' : `${path}/`;
      const entries = [];
      const seenDirs = new Set();
      for (const [filePath, entry] of files) {
        if (!filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) {
          entries.push({ type: 'file', name: restPath, path: filePath, sha: entry.oid, size: repo.objects.get(entry.oid).data.length });
        } else {
          const dir = restPath.slice(0, slash);
          if (!seenDirs.has(dir)) {
            seenDirs.add(dir);
            entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: '' });
          }
        }
      }
      if (entries.length === 0) return notFound('Not Found');
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, json: entries };
    }
    if (method === 'PUT') {
      const message = typeof body?.message === 'string' ? body.message : 'Update';
      const contentB64 = typeof body?.content === 'string' ? body.content : '';
      if (contentB64 === '') return badRequest('content is required');
      let contentBuf;
      try {
        contentBuf = Buffer.from(contentB64, 'base64');
      } catch {
        return badRequest('content is not valid base64');
      }
      const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const result = commitFile(repo, branch, path, contentBuf, message, body?.sha);
      if (result.error !== undefined) return { status: result.status, json: { message: result.error } };
      const tip = repo.refs.get(`refs/heads/${branch}`);
      return {
        status: result.status,
        json: {
          content: { name: path.split('/').pop(), path, sha: result.blobSha, size: contentBuf.length, encoding: 'base64', type: 'file' },
          commit: { sha: result.commitSha, message },
        },
      };
    }
    if (method === 'DELETE') {
      const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const message = typeof body?.message === 'string' ? body.message : 'Delete';
      const result = deleteFile(repo, branch, path, message);
      if (result.error !== undefined) return { status: result.status, json: { message: result.error } };
      return { status: 200, json: { commit: { sha: result.commitSha, message } } };
    }
    return notFound();
  }

  // labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const labelName = typeof body?.name === 'string' ? body.name.trim() : '';
      if (labelName === '') return unprocessable('Validation Failed: name is required');
      const label = { name: labelName, color: typeof body?.color === 'string' ? body.color : 'ededed', description: typeof body?.description === 'string' ? body.description : '' };
      repo.labels.set(labelName, label);
      return { status: 201, json: labelJson(label) };
    }
    if (method === 'GET' && rest.length === 1) {
      return { status: 200, json: [...repo.labels.values()].map(labelJson) };
    }
    if (rest.length === 2) {
      const labelName = decodeURIComponent(rest[1]);
      const label = repo.labels.get(labelName) ?? null;
      if (label === null) return notFound('Not Found');
      if (method === 'GET') return { status: 200, json: labelJson(label) };
      if (method === 'PATCH') {
        if (typeof body?.name === 'string' && body.name !== '') {
          repo.labels.delete(label.name);
          label.name = body.name;
          repo.labels.set(label.name, label);
        }
        if (typeof body?.color === 'string') label.color = body.color;
        if (typeof body?.description === 'string') label.description = body.description;
        return { status: 200, json: labelJson(label) };
      }
      if (method === 'DELETE') {
        repo.labels.delete(label.name);
        return { status: 204, json: null };
      }
      return notFound();
    }
    return notFound();
  }

  // issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        if (title === '') return unprocessable('Validation Failed: title is required');
        const labelNames = Array.isArray(body?.labels) ? body.labels.filter((l) => typeof l === 'string') : [];
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) return unprocessable(`Validation Failed: label "${labelName}" does not exist`);
        }
        const issue = createIssueRecord(repo, title, body?.body, labelNames);
        return { status: 201, json: issueJson(repo, issue) };
      }
      if (method === 'GET') {
        let issues = [...repo.issues.values()];
        const state = query.state ?? 'open';
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const direction = query.direction === 'asc' ? 1 : -1;
        const sort = query.sort ?? 'created';
        issues.sort((a, b) => {
          const key = sort === 'comments' ? a.comments.length - b.comments.length : a.createdSeq - b.createdSeq;
          return key * direction;
        });
        const { items } = pageOf(issues, query);
        return { status: 200, json: items.map((issue) => issueJson(repo, issue)) };
      }
      return notFound();
    }
    const number = parseInt(rest[1], 10);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const issue = repo.issues.get(number) ?? null;
    if (rest.length === 2) {
      if (issue === null) return notFound('Not Found');
      if (method === 'GET') return { status: 200, json: issueJson(repo, issue) };
      if (method === 'PATCH') {
        if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.updatedAt = isoNow();
          issue.updatedSeq = nextSeq();
        }
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        if (Array.isArray(body?.labels)) {
          const labelNames = body.labels.filter((l) => typeof l === 'string');
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) return unprocessable(`Validation Failed: label "${labelName}" does not exist`);
          }
          issue.labels = labelNames;
        }
        return { status: 200, json: issueJson(repo, issue) };
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === null) return notFound('Not Found');
      if (method === 'POST') {
        const commentBody = typeof body?.body === 'string' ? body.body : '';
        if (commentBody === '') return unprocessable('Validation Failed: body is required');
        const id = repo.nextComment++;
        const now = isoNow();
        const comment = {
          id,
          globalId: globalId('IssueComment', `${repo.dbId}:${issue.number}:${id}`),
          body: commentBody,
          createdAt: now,
          updatedAt: now,
          createdSeq: nextSeq(),
        };
        repo.comments.set(id, comment);
        issue.comments.push(id);
        issue.updatedAt = now;
        issue.updatedSeq = nextSeq();
        return { status: 201, json: commentJson(repo, issue, comment) };
      }
      if (method === 'GET') {
        const comments = issue.comments
          .map((id) => repo.comments.get(id))
          .filter((c) => c !== undefined)
          .map((comment) => commentJson(repo, issue, comment));
        return { status: 200, json: comments };
      }
      return notFound();
    }
    return notFound();
  }

  // pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof body?.title === 'string' ? body.title : '';
        const headRef = typeof body?.head === 'string' ? body.head : '';
        const baseRef = typeof body?.base === 'string' ? body.base : repo.defaultBranch;
        if (title === '' || headRef === '') return unprocessable('Validation Failed: title and head are required');
        if (refTip(repo, headRef) === null) return unprocessable('Validation Failed: head branch does not exist');
        if (refTip(repo, baseRef) === null) return unprocessable('Validation Failed: base branch does not exist');
        const pull = createPullRecord(repo, title, body?.body, headRef, baseRef);
        return { status: 201, json: pullJson(repo, pull) };
      }
      if (method === 'GET') {
        let pulls = [...repo.pulls.values()];
        const state = query.state ?? 'open';
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.createdSeq - a.createdSeq);
        const { items } = pageOf(pulls, query);
        return { status: 200, json: items.map((pull) => pullJson(repo, pull)) };
      }
      return notFound();
    }
    const number = parseInt(rest[1], 10);
    if (!Number.isInteger(number) || number < 1) return notFound();
    const pull = repo.pulls.get(number) ?? null;
    if (rest.length === 2) {
      if (pull === null) return notFound('Not Found');
      if (method === 'GET') return { status: 200, json: pullJson(repo, pull) };
      if (method === 'PATCH') {
        if (typeof body?.title === 'string') pull.title = body.title;
        if (typeof body?.body === 'string') pull.body = body.body;
        if (body?.state === 'open' || body?.state === 'closed') pull.state = body.state;
        pull.updatedAt = isoNow();
        pull.updatedSeq = nextSeq();
        return { status: 200, json: pullJson(repo, pull) };
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === null) return notFound('Not Found');
      if (method !== 'GET') return notFound();
      return { status: 200, json: pullFiles(repo, pull) };
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (pull === null) return notFound('Not Found');
      if (method !== 'PUT') return notFound();
      const result = mergePull(repo, pull, body?.merge_method);
      if (result.error !== undefined) return { status: result.status, json: { message: result.error } };
      return { status: 200, json: { sha: result.sha, merged: true, message: result.message } };
    }
    if (rest.length === 3 && rest[2] === 'commits') {
      if (pull === null) return notFound('Not Found');
      if (method !== 'GET') return notFound();
      const base = pullMergeBase(repo, pull);
      const headTip = refTip(repo, pull.head.ref);
      const commits = [];
      if (base !== null && headTip !== null) {
        const baseAncestors = new Set();
        const stack = [base];
        while (stack.length > 0) {
          const oid = stack.pop();
          if (baseAncestors.has(oid)) continue;
          baseAncestors.add(oid);
          const obj = repo.objects.get(oid);
          if (obj !== undefined && obj.type === 'commit') stack.push(...parseCommit(obj.data).parents);
        }
        const seen = new Set();
        const walk = [headTip];
        while (walk.length > 0) {
          const oid = walk.pop();
          if (seen.has(oid) || baseAncestors.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (obj === undefined || obj.type !== 'commit') continue;
          const commit = parseCommit(obj.data);
          commits.push({
            sha: oid,
            commit: {
              message: commit.message,
              author: { name: VIEWER.name, email: VIEWER.email },
              committer: { name: VIEWER.name, email: VIEWER.email },
            },
            parents: commit.parents.map((parent) => ({ sha: parent })),
          });
          walk.push(...commit.parents);
        }
      }
      return { status: 200, json: commits };
    }
    if (rest.length === 3 && rest[2] === 'reviews') {
      if (pull === null) return notFound('Not Found');
      if (method !== 'GET') return notFound();
      return { status: 200, json: [] };
    }
    return notFound();
  }

  return null;
}
