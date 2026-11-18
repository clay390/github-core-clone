// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Speaks the 2026-07-28 revision (server/discover lists the revisions it supports) and the
// legacy initialize + notifications/initialized handshake. Six tools, named exactly as
// github-mcp-server documents them, each with a minimal `required` list: the suite maps its
// documented arguments onto the schema, and a required property it cannot fill fails the check.

import {
  branchName,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository.' },
        description: { type: 'string', description: 'Description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'Owner of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
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
        owner: { type: 'string', description: 'Owner of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
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
        owner: { type: 'string', description: 'Owner of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
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
        owner: { type: 'string', description: 'Owner of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'number', description: 'Number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoShape(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.ownerId },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueShape(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label })),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullShape(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: branchName(pull.headRef), sha: pull.headSha, label: `${repo.owner}:${branchName(pull.headRef)}`, user: { login: repo.owner } },
    base: { ref: branchName(pull.baseRef), sha: pull.baseSha, label: `${repo.owner}:${branchName(pull.baseRef)}`, user: { login: repo.owner } },
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

interface RpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (tool === undefined) {
    throw { code: -32602, message: `Unknown tool: ${name}` };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null) {
      throw { code: -32602, message: `Missing required argument: ${required}` };
    }
  }
  const viewer = store.viewer.login;
  if (tool.name === 'create_repo') {
    const repoName = String(args.name);
    if (store.getRepo(viewer, repoName) !== undefined) {
      return errorResult(`Repository ${viewer}/${repoName} already exists.`);
    }
    const repo = store.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : null,
      private: args.private === true,
    });
    return textResult(repoShape(repo));
  }
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    return errorResult(`Repository ${owner}/${repoName} not found.`);
  }
  if (tool.name === 'get_repo') return textResult(repoShape(repo));
  if (tool.name === 'create_issue') {
    const { iso } = store.tick();
    const number = store.nextNumber(repo);
    const issue: Issue = {
      number,
      id: store.itemId(repo, number),
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      user: viewer,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return textResult(issueShape(repo, issue));
  }
  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return textResult(list.map((issue) => issueShape(repo, issue)));
  }
  if (tool.name === 'create_pull_request') {
    const headRef = `refs/heads/${String(args.head)}`;
    const baseRef = `refs/heads/${String(args.base)}`;
    const headSha = repo.refs.get(headRef);
    const baseSha = repo.refs.get(baseRef);
    if (headSha === undefined || baseSha === undefined) {
      return errorResult(`Head or base branch does not exist in ${owner}/${repoName}.`);
    }
    const { iso } = store.tick();
    const number = store.nextNumber(repo);
    const pull: Pull = {
      number,
      id: store.itemId(repo, number),
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      user: viewer,
      createdAt: iso,
      updatedAt: iso,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return textResult(pullShape(repo, pull));
  }
  if (tool.name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return errorResult(`Pull request ${number} not found in ${owner}/${repoName}.`);
    if (pull.merged || pull.state !== 'open') return errorResult(`Pull request ${number} is already closed.`);
    const mergeOid = squashMerge(store, repo, pull);
    if (mergeOid === null) return errorResult(`Pull request ${number} has a merge conflict.`);
    const { iso } = store.tick();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = iso;
    pull.mergeCommitSha = mergeOid;
    pull.closedAt = iso;
    pull.updatedAt = iso;
    return textResult({ sha: mergeOid, merged: true, message: `Pull request #${number} merged.` });
  }
  return errorResult(`Tool ${name} is not implemented.`);
}

export interface McpResponse {
  readonly status: number;
  readonly json: unknown;
  readonly sessionId?: string;
}

/** The JSON-RPC parse error for a body that is not JSON (HTTP 400, code -32700). */
export function mcpParseErrorBody(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
}

export function handleMcp(store: Store, body: unknown, sessionId: string | undefined): McpResponse {
  if (!isRecord(body)) {
    return { status: 400, json: mcpParseErrorBody() };
  }
  const request = body as RpcRequest;
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  // A request without an id is a notification: acknowledged, no JSON-RPC reply.
  if (request.id === undefined) {
    return { status: 202, json: null, sessionId };
  }
  const reply = (result: unknown): McpResponse => ({ status: 200, json: { jsonrpc: '2.0', id, result }, sessionId });
  const fail = (code: number, message: string): McpResponse => ({ status: 200, json: { jsonrpc: '2.0', id, error: { code, message } }, sessionId });
  if (method === 'server/discover') {
    return reply({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '0.1.0' },
    });
  }
  if (method === 'initialize') {
    return reply({
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone-01', version: '0.1.0' },
    });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') {
    // Built from a module-level constant: two calls answer byte for byte the same list.
    return reply({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(store, toolName, args);
      return reply(result);
    } catch (err) {
      if (isRecord(err) && typeof err.code === 'number') {
        return fail(err.code, typeof err.message === 'string' ? err.message : 'Invalid params');
      }
      return fail(-32603, err instanceof Error ? err.message : String(err));
    }
  }
  return fail(-32601, `Method not found: ${method}`);
}
