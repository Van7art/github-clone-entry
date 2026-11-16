// MCP server at /mcp: modern discovery (server/discover) and the legacy initialize
// handshake, tools/list with the six required tools, and tools/call wired to the same
// in-memory store as the REST and GraphQL surfaces so results are visible everywhere.
// Errors follow the SDK's own error contract: -32602 for a bad tool call, -32700 on a
// non-JSON body with HTTP 400, HTTP 401 when no Bearer token is presented.

import { getRepo, createRepo } from './store.ts';
import {
  repoJson,
  issueJson,
  pullJson,
  createIssueRecord,
  createPullRecord,
  mergePull,
} from './rest.ts';

const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Short repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function callTool(name, args) {
  if (name === 'create_repo') {
    if (typeof args?.name !== 'string' || args.name === '') return toolError('create_repo: "name" is required');
    const repo = createRepo(args.name, args.private === true, typeof args.description === 'string' ? args.description : '');
    if (repo === null) return toolError(`create_repo: repository "${args.name}" already exists`);
    return toolResult(repoJson(repo));
  }
  if (name === 'get_repo') {
    const repo = getRepo(args?.owner, args?.repo);
    if (repo === null) return toolError(`Repository ${args?.owner}/${args?.repo} not found`);
    return toolResult(repoJson(repo));
  }
  if (name === 'create_issue') {
    const repo = getRepo(args?.owner, args?.repo);
    if (repo === null) return toolError(`Repository ${args?.owner}/${args?.repo} not found`);
    if (typeof args?.title !== 'string' || args.title === '') return toolError('create_issue: "title" is required');
    const issue = createIssueRecord(repo, args.title, args.body ?? '', []);
    return toolResult(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const repo = getRepo(args?.owner, args?.repo);
    if (repo === null) return toolError(`Repository ${args?.owner}/${args?.repo} not found`);
    const state = typeof args?.state === 'string' ? args.state : 'open';
    const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
    return toolResult(issues.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const repo = getRepo(args?.owner, args?.repo);
    if (repo === null) return toolError(`Repository ${args?.owner}/${args?.repo} not found`);
    if (typeof args?.title !== 'string' || args.title === '') return toolError('create_pull_request: "title" is required');
    const head = typeof args?.head === 'string' ? args.head : '';
    const base = typeof args?.base === 'string' ? args.base : repo.defaultBranch;
    if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError(`create_pull_request: head branch "${head}" does not exist`);
    if (repo.refs.get(`refs/heads/${base}`) === undefined) return toolError(`create_pull_request: base branch "${base}" does not exist`);
    const pull = createPullRecord(repo, args.title, args.body ?? '', head, base);
    return toolResult(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const repo = getRepo(args?.owner, args?.repo);
    if (repo === null) return toolError(`Repository ${args?.owner}/${args?.repo} not found`);
    const pull = repo.pulls.get(args?.pull_number) ?? null;
    if (pull === null) return toolError(`Pull request #${String(args?.pull_number)} not found`);
    const method = typeof args?.merge_method === 'string' ? args.merge_method : 'squash';
    const result = mergePull(repo, pull, method);
    if (result.error !== undefined) return toolError(`merge_pull_request: ${result.error}`);
    return toolResult({ sha: result.sha, merged: true, message: 'Pull request successfully merged' });
  }
  return null;
}

function handleMessage(message) {
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const id = message.id ?? null;
  const method = message.method;
  const params = message.params ?? {};
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
        _meta: { sessionId: 'forge' },
      },
    };
  }
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // notification: no reply
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const name = params.name;
    const args = params.arguments ?? {};
    if (typeof name !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'tools/call requires a tool name' } };
    }
    const outcome = callTool(name, args);
    if (outcome === null) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    return { jsonrpc: '2.0', id, result: outcome };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

/**
 * Handle a POST /mcp body. Returns { status, body } where body is null for a 202
 * notification-only reply. The caller is responsible for the 401 auth check.
 */
export function handleMcp(bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map(handleMessage).filter((reply) => reply !== null);
    return { status: 200, body: replies };
  }
  const reply = handleMessage(parsed);
  if (reply === null) return { status: 202, body: null };
  return { status: 200, body: reply };
}
