# github-clone-entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Van7art/github-clone-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Van7art/github-clone-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one dependency-free Node process: git smart HTTP, REST v3, GraphQL v4 and MCP, all sharing one in-memory store. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.

Referral: [`4e96xqxt`](https://make.fun/r/4e96xqxt)

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` until it answers `{"done": true}`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2), `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Every REST reply is `application/json` with a non-empty `X-GitHub-Request-Id`; errors carry a string `message`. The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` takes none. A repository under any other owner is a 404, never a 403.

## How it works

- **One store, four surfaces.** `store.ts` holds every repository, ref, object, issue, pull request, label and comment in memory (the trial mounts the repo read-only, so all state is memory). REST, GraphQL and MCP all read and write the same records, so a pull request created over MCP is visible over REST and GraphQL immediately.
- **Real git, no binary.** `gitcore.ts` implements SHA-1 objects, trees, commits, tags, pack read/write including OFS/REF delta resolution, pkt-lines, reachability, diffs and three-way merge. `githttp.ts` speaks protocol v2 upload-pack (`ls-refs`, `fetch` with shallow support) and protocol v0 receive-pack with fast-forward checks and per-ref `ok`/`ng` reporting.
- **REST v3.** Repositories, branches, git refs/commits/trees/blobs, commits, contents (read, create, update with stale-sha 409, delete), labels, issues with comments, pull requests with files, commits and squash/merge/rebase merges with conflict detection (405).
- **GraphQL v4.** A hand-written parser and executor for the documents `gh` and `github-mcp-server` send: viewer, repository, node, `__type` introspection, issues with states/orderBy/pagination cursors, and the createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations.
- **MCP.** Modern `server/discover` plus the legacy `initialize` handshake, `tools/list` with the six required tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`), and `tools/call` with `-32602` on a bad call and `-32700` on a non-JSON body.
- **No UI, no outside service, no proxy.** The forge is an API server only, exactly as the contest asks.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server and router.
- `store.ts`: the in-memory store (repositories, refs, objects, issues, pulls, labels, comments).
- `gitcore.ts`: SHA-1 objects, packs, pkt-lines, diffs, merges.
- `githttp.ts`: git smart HTTP.
- `rest.ts`: REST v3 resources and routing.
- `graphql.ts`: GraphQL v4 parser and executor.
- `mcp.ts`: the MCP server.
- `package.json`, `LICENSE` (MIT): the entry's metadata and licence.

## Local grading

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types /tmp/serve-entry.ts
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token [--perf]
```

The kit's runner (`sdk/run.ts`) runs the same conformance checks the sealed env runs, against a server you started yourself.
