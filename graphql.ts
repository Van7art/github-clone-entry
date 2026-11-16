// GitHub GraphQL v4: a small hand-written parser and executor for the documents gh and
// github-mcp-server actually send. No dependencies: the trial has no package manager.
// Supports operation names, variables, aliases, inline fragments, __type introspection,
// input objects, inline enums and batched operation arrays.

import { getRepo, globalId, decodeGlobalId, VIEWER, isoNow, nextSeq, listViewerRepos } from './store.ts';
import { createIssueRecord, createPullRecord, mergePull, pullFiles, pullMergeable } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const isNameStart = (ch) => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch) => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(kind, what) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${what ?? kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  match(kind) {
    if (this.peek().kind === kind) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'eof') {
      definitions.push(this.parseDefinition());
    }
    return definitions;
  }

  parseDefinition() {
    const token = this.peek();
    if (token.kind === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      const operation = this.next().value;
      let name = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expect('name').value;
      this.expect('name'); // 'on'
      const typeCondition = this.expect('name').value;
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', name, typeCondition, selections };
    }
    throw new Error(`unexpected token ${token.kind} ${JSON.stringify(token.value)} in GraphQL document`);
  }

  parseVariableDefinitions() {
    const variables = [];
    if (!this.match('(')) return variables;
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expect('name').value;
      this.expect(':');
      const type = this.parseType();
      let defaultValue;
      if (this.match('=')) defaultValue = this.parseValue(true);
      variables.push({ name, type, defaultValue });
    }
    this.expect(')');
    return variables;
  }

  parseType() {
    let type;
    if (this.match('[')) {
      const inner = this.parseType();
      this.expect(']');
      type = { kind: 'list', ofType: inner };
    } else {
      type = { kind: 'named', name: this.expect('name').value };
    }
    if (this.match('!')) type = { kind: 'nonNull', ofType: type };
    return type;
  }

  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection() {
    if (this.match('...')) {
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expect('name').value;
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      const name = this.expect('name').value;
      return { kind: 'fragmentSpread', name };
    }
    let name = this.expect('name').value;
    let alias = null;
    if (this.match(':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = this.parseArguments();
    let selections = null;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  parseArguments() {
    const args = {};
    if (!this.match('(')) return args;
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue(false);
    }
    this.expect(')');
    return args;
  }

  parseValue(isConst) {
    const token = this.next();
    if (token.kind === '$') return { kind: 'variable', name: this.expect('name').value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === '[') {
      const values = [];
      while (this.peek().kind !== ']') values.push(this.parseValue(isConst));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      const fields = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValue(isConst);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

function valueOf(node, variables) {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out = {};
      for (const [key, child] of Object.entries(node.fields)) out[key] = valueOf(child, variables);
      return out;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- schema surface (for __type)

const TYPE_FIELDS = Object.freeze({
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private', 'createdAt', 'updatedAt'],
  User: ['login', 'id', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  SearchType: [],
});

const SEARCH_TYPE_VALUES = Object.freeze(['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'LABEL', 'MILESTONE', 'TOPIC']);

// ---------------------------------------------------------------- execution

function typeNameOf(source) {
  return source?.__typename ?? null;
}

function resolveField(source, field, args, errors, typeName) {
  if (field === '__typename') return typeNameOf(source) ?? typeName;
  const value = source[field];
  if (value !== undefined) return typeof value === 'function' ? value(args) : value;
  errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return undefined;
}

/** Resolve a selection set against a source object; returns null when an error was recorded. */
function resolveSelections(source, selections, variables, errors, typeName, fragments) {
  if (source === null || source === undefined) return null;
  const out = {};
  let failed = false;
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments[selection.name];
      if (fragment !== undefined) {
        const sub = resolveSelections(source, fragment.selections, variables, errors, typeName, fragments);
        if (sub !== null) Object.assign(out, sub);
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === typeName) {
        const sub = resolveSelections(source, selection.selections, variables, errors, typeName, fragments);
        if (sub !== null) Object.assign(out, sub);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args = {};
    for (const [argName, argNode] of Object.entries(selection.args)) args[argName] = valueOf(argNode, variables);
    const raw = resolveField(source, selection.name, args, errors, typeName);
    if (raw === undefined) {
      failed = true;
      out[key] = null;
      continue;
    }
    if (selection.selections === null) {
      out[key] = raw;
    } else if (raw === null) {
      out[key] = null;
    } else if (Array.isArray(raw)) {
      out[key] = raw.map((item) => resolveSelections(item, selection.selections, variables, errors, typeNameOf(item) ?? typeName, fragments));
    } else if (typeof raw === 'object') {
      out[key] = resolveSelections(raw, selection.selections, variables, errors, typeNameOf(raw) ?? typeName, fragments);
    } else {
      out[key] = raw;
    }
  }
  return failed ? null : out;
}

// ---------------------------------------------------------------- resolvers

function userObject() {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function issueObject(repo, issue) {
  return {
    __typename: 'Issue',
    id: issue.globalId,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body ?? '',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: userObject(),
    comments: { nodes: [] },
    labels: issue.labels.map((name) => ({ name })),
    _repo: repo,
    _issue: issue,
  };
}

function pullObject(repo, pull) {
  return {
    __typename: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.head.sha,
    baseRefOid: pull.base.sha,
    files: (args) => {
      const files = pullFiles(repo, pull);
      const first = typeof args?.first === 'number' ? args.first : files.length;
      return { __typename: 'PullRequestChangedFileConnection', nodes: files.slice(0, first).map((f) => ({ __typename: 'PullRequestChangedFile', path: f.filename })) };
    },
    author: userObject(),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    _repo: repo,
    _pull: pull,
  };
}

function cursorFor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor) {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issuesConnection(repo, args) {
  let issues = [...repo.issues.values()];
  if (Array.isArray(args?.states) && args.states.length > 0) {
    const wanted = new Set(args.states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args?.orderBy ?? null;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  const field = orderBy?.field;
  issues.sort((a, b) => {
    if (field === 'COMMENTS') return (a.comments.length - b.comments.length) * direction;
    if (field === 'UPDATED_AT') return (a.updatedSeq - b.updatedSeq) * direction;
    return (a.createdSeq - b.createdSeq) * direction;
  });
  const afterNumber = numberFromCursor(args?.after ?? null);
  if (afterNumber !== null) {
    const index = issues.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = typeof args?.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1].number) : null,
    },
    totalCount: repo.issues.size,
  };
}

function repoObject(repo) {
  return {
    __typename: 'Repository',
    id: repo.globalId,
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    defaultBranchRef: (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null) === null
      ? null
      : { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    issue: (args) => {
      const issue = repo.issues.get(args?.number) ?? null;
      return issue === null ? null : issueObject(repo, issue);
    },
    issues: (args) => issuesConnection(repo, args),
    pullRequest: (args) => {
      const pull = repo.pulls.get(args?.number) ?? null;
      return pull === null ? null : pullObject(repo, pull);
    },
    pullRequests: (args) => {
      let pulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args?.first === 'number' ? args.first : pulls.length;
      return {
        __typename: 'PullRequestConnection',
        nodes: pulls.slice(0, first).map((pull) => pullObject(repo, pull)),
        pageInfo: { __typename: 'PageInfo', hasNextPage: pulls.length > first, endCursor: null },
        totalCount: pulls.length,
      };
    },
    _repo: repo,
  };
}

function nodeObject(decoded) {
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    for (const repo of listViewerRepos()) {
      if (repo.dbId === parseInt(decoded.key, 10)) return repoObject(repo);
    }
    return null;
  }
  if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest' || decoded.kind === 'IssueComment') {
    const [dbId, number, commentId] = decoded.key.split(':').map((part) => parseInt(part, 10));
    for (const repo of listViewerRepos()) {
      if (repo.dbId !== dbId) continue;
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(number) ?? null;
        return issue === null ? null : issueObject(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const pull = repo.pulls.get(number) ?? null;
        return pull === null ? null : pullObject(repo, pull);
      }
      const comment = repo.comments.get(commentId ?? -1) ?? null;
      return comment === null ? null : { __typename: 'IssueComment', id: comment.globalId, body: comment.body };
    }
    return null;
  }
  return null;
}

function typeObject(name) {
  const fields = TYPE_FIELDS[name] ?? null;
  if (fields === null && name !== 'SearchType') return null;
  return {
    __typename: '__Type',
    name,
    kind: name === 'SearchType' ? 'ENUM' : 'OBJECT',
    fields: fields === null ? null : fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })),
    enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) : null,
  };
}

function executeOperation(operation, variables, fragments) {
  const errors = [];
  const isMutation = operation.operation === 'mutation';
  let data = null;
  if (isMutation) {
    const root = {
      __typename: 'Mutation',
      createIssue: (args) => {
        const input = args?.input ?? {};
        const decoded = decodeGlobalId(input.repositoryId);
        if (decoded === null || decoded.kind !== 'Repository') {
          errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const repo = listViewerRepos().find((r) => r.dbId === parseInt(decoded.key, 10)) ?? null;
        if (repo === null) {
          errors.push({ message: 'createIssue: unknown repositoryId' });
          return null;
        }
        const issue = createIssueRecord(repo, input.title ?? '', input.body ?? '', []);
        return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', id: issue.globalId, number: issue.number } };
      },
      closeIssue: (args) => {
        const input = args?.input ?? {};
        const decoded = decodeGlobalId(input.issueId);
        const found = findIssueByGlobalId(decoded);
        if (found === null) {
          errors.push({ message: 'closeIssue: unknown issueId' });
          return null;
        }
        const { issue } = found;
        issue.state = 'closed';
        issue.updatedAt = isoNow();
        issue.updatedSeq = nextSeq();
        return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', id: issue.globalId, number: issue.number, state: 'CLOSED' } };
      },
      createPullRequest: (args) => {
        const input = args?.input ?? {};
        const decoded = decodeGlobalId(input.repositoryId);
        if (decoded === null || decoded.kind !== 'Repository') {
          errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const repo = listViewerRepos().find((r) => r.dbId === parseInt(decoded.key, 10)) ?? null;
        if (repo === null) {
          errors.push({ message: 'createPullRequest: unknown repositoryId' });
          return null;
        }
        const headRef = input.headRefName ?? '';
        const baseRef = input.baseRefName ?? repo.defaultBranch;
        if (repo.refs.get(`refs/heads/${headRef}`) === undefined || repo.refs.get(`refs/heads/${baseRef}`) === undefined) {
          errors.push({ message: 'createPullRequest: head or base branch does not exist' });
          return null;
        }
        const pull = createPullRecord(repo, input.title ?? '', input.body ?? '', headRef, baseRef);
        return {
          __typename: 'CreatePullRequestPayload',
          pullRequest: { __typename: 'PullRequest', id: pull.globalId, number: pull.number, state: 'OPEN', headRefName: headRef, baseRefName: baseRef },
        };
      },
      mergePullRequest: (args) => {
        const input = args?.input ?? {};
        const decoded = decodeGlobalId(input.pullRequestId);
        const found = findPullByGlobalId(decoded);
        if (found === null) {
          errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
          return null;
        }
        const { repo, pull } = found;
        const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
        const result = mergePull(repo, pull, method);
        if (result.error !== undefined) {
          errors.push({ message: `mergePullRequest: ${result.error}` });
          return null;
        }
        return {
          __typename: 'MergePullRequestPayload',
          pullRequest: { __typename: 'PullRequest', id: pull.globalId, number: pull.number, merged: true, state: 'MERGED' },
        };
      },
      addComment: (args) => {
        const input = args?.input ?? {};
        const decoded = decodeGlobalId(input.subjectId);
        const found = findIssueByGlobalId(decoded);
        if (found === null) {
          errors.push({ message: 'addComment: unknown subjectId' });
          return null;
        }
        const { repo, issue } = found;
        const id = repo.nextComment++;
        const now = isoNow();
        const comment = {
          id,
          globalId: globalId('IssueComment', `${repo.dbId}:${issue.number}:${id}`),
          body: input.body ?? '',
          createdAt: now,
          updatedAt: now,
          createdSeq: nextSeq(),
        };
        repo.comments.set(id, comment);
        issue.comments.push(id);
        issue.updatedAt = now;
        issue.updatedSeq = nextSeq();
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: comment.globalId, body: comment.body } },
        };
      },
    };
    data = resolveSelections(root, operation.selections, variables, errors, 'Mutation', fragments);
  } else {
    const root = {
      __typename: 'Query',
      viewer: () => userObject(),
      repository: (args) => {
        const repo = getRepo(args?.owner, args?.name);
        return repo === null ? null : repoObject(repo);
      },
      node: (args) => nodeObject(decodeGlobalId(args?.id)),
      __type: (args) => typeObject(args?.name),
    };
    data = resolveSelections(root, operation.selections, variables, errors, 'Query', fragments);
  }
  if (errors.length > 0) return { data: null, errors };
  return { data, errors: [] };
}

function findIssueByGlobalId(decoded) {
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const [dbId, number] = decoded.key.split(':').map((part) => parseInt(part, 10));
  for (const repo of listViewerRepos()) {
    if (repo.dbId !== dbId) continue;
    const issue = repo.issues.get(number) ?? null;
    if (issue !== null) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(decoded) {
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const [dbId, number] = decoded.key.split(':').map((part) => parseInt(part, 10));
  for (const repo of listViewerRepos()) {
    if (repo.dbId !== dbId) continue;
    const pull = repo.pulls.get(number) ?? null;
    if (pull !== null) return { repo, pull };
  }
  return null;
}

/** Execute one request body (object or array of operations). Returns the response body. */
export function executeGraphQL(body) {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(entry));
  }
  return executeOne(body);
}

function executeOne(entry) {
  if (entry === null || typeof entry !== 'object' || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL request must carry a query string' }] };
  }
  let definitions;
  try {
    definitions = new Parser(tokenize(entry.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const fragments = {};
  const operations = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments[definition.name] = definition;
    else operations.push(definition);
  }
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  const operation = operationName === null
    ? operations[0]
    : operations.find((op) => op.name === operationName) ?? null;
  if (operation === undefined || operation === null) {
    return { data: null, errors: [{ message: 'GraphQL operation not found' }] };
  }
  const variables = {};
  for (const variable of operation.variables) {
    if (entry.variables !== null && typeof entry.variables === 'object' && entry.variables[variable.name] !== undefined) {
      variables[variable.name] = entry.variables[variable.name];
    } else if (variable.defaultValue !== undefined) {
      variables[variable.name] = valueOf(variable.defaultValue, {});
    } else {
      variables[variable.name] = null;
    }
  }
  try {
    return executeOperation(operation, variables, fragments);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}
