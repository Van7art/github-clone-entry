// The forge's HTTP server: one process, four surfaces. Git smart HTTP at
// /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp,
// plus the env's /healthz boot probe. Every REST reply is application/json with a
// non-empty X-GitHub-Request-Id; errors carry a string message. The bearer token from
// MAKEFUN_SHOP_TOKEN names the viewer; without it every protected surface is a 401,
// and a repository under any other owner is a 404, never a 403.

import { createServer } from 'node:http';
import { getRepo, nextRequestId } from './store.ts';
import { routeRest } from './rest.ts';
import { infoRefs, handleUploadPack, handleReceivePack } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function bearerToken(req) {
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match === null ? null : match[1];
}

function authorized(req) {
  if (EXPECTED_TOKEN === '') return true;
  const token = bearerToken(req);
  return token !== null && token === EXPECTED_TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers) {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...(headers ?? {}) });
  res.end(text);
}

function sendRaw(res, status, body, contentType) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function urlOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp() {
  return createServer(async (req, res) => {
    const url = urlOf(req);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      // The env's boot check: 200 {"ok":true}, no token needed.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const service = gitMatch[3];
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const repo = getRepo(owner, repoName);
        if (repo === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(req);
        if (method === 'GET' && service === 'info/refs') {
          const serviceParam = url.searchParams.get('service') ?? '';
          if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          const result = infoRefs(repo, serviceParam, wantsV2);
          sendRaw(res, result.status, result.body, result.contentType);
          return;
        }
        if (method === 'POST' && service === 'git-upload-pack') {
          const result = handleUploadPack(repo, body);
          sendRaw(res, result.status, result.body, result.contentType);
          return;
        }
        if (method === 'POST' && service === 'git-receive-pack') {
          const result = handleReceivePack(repo, body);
          sendRaw(res, result.status, result.body, result.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // MCP: POST /mcp only.
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(body.toString('utf8'));
        if (result.body === null) {
          res.writeHead(result.status);
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // GraphQL v4: POST /api/graphql only.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const body = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { data: null, errors: [{ message: 'request body must be valid JSON' }] });
          return;
        }
        sendJson(res, 200, executeGraphQL(parsed));
        return;
      }

      // REST v3: /api/v3 and everything under it.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const requestId = nextRequestId();
        const headers = { 'x-github-request-id': requestId };
        const segments = path.slice('/api/v3'.length).split('/').filter((part) => part !== '');
        const isPublic = segments.length === 0 || segments[0] === 'meta' || segments[0] === 'rate_limit';
        if (!authorized(req) && !isPublic) {
          sendJson(res, 401, { message: 'Requires authentication' }, headers);
          return;
        }
        const body = await readBody(req);
        let json = null;
        if (body.length > 0 && (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE')) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'request body must be valid JSON' }, headers);
            return;
          }
        }
        const query = {};
        for (const [key, value] of url.searchParams) query[key] = value;
        const host = req.headers.host ?? '127.0.0.1';
        const result = routeRest(method, segments, query, json, host);
        if (result === null) {
          sendJson(res, 404, { message: 'Not Found' }, headers);
          return;
        }
        if (result.status === 204 || result.json === null) {
          res.writeHead(result.status, { ...headers, ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.json, { ...headers, ...(result.headers ?? {}) });
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      else res.end();
    }
  });
}
