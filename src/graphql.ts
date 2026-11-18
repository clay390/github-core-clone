// GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, nothing more.
//
// A small recursive-descent parser (fields, arguments with variables, inline input objects,
// inline fragments, aliases, operation batching) over the same store as REST, plus a hand-built
// introspection map for the types the suite feature-detects. Unknown fields answer HTTP 200
// with an `errors` array naming the field, exactly as GitHub does.

import { parseCommit } from './gitpack.ts';
import {
  branchName,
  diffTrees,
  getObject,
  mergeBase,
  mergeConflicts,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// global ids (opaque, stable): base64 of "Kind:..." — never the plain database id or number.
// -------------------------------------------------------------------------------------------

export function globalId(kind: string, parts: string): string {
  return Buffer.from(`${kind}:${parts}`).toString('base64');
}

function parseGlobalId(id: string): { kind: string; parts: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), parts: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${commentId}`);
}

function userGlobalId(login: string): string {
  return globalId('User', login);
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias: string | null;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selection: SelectionNode[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string | null;
  readonly selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  readonly kind: 'operation';
  readonly operation: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Record<string, { defaultValue: ValueNode | null }>;
  readonly selection: SelectionNode[];
}

interface FragmentDefNode {
  readonly kind: 'fragmentDef';
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

class Lexer {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipIgnored(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]+/.test(this.text[this.pos] as string)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skipIgnored();
    return this.text[this.pos] ?? '';
  }

  /** True when the next non-ignored characters are exactly `text` (used for `...`). */
  peekStartsWith(text: string): boolean {
    this.skipIgnored();
    return this.text.startsWith(text, this.pos);
  }

  next(): string {
    this.skipIgnored();
    const ch = this.text[this.pos] ?? '';
    if (ch === '') return '';
    if ('{}():$![]=@'.includes(ch) || ch === '.') {
      // '...' is three dots; a lone '.' is an error the parser reports.
      if (ch === '.' && this.text.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        return '...';
      }
      this.pos += 1;
      return ch;
    }
    if (ch === '"') {
      let out = '';
      this.pos += 1;
      while (this.pos < this.text.length) {
        const c = this.text[this.pos] as string;
        if (c === '"') {
          this.pos += 1;
          return JSON.stringify(out);
        }
        if (c === '\\') {
          const esc = this.text[this.pos + 1] ?? '';
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[esc] ?? esc;
          this.pos += 2;
          continue;
        }
        out += c;
        this.pos += 1;
      }
      throw new Error('unterminated string in GraphQL document');
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^-?\d+(?:\.\d+)?/.exec(this.text.slice(this.pos));
    if (match === null) throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
    this.pos += match[0].length;
    return match[0];
  }

  /** Read a raw token and tell whether it is a quoted string (returned JSON-encoded). */
  nextToken(): { text: string; quoted: boolean } {
    this.skipIgnored();
    if (this.text[this.pos] === '"') {
      const json = this.next();
      return { text: json, quoted: true };
    }
    return { text: this.next(), quoted: false };
  }
}

class Parser {
  private readonly lexer: Lexer;
  constructor(text: string) {
    this.lexer = new Lexer(text);
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentDefNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentDefNode>();
    while (this.lexer.peek() !== '') {
      const keyword = this.lexer.next();
      if (keyword === 'query' || keyword === 'mutation') {
        operations.push(this.parseOperation(keyword));
      } else if (keyword === 'fragment') {
        const def = this.parseFragmentDef();
        fragments.set(def.name, def);
      } else if (keyword === '{') {
        operations.push({ kind: 'operation', operation: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected ${JSON.stringify(keyword)} in GraphQL document`);
      }
    }
    if (operations.length === 0) throw new Error('GraphQL document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(operation: 'query' | 'mutation'): OperationNode {
    let name: string | null = null;
    const variables: Record<string, { defaultValue: ValueNode | null }> = {};
    let next = this.lexer.peek();
    if (/^[A-Za-z_]/.test(next)) {
      name = this.lexer.next();
      next = this.lexer.peek();
    }
    if (next === '(') {
      this.lexer.next();
      while (this.lexer.peek() !== ')' && this.lexer.peek() !== '') {
        if (this.lexer.next() !== '$') throw new Error('variable definition must start with $');
        const varName = this.lexer.next();
        if (this.lexer.next() !== ':') throw new Error('variable definition needs a type after :');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.lexer.peek() === '=') {
          this.lexer.next();
          defaultValue = this.parseValue();
        }
        variables[varName] = { defaultValue };
      }
      if (this.lexer.next() !== ')') throw new Error('unterminated variable definitions');
    }
    if (this.lexer.next() !== '{') throw new Error('operation needs a selection set');
    return { kind: 'operation', operation, name, variables, selection: this.parseSelectionSet() };
  }

  private parseType(): void {
    // Consume one whole type: a name, optionally wrapped in [ ... ] lists, optionally
    // followed by !. The executor does not validate types (the suite's documents are
    // well-typed), but the tokens must all be consumed or the next variable definition
    // starts on a leftover '!' and the parse fails.
    const token = this.lexer.next();
    if (token === '[') {
      this.parseType();
      if (this.lexer.next() !== ']') throw new Error('unclosed list type in variable definition');
    }
    if (this.lexer.peek() === '!') this.lexer.next();
  }

  private parseFragmentDef(): FragmentDefNode {
    const name = this.lexer.next();
    if (this.lexer.next() !== 'on') throw new Error('fragment definition needs "on"');
    const typeCondition = this.lexer.next();
    if (this.lexer.next() !== '{') throw new Error('fragment definition needs a selection set');
    return { kind: 'fragmentDef', name, typeCondition, selection: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    const selections: SelectionNode[] = [];
    while (this.lexer.peek() !== '}' && this.lexer.peek() !== '') {
      if (this.lexer.peekStartsWith('...')) {
        this.lexer.next(); // '...'
        // Read the next token whole: 'on', '{', or a fragment name. (peek() returns one
        // character, so comparing it to 'on' never matches.)
        const word = this.lexer.next();
        if (word === 'on') {
          const typeCondition = this.lexer.next();
          if (this.lexer.next() !== '{') throw new Error('inline fragment needs a selection set');
          selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (word === '{') {
          selections.push({ kind: 'fragment', typeCondition: null, selection: this.parseSelectionSet() });
        } else {
          // A named fragment spread: resolved by the executor against the definitions.
          selections.push({ kind: 'fragment', typeCondition: `...${word}`, selection: [] });
        }
        continue;
      }
      const first = this.lexer.next();
      let name = first;
      let alias: string | null = null;
      if (this.lexer.peek() === ':') {
        this.lexer.next();
        alias = first;
        name = this.lexer.next();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.lexer.peek() === '(') {
        this.lexer.next();
        while (this.lexer.peek() !== ')' && this.lexer.peek() !== '') {
          const argName = this.lexer.next();
          if (this.lexer.next() !== ':') throw new Error('argument needs a value after :');
          args.push({ name: argName, value: this.parseValue() });
        }
        if (this.lexer.next() !== ')') throw new Error('unterminated arguments');
      }
      // Directives (@...) are skipped: the suite sends none.
      while (this.lexer.peek() === '@') {
        this.lexer.next();
        this.lexer.next();
        if (this.lexer.peek() === '(') {
          let depth = 0;
          while (this.lexer.peek() !== '') {
            const token = this.lexer.next();
            if (token === '(') depth += 1;
            else if (token === ')') {
              depth -= 1;
              if (depth === 0) break;
            }
          }
        }
      }
      let selection: SelectionNode[] = [];
      if (this.lexer.peek() === '{') {
        this.lexer.next();
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', name, alias, args, selection });
    }
    if (this.lexer.next() !== '}') throw new Error('unterminated selection set');
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.lexer.nextToken();
    if (token.quoted) return { kind: 'string', value: JSON.parse(token.text) as string };
    const text = token.text;
    if (text === '$') {
      // nextToken consumed the '$' as a token; the name follows.
      return { kind: 'variable', name: this.lexer.next() };
    }
    if (text === '[') {
      const values: ValueNode[] = [];
      while (this.lexer.peek() !== ']' && this.lexer.peek() !== '') values.push(this.parseValue());
      if (this.lexer.next() !== ']') throw new Error('unterminated list');
      return { kind: 'list', values };
    }
    if (text === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.lexer.peek() !== '}' && this.lexer.peek() !== '') {
        const name = this.lexer.next();
        if (this.lexer.next() !== ':') throw new Error('input object field needs a value after :');
        fields.push({ name, value: this.parseValue() });
      }
      if (this.lexer.next() !== '}') throw new Error('unterminated input object');
      return { kind: 'object', fields };
    }
    if (text === 'true') return { kind: 'boolean', value: true };
    if (text === 'false') return { kind: 'boolean', value: false };
    if (text === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(text)) return { kind: 'int', value: Number(text) };
    if (/^-?\d+\.\d+$/.test(text)) return { kind: 'float', value: Number(text) };
    return { kind: 'enum', value: text };
  }
}

// -------------------------------------------------------------------------------------------
// introspection data
// -------------------------------------------------------------------------------------------

const TYPE_INFO: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'assignees', 'milestone', 'locked', 'repository', 'resourcePath', 'viewerCanUpdate', 'isPinned', 'isReadByViewer'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'author', 'labels', 'comments', 'commits', 'additions', 'deletions', 'changedFiles', 'repository', 'resourcePath', 'isDraft', 'viewerCanUpdate'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'pushedAt', 'forkCount', 'stargazerCount', 'watcherCount', 'primaryLanguage', 'resourcePath', 'viewerCanAdminister'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'resourcePath'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'resourcePath'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI', 'PROJECT', 'ORGANIZATION'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

const KNOWN_FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set(TYPE_INFO.Repository.fields ?? []),
  Issue: new Set(TYPE_INFO.Issue.fields ?? []),
  PullRequest: new Set(TYPE_INFO.PullRequest.fields ?? []),
  User: new Set(TYPE_INFO.User.fields ?? []),
  IssueComment: new Set(TYPE_INFO.IssueComment.fields ?? []),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  PullRequestChangedFileEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  Ref: new Set(['name', 'prefix', 'target']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  AddCommentEdge: new Set(['node', 'cursor']),
  __Type: new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __EnumValue: new Set(['name', 'description', 'isDeprecated', 'deprecationReason']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
};

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

interface Ctx {
  readonly store: Store;
  readonly errors: Array<{ message: string }>;
  readonly fragments: Map<string, FragmentDefNode>;
}

type Obj = Record<string, unknown> & { __typename: string };

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObj(store: Store, repo: Repo, issue: Issue): Obj {
  return {
    __typename: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
  };
}

function pullObj(store: Store, repo: Repo, pull: Pull): Obj {
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const mergeable = pull.state === 'open' ? (mergeConflicts(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergeable,
    headRefName: branchName(pull.headRef),
    baseRefName: branchName(pull.baseRef),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    closedAt: pull.closedAt,
    mergedAt: pull.mergedAt,
  };
}

function repoObj(store: Store, repo: Repo): Obj {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    pushedAt: repo.updatedAt,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function userObj(store: Store, login: string): Obj {
  const viewer = store.viewer;
  return {
    __typename: 'User',
    id: userGlobalId(login),
    login,
    name: login === viewer.login ? viewer.name : login,
    email: login === viewer.login ? viewer.email : `${login}@example.invalid`,
    url: `https://github.com/${login}`,
    avatarUrl: '',
    resourcePath: `/${login}`,
  };
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const value = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

/** Resolve a value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Execute a selection set against one object; unknown fields add errors and resolve null. */
function executeSelection(ctx: Ctx, obj: Obj, selections: SelectionNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition.startsWith('...')) {
        const def = ctx.fragments.get(selection.typeCondition.slice(3));
        if (def !== undefined && (def.typeCondition === obj.__typename || def.typeCondition === obj.__typename)) {
          Object.assign(out, executeSelection(ctx, obj, def.selection, variables));
        }
        continue;
      }
      if (selection.typeCondition === null || selection.typeCondition === obj.__typename) {
        Object.assign(out, executeSelection(ctx, obj, selection.selection, variables));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    out[key] = executeField(ctx, obj, selection, variables);
  }
  return out;
}

function executeField(ctx: Ctx, obj: Obj, field: FieldNode, variables: Record<string, unknown>): unknown {
  const typeName = obj.__typename;
  if (field.name === '__typename') return typeName;
  const known = KNOWN_FIELDS[typeName];
  if (known !== undefined && !known.has(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const args = argsOf(field, variables);
  const value = resolveField(ctx, obj, field.name, args);
  if (field.selection.length === 0) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => (isRecord(entry) && typeof entry.__typename === 'string' ? executeSelection(ctx, entry as Obj, field.selection, variables) : entry));
  }
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelection(ctx, value as Obj, field.selection, variables);
  }
  return value;
}

function resolveField(ctx: Ctx, obj: Obj, name: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  switch (obj.__typename) {
    case 'Query': {
      if (name === 'viewer') return userObj(store, store.viewer.login);
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const repo = store.getRepo(owner, repoName);
        return repo === undefined ? null : repoObj(store, repo);
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const parsed = parseGlobalId(id);
        if (parsed === null) return null;
        if (parsed.kind === 'Repository') {
          const [owner, repoName] = parsed.parts.split('/', 2);
          const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
          return repo === undefined ? null : repoObj(store, repo);
        }
        if (parsed.kind === 'Issue') {
          const [ownerRepo, numberText] = parsed.parts.split(':', 2);
          const [owner, repoName] = (ownerRepo ?? '').split('/', 2);
          const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
          const issue = repo?.issues.find((entry) => entry.number === Number(numberText));
          return issue === undefined || repo === undefined ? null : issueObj(store, repo, issue);
        }
        if (parsed.kind === 'PullRequest') {
          const [ownerRepo, numberText] = parsed.parts.split(':', 2);
          const [owner, repoName] = (ownerRepo ?? '').split('/', 2);
          const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
          const pull = repo?.pulls.find((entry) => entry.number === Number(numberText));
          return pull === undefined || repo === undefined ? null : pullObj(store, repo, pull);
        }
        return null;
      }
      if (name === '__type') {
        const typeName = args.name as string | undefined;
        if (typeof typeName !== 'string') return null;
        const info = TYPE_INFO[typeName];
        if (info === undefined) return null;
        return {
          __typename: '__Type',
          name: typeName,
          kind: info.kind,
          description: null,
          fields: info.fields ?? null,
          enumValues: info.enumValues ?? null,
        };
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, name, args);
    }
    case 'Repository': {
      const repo = obj.__repo as Repo;
      if (name === 'owner') return userObj(store, repo.owner);
      if (name === 'defaultBranchRef') {
        return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: null };
      }
      if (name === 'issue') {
        const number = args.number as number | undefined;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueObj(store, repo, issue);
      }
      if (name === 'issues') return issuesConnection(store, repo, args);
      if (name === 'pullRequests') return pullsConnection(store, repo, args);
      if (name === 'pullRequest') {
        const number = args.number as number | undefined;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : pullObj(store, repo, pull);
      }
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'Issue': {
      const repo = obj.__repo as Repo;
      const issue = obj.__issue as Issue;
      if (name === 'author') return userObj(store, issue.user);
      if (name === 'labels') return issue.labels.map((label) => ({ __typename: 'Label', name: label }));
      if (name === 'comments') return { __typename: 'IssueCommentConnection', nodes: [], totalCount: issue.comments.length };
      if (name === 'repository') return repoObj(store, repo);
      if (name === 'resourcePath') return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'PullRequest': {
      const repo = obj.__repo as Repo;
      const pull = obj.__pull as Pull;
      if (name === 'author') return userObj(store, pull.user);
      if (name === 'headRef') {
        return { __typename: 'Ref', name: branchName(pull.headRef), prefix: 'refs/heads/', target: null };
      }
      if (name === 'baseRef') {
        return { __typename: 'Ref', name: branchName(pull.baseRef), prefix: 'refs/heads/', target: null };
      }
      if (name === 'files') return pullFilesConnection(store, repo, pull, args);
      if (name === 'mergeCommit') {
        if (pull.mergeCommitSha === null) return null;
        return { __typename: 'Commit', oid: pull.mergeCommitSha };
      }
      if (name === 'repository') return repoObj(store, repo);
      if (name === 'resourcePath') return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (name === 'isDraft') return false;
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return obj.__nodes as unknown[];
      if (name === 'edges') return (obj.__nodes as Array<Obj>).map((node) => ({ __typename: `${obj.__typename.replace('Connection', 'Edge')}`, node, cursor: cursorOf(typeof node.number === 'number' ? node.number : 0) }));
      if (name === 'pageInfo') return obj.__pageInfo as unknown;
      if (name === 'totalCount') return (obj.__nodes as unknown[]).length + (obj.__remaining as number);
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge': {
      if (name === 'node') return obj.node as unknown;
      if (name === 'cursor') return obj.cursor as unknown;
      return null;
    }
    case 'PageInfo': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'PullRequestChangedFile': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case '__Type': {
      if (name === 'fields') {
        const fields = obj.fields as string[] | null;
        if (fields === null) return null;
        return fields.map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null }));
      }
      if (name === 'enumValues') {
        const values = obj.enumValues as string[] | null;
        if (values === null) return null;
        return values.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null }));
      }
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case '__Field':
    case '__EnumValue':
    case '__InputValue': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'Ref': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'User': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'IssueComment': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    case 'Commit': {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
    default: {
      const direct = obj[name];
      return direct === undefined ? null : direct;
    }
  }
}

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Obj {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && orderBy.direction === 'ASC' ? 1 : -1;
  const field = orderBy !== null && typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  if (field === 'CREATED_AT') list.sort((a, b) => direction * (a.number - b.number));
  else list.sort((a, b) => direction * (a.number - b.number));
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = typeof args.after === 'string' ? numberOfCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    start = index < 0 ? list.length : index + 1;
  }
  const page = list.slice(start, start + Math.max(0, first));
  const remaining = list.length - (start + page.length);
  const nodes = page.map((issue) => issueObj(store, repo, issue));
  const endCursor = page.length > 0 ? cursorOf(page[page.length - 1]?.number ?? 0) : null;
  const startCursor = page.length > 0 ? cursorOf(page[0]?.number ?? 0) : null;
  return {
    __typename: 'IssueConnection',
    __nodes: nodes,
    __remaining: remaining,
    __pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: remaining > 0,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
  };
}

function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): Obj {
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => state.toUpperCase()));
    list = list.filter((pull) => wanted.has(pullState(pull)));
  } else {
    list = list.filter((pull) => pull.state === 'open');
  }
  list.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = typeof args.after === 'string' ? numberOfCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = list.findIndex((pull) => pull.number === after);
    start = index < 0 ? list.length : index + 1;
  }
  const page = list.slice(start, start + Math.max(0, first));
  const remaining = list.length - (start + page.length);
  const nodes = page.map((pull) => pullObj(store, repo, pull));
  const endCursor = page.length > 0 ? cursorOf(page[page.length - 1]?.number ?? 0) : null;
  const startCursor = page.length > 0 ? cursorOf(page[0]?.number ?? 0) : null;
  return {
    __typename: 'PullRequestConnection',
    __nodes: nodes,
    __remaining: remaining,
    __pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: remaining > 0,
      hasPreviousPage: start > 0,
      startCursor,
      endCursor,
    },
  };
}

function pullFilesConnection(store: Store, repo: Repo, pull: Pull, args: Record<string, unknown>): Obj {
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo, baseSha, headSha);
  let changes: Array<{ path: string }> = [];
  if (base !== null) {
    const baseTree = parseCommit(getObject(repo, base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(getObject(repo, headSha)?.data ?? Buffer.alloc(0)).tree;
    changes = diffTrees(repo, baseTree, headTree).map((change) => ({ path: change.path }));
  }
  const first = typeof args.first === 'number' ? args.first : changes.length;
  const page = changes.slice(0, Math.max(0, first));
  const nodes = page.map((change) => ({ __typename: 'PullRequestChangedFile', path: change.path, additions: 0, deletions: 0, changeType: 'MODIFIED' }));
  return {
    __typename: 'PullRequestChangedFileConnection',
    __nodes: nodes,
    __remaining: changes.length - page.length,
    __pageInfo: { __typename: 'PageInfo', hasNextPage: changes.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function resolveMutation(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const input = isRecord(args.input) ? args.input : {};
  if (name === 'createIssue') {
    const repositoryId = input.repositoryId as string | undefined;
    const title = input.title as string | undefined;
    const parsed = typeof repositoryId === 'string' ? parseGlobalId(repositoryId) : null;
    if (parsed === null || parsed.kind !== 'Repository' || typeof title !== 'string' || title === '') {
      ctx.errors.push({ message: 'createIssue: repositoryId and title are required.' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const [owner, repoName] = parsed.parts.split('/', 2);
    const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createIssue: repository not found.' });
      return { __typename: 'CreateIssuePayload', issue: null };
    }
    const { iso } = store.tick();
    const number = store.nextNumber(repo);
    const issue: Issue = {
      number,
      id: store.itemId(repo, number),
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      user: store.viewer.login,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueObj(store, repo, issue) };
  }
  if (name === 'closeIssue') {
    const issueId = input.issueId as string | undefined;
    const parsed = typeof issueId === 'string' ? parseGlobalId(issueId) : null;
    if (parsed === null || parsed.kind !== 'Issue') {
      ctx.errors.push({ message: 'closeIssue: issueId is required.' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    const [ownerRepo, numberText] = parsed.parts.split(':', 2);
    const [owner, repoName] = (ownerRepo ?? '').split('/', 2);
    const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
    const issue = repo?.issues.find((entry) => entry.number === Number(numberText));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: issue not found.' });
      return { __typename: 'CloseIssuePayload', issue: null };
    }
    const { iso } = store.tick();
    issue.state = 'closed';
    issue.closedAt = iso;
    issue.updatedAt = iso;
    return { __typename: 'CloseIssuePayload', issue: issueObj(store, repo, issue) };
  }
  if (name === 'createPullRequest') {
    const repositoryId = input.repositoryId as string | undefined;
    const title = input.title as string | undefined;
    const headRefName = input.headRefName as string | undefined;
    const baseRefName = input.baseRefName as string | undefined;
    const parsed = typeof repositoryId === 'string' ? parseGlobalId(repositoryId) : null;
    if (parsed === null || parsed.kind !== 'Repository' || typeof title !== 'string' || typeof headRefName !== 'string' || typeof baseRefName !== 'string') {
      ctx.errors.push({ message: 'createPullRequest: repositoryId, title, headRefName and baseRefName are required.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const [owner, repoName] = parsed.parts.split('/', 2);
    const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'createPullRequest: repository not found.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const headRef = `refs/heads/${headRefName}`;
    const baseRef = `refs/heads/${baseRefName}`;
    const headSha = repo.refs.get(headRef);
    const baseSha = repo.refs.get(baseRef);
    if (headSha === undefined || baseSha === undefined) {
      ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
      return { __typename: 'CreatePullRequestPayload', pullRequest: null };
    }
    const { iso } = store.tick();
    const number = store.nextNumber(repo);
    const pull: Pull = {
      number,
      id: store.itemId(repo, number),
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: store.viewer.login,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(store, repo, pull) };
  }
  if (name === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId as string | undefined;
    const parsed = typeof pullRequestId === 'string' ? parseGlobalId(pullRequestId) : null;
    if (parsed === null || parsed.kind !== 'PullRequest') {
      ctx.errors.push({ message: 'mergePullRequest: pullRequestId is required.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    const [ownerRepo, numberText] = parsed.parts.split(':', 2);
    const [owner, repoName] = (ownerRepo ?? '').split('/', 2);
    const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
    const pull = repo?.pulls.find((entry) => entry.number === Number(numberText));
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: null };
    }
    if (pull.merged || pull.state !== 'open') {
      ctx.errors.push({ message: 'mergePullRequest: pull request is already closed.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(store, repo, pull) };
    }
    const mergeOid = squashMerge(store, repo, pull);
    if (mergeOid === null) {
      ctx.errors.push({ message: 'mergePullRequest: merge conflict.' });
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(store, repo, pull) };
    }
    const { iso } = store.tick();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = iso;
    pull.mergeCommitSha = mergeOid;
    pull.closedAt = iso;
    pull.updatedAt = iso;
    return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(store, repo, pull) };
  }
  if (name === 'addComment') {
    const subjectId = input.subjectId as string | undefined;
    const text = input.body as string | undefined;
    const parsed = typeof subjectId === 'string' ? parseGlobalId(subjectId) : null;
    if (parsed === null || typeof text !== 'string') {
      ctx.errors.push({ message: 'addComment: subjectId and body are required.' });
      return { __typename: 'AddCommentPayload', commentEdge: null };
    }
    if (parsed.kind === 'Issue') {
      const [ownerRepo, numberText] = parsed.parts.split(':', 2);
      const [owner, repoName] = (ownerRepo ?? '').split('/', 2);
      const repo = owner !== undefined && repoName !== undefined ? store.getRepo(owner, repoName) : undefined;
      const issue = repo?.issues.find((entry) => entry.number === Number(numberText));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'addComment: issue not found.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const { iso } = store.tick();
      const commentId = store.commentId(repo);
      issue.comments.push({ id: commentId, body: text, user: store.viewer.login, createdAt: iso, updatedAt: iso });
      const node: Obj = {
        __typename: 'IssueComment',
        id: commentGlobalId(repo, issue, commentId),
        body: text,
        createdAt: iso,
        updatedAt: iso,
        url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${commentId}`,
        resourcePath: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${commentId}`,
      };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'AddCommentEdge', node, cursor: cursorOf(commentId) } };
    }
    ctx.errors.push({ message: 'addComment: subjectId must name an issue.' });
    return { __typename: 'AddCommentPayload', commentEdge: null };
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export interface GraphQLResult {
  readonly data: Record<string, unknown> | null;
  readonly errors?: Array<{ message: string }>;
}

function executeOperation(store: Store, operation: OperationNode, fragments: Map<string, FragmentDefNode>, variables: Record<string, unknown>): GraphQLResult {
  const ctx: Ctx = { store, errors: [], fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Obj = { __typename: rootType };
  // Apply variable defaults.
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(operation.variables)) {
    if (vars[name] === undefined && def.defaultValue !== null) vars[name] = resolveValue(def.defaultValue, vars);
  }
  const data = executeSelection(ctx, root, operation.selection, vars);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return result;
}

/**
 * Execute one GraphQL request body (a single operation object, or an array of them for
 * batching). A document that does not parse answers errors, never a throw.
 */
export function handleGraphQL(store: Store, body: unknown): unknown {
  const run = (entry: unknown): GraphQLResult => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL operation object needs a query string.' }] };
    }
    let parsed;
    try {
      parsed = new Parser(entry.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
    let operation = parsed.operations[0] as OperationNode | undefined;
    if (operationName !== null) {
      operation = parsed.operations.find((candidate) => candidate.name === operationName);
      if (operation === undefined) {
        return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
      }
    }
    if (operation === undefined) return { data: null, errors: [{ message: 'No operation to run.' }] };
    try {
      return executeOperation(store, operation, parsed.fragments, variables);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) return body.map(run);
  return run(body);
}
