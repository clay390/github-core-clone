// GitHub REST v3: repositories, branches, commits, contents, labels, issues, pull requests.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id (app.ts adds the header); errors
// are {"message": string}. The shapes follow what the suite's checks read: extra fields are
// allowed, missing required fields are not.

import { SCENARIO_EPOCH_SEC } from './scenario.ts';
import { ZERO_OID, isOid, parseCommit } from './gitpack.ts';
import {
  blobAtPath,
  branchName,
  commitFiles,
  diffTrees,
  dirAtPath,
  getObject,
  isoOf,
  mergeBase,
  mergeConflicts,
  squashMerge,
  walkHistory,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

// -------------------------------------------------------------------------------------------
// shapes
// -------------------------------------------------------------------------------------------

export function userObject(store: Store): Record<string, unknown> {
  const viewer = store.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: Buffer.from(`User:${viewer.id}`).toString('base64'),
    avatar_url: '',
    gravatar_id: '',
    url: '/api/v3/users/' + viewer.login,
    html_url: `https://github.com/${viewer.login}`,
    followers_url: `/api/v3/users/${viewer.login}/followers`,
    following_url: `/api/v3/users/${viewer.login}/following{/other_user}`,
    gists_url: `/api/v3/users/${viewer.login}/gists{/gist_id}`,
    starred_url: `/api/v3/users/${viewer.login}/starred{/owner}{/repo}`,
    subscriptions_url: `/api/v3/users/${viewer.login}/subscriptions`,
    organizations_url: `/api/v3/users/${viewer.login}/orgs`,
    repos_url: `/api/v3/users/${viewer.login}/repos`,
    events_url: `/api/v3/users/${viewer.login}/events{/privacy}`,
    received_events_url: `/api/v3/users/${viewer.login}/received_events`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    public_repos: store.repoOrder.length,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: isoOf(SCENARIO_EPOCH_SEC),
    updated_at: store.nowIso(),
  };
}

function userRef(store: Store): Record<string, unknown> {
  const viewer = store.viewer;
  return { login: viewer.login, id: viewer.id, avatar_url: '', type: 'User', site_admin: false };
}

export function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userRef(store),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    archive_url: `/api/v3/repos/${repo.owner}/${repo.name}/{archive_format}{/ref}`,
    assignees_url: `/api/v3/repos/${repo.owner}/${repo.name}/assignees{/user}`,
    blobs_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs{/sha}`,
    branches_url: `/api/v3/repos/${repo.owner}/${repo.name}/branches{/branch}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    collaborators_url: `/api/v3/repos/${repo.owner}/${repo.name}/collaborators{/collaborator}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/comments{/number}`,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits{/sha}`,
    compare_url: `/api/v3/repos/${repo.owner}/${repo.name}/compare/{base}...{head}`,
    contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/{+path}`,
    contributors_url: `/api/v3/repos/${repo.owner}/${repo.name}/contributors`,
    deployments_url: `/api/v3/repos/${repo.owner}/${repo.name}/deployments`,
    downloads_url: `/api/v3/repos/${repo.owner}/${repo.name}/downloads`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/events`,
    forks_url: `/api/v3/repos/${repo.owner}/${repo.name}/forks`,
    git_commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits{/sha}`,
    git_refs_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs{/sha}`,
    git_tags_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/tags{/sha}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    issue_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments{/number}`,
    issue_events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/events{/number}`,
    issues_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues{/number}`,
    keys_url: `/api/v3/repos/${repo.owner}/${repo.name}/keys{/key_id}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/labels{/name}`,
    languages_url: `/api/v3/repos/${repo.owner}/${repo.name}/languages`,
    merges_url: `/api/v3/repos/${repo.owner}/${repo.name}/merges`,
    milestones_url: `/api/v3/repos/${repo.owner}/${repo.name}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${repo.owner}/${repo.name}/notifications{?since,all,participating}`,
    pulls_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls{/number}`,
    releases_url: `/api/v3/repos/${repo.owner}/${repo.name}/releases{/id}`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    stargazers_url: `/api/v3/repos/${repo.owner}/${repo.name}/stargazers`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/{sha}`,
    subscribers_url: `/api/v3/repos/${repo.owner}/${repo.name}/subscribers`,
    subscription_url: `/api/v3/repos/${repo.owner}/${repo.name}/subscription`,
    tags_url: `/api/v3/repos/${repo.owner}/${repo.name}/tags`,
    teams_url: `/api/v3/repos/${repo.owner}/${repo.name}/teams`,
    trees_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees{/sha}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url_short: '',
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelObject(label: Label): Record<string, unknown> {
  return { id: 0, node_id: Buffer.from(`Label:${label.name}`).toString('base64'), url: '', name: label.name, color: label.color, default: false, description: label.description };
}

export function issueObject(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.owner}/${repo.name}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userRef(store),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { name, color: 'ededed', description: '' } : labelObject(label);
    }),
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentObject(store: Store, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userRef(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function pullObject(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  const additions = 0;
  const deletions = 0;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userRef(store),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${repo.owner}/${repo.name}/statuses/${headSha}`,
    head: {
      label: `${repo.owner}:${branchName(pull.headRef)}`,
      ref: branchName(pull.headRef),
      sha: headSha,
      user: userRef(store),
      repo: repoObject(store, repo),
    },
    base: {
      label: `${repo.owner}:${branchName(pull.baseRef)}`,
      ref: branchName(pull.baseRef),
      sha: baseSha,
      user: userRef(store),
      repo: repoObject(store, repo),
    },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? !mergeConflicts(repo, baseSha, headSha) : null,
    rebaseable: null,
    mergeable_state: pull.state === 'open' ? (mergeConflicts(repo, baseSha, headSha) ? 'dirty' : 'clean') : 'unknown',
    merged_by: pull.merged ? userRef(store) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions,
    deletions,
    changed_files: 1,
  };
}

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

function bodyBool(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** A repository read: the owner must be the viewer and the repo must exist (else 404, never 403). */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner.toLowerCase() !== store.viewer.login.toLowerCase()) return null;
  return store.getRepo(store.viewer.login, name) ?? null;
}

interface Page {
  readonly perPage: number;
  readonly page: number;
}

/** Parse per_page/page (defaults 30/1, per_page clamped to 1..100). */
function pageOf(query: URLSearchParams): Page {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isSafeInteger(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isSafeInteger(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** Slice a list into one page, and the Link header for the next page (same origin, absolute). */
function paginate<T>(items: readonly T[], page: Page, origin: string, path: string, query: URLSearchParams): { items: T[]; link: string | null } {
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  let link: string | null = null;
  if (start + page.perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('per_page', String(page.perPage));
    next.set('page', String(page.page + 1));
    link = `<${origin}${path}?${next.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

function commitObject(repo: Repo, oid: string): Record<string, unknown> {
  const object = getObject(repo, oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid, commit: { message: '' } };
  const parsed = parseCommit(object.data);
  const authorName = parsed.author.replace(/ <.*$/, '');
  const authorEmail = /<([^>]*)>/.exec(parsed.author)?.[1] ?? '';
  const date = isoOf(parsed.timestamp);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      author: { name: authorName, email: authorEmail, date },
      committer: { name: authorName, email: authorEmail, date },
      // Git stores the message with a trailing newline; GitHub's API answers without it.
      message: parsed.message.replace(/\n$/, ''),
      tree: { sha: parsed.tree },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: null,
    committer: null,
    parents: parsed.parents.map((parent) => ({ sha: parent, url: '' })),
  };
}

// -------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------

/**
 * Handle one REST request. `segments` are the decoded path segments after /api/v3, `origin` is
 * the request's own origin (for absolute Link URLs), `body` is the parsed JSON body (or
 * undefined when there is none / it did not parse — callers turn a malformed body into a 400
 * before reaching here, except where noted).
 */
export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestResult {
  const seg = (index: number): string | undefined => segments[index];

  // GET /api/v3/ — the API root, with the OAuth scopes this token carries.
  if (method === 'GET' && segments.length === 0) {
    return ok(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        user_url: '/api/v3/users/{user}',
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta — the installed version.
  if (method === 'GET' && segments.length === 1 && seg(0) === 'meta') {
    return ok(200, { installed_version: '1.0.0' });
  }

  // GET /user — the token owner.
  if (method === 'GET' && segments.length === 1 && seg(0) === 'user') return ok(200, userObject(store));

  // GET /user/repos — list with pagination.
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const page = pageOf(query);
      const { items, link } = paginate(store.repoOrder, page, origin, '/api/v3/user/repos', query);
      return ok(200, items.map((repo) => repoObject(store, repo)), linkHeaders(link));
    }
    if (method === 'POST') {
      const name = bodyString(body, 'name');
      if (name === undefined || name === '' || /[^\w.\-]/.test(name) || name.length > 100) {
        return err(422, 'Validation Failed: name is required');
      }
      if (store.getRepo(store.viewer.login, name) !== undefined) {
        return err(422, 'Repository already exists');
      }
      const repo = store.createRepo(name, bodyBool(body, 'private', false), bodyString(body, 'description') ?? '');
      return ok(201, repoObject(store, repo));
    }
  }

  // /repos/{owner}/{name}...
  if (segments.length >= 3 && seg(0) === 'repos') {
    const owner = seg(1) as string;
    const name = seg(2) as string;
    const rest = segments.slice(3);
    const repo = findRepo(store, owner, name);
    if (repo === null) return err(404, 'Not Found');

    // GET /repos/{o}/{r} | PATCH | DELETE
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoObject(store, repo));
      if (method === 'PATCH') {
        const description = bodyString(body, 'description');
        if (description !== undefined) repo.description = description;
        if (isRecord(body) && typeof body.private === 'boolean') repo.private = body.private;
        const { iso } = store.tick();
        repo.updatedAt = iso;
        return ok(200, repoObject(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204, body: null };
      }
    }

    // GET /branches | GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (method === 'GET' && rest.length === 1) {
        const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length));
        names.sort();
        const ordered = [repo.defaultBranch, ...names.filter((branch) => branch !== repo.defaultBranch)];
        const list = ordered
          .filter((branch) => repo.refs.get(`refs/heads/${branch}`) !== undefined)
          .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string }, protected: false }));
        return ok(200, list);
      }
      if (method === 'GET' && rest.length === 2) {
        const branch = rest[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Branch not found');
        return ok(200, { name: branch, commit: { sha }, protected: false });
      }
    }

    // GET /commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
      if (tip === undefined && isOid(ref)) tip = getObject(repo, ref) !== undefined ? ref : undefined;
      if (tip === undefined) return err(404, 'Not Found');
      const history = walkHistory(repo, tip);
      return ok(200, history.map((oid) => commitObject(repo, oid)));
    }

    // POST /git/refs | GET /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = bodyString(body, 'ref');
        const sha = bodyString(body, 'sha');
        if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !isOid(sha)) {
          return err(422, 'Validation Failed: ref and sha are required');
        }
        if (getObject(repo, sha) === undefined) return err(422, 'Validation Failed: sha does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return ok(201, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), url: '', object: { sha, type: 'commit', url: '' } });
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), url: '', object: { sha, type: 'commit', url: '' } });
      }
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const ref = query.get('ref') ?? repo.defaultBranch;
      const branchRef = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
      if (method === 'GET') {
        const tip = repo.refs.get(branchRef);
        if (tip === undefined) return err(404, 'Not Found');
        if (path === '') {
          const entries = dirAtPath(repo, branchRef, '');
          return ok(200, entries ?? []);
        }
        const file = blobAtPath(repo, branchRef, path);
        if (file !== null) {
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop() ?? path,
            path,
            content: file.data.toString('base64'),
            sha: file.blobOid,
            url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
            git_url: '',
            html_url: '',
            download_url: '',
          });
        }
        const dir = dirAtPath(repo, branchRef, path);
        if (dir === null) return err(404, 'Not Found');
        if (dir.length === 0) return err(404, 'Not Found');
        return ok(200, dir.map((entry) => ({ ...entry, url: '', git_url: '', html_url: '', download_url: entry.type === 'file' ? '' : null })));
      }
      if (method === 'PUT') {
        const message = bodyString(body, 'message');
        const content = bodyString(body, 'content');
        if (message === undefined || content === undefined) return err(422, 'Validation Failed: message and content are required');
        let bytes: Buffer;
        try {
          bytes = Buffer.from(content, 'base64');
        } catch {
          return err(422, 'Validation Failed: content is not valid base64');
        }
        const branch = bodyString(body, 'branch') ?? repo.defaultBranch;
        const targetRef = `refs/heads/${branch}`;
        if (repo.refs.get(targetRef) === undefined) {
          // A contents write on a missing branch creates it from the default branch tip.
          const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (baseTip !== undefined) repo.refs.set(targetRef, baseTip);
          else repo.refs.set(targetRef, ZERO_OID);
        }
        const existing = blobAtPath(repo, targetRef, path);
        const sha = bodyString(body, 'sha');
        if (existing !== null) {
          if (sha === undefined) return err(422, 'Validation Failed: sha was not supplied');
          if (sha.toLowerCase() !== existing.blobOid.toLowerCase()) return err(409, 'Conflict: sha does not match the current blob');
        }
        const { commitOid } = commitFiles(store, repo, targetRef, new Map([[path, bytes]]), message);
        const created = blobAtPath(repo, targetRef, path);
        const status = existing === null ? 201 : 200;
        return ok(status, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: created?.blobOid ?? '',
            size: bytes.length,
            type: 'file',
            content: bytes.toString('base64'),
            encoding: 'base64',
            url: '',
            git_url: '',
            html_url: '',
            download_url: '',
          },
          commit: { sha: commitOid, message, url: '' },
        });
      }
      if (method === 'DELETE') {
        const existing = blobAtPath(repo, branchRef, path);
        if (existing === null) return err(404, 'Not Found');
        const sha = bodyString(body, 'sha');
        if (sha !== undefined && sha.toLowerCase() !== existing.blobOid.toLowerCase()) return err(409, 'Conflict: sha does not match the current blob');
        const message = bodyString(body, 'message') ?? 'Delete file';
        const branch = branchRef.slice('refs/heads/'.length);
        const { commitOid } = commitFiles(store, repo, `refs/heads/${branch}`, new Map([[path, null]]), message);
        return ok(200, { content: null, commit: { sha: commitOid, message, url: '' } });
      }
    }

    // /labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map(labelObject));
      }
      if (method === 'POST' && rest.length === 1) {
        const name = bodyString(body, 'name');
        const color = bodyString(body, 'color') ?? 'ededed';
        if (name === undefined || name === '') return err(422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return ok(201, labelObject(existing));
        const label: Label = { name, color, description: bodyString(body, 'description') ?? '' };
        repo.labels.set(name, label);
        return ok(201, labelObject(label));
      }
    }

    // /issues...
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          const page = pageOf(query);
          const { items, link } = paginate(list, page, origin, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query);
          return ok(200, items.map((issue) => issueObject(store, repo, issue)), linkHeaders(link));
        }
        if (method === 'POST') {
          const title = bodyString(body, 'title');
          if (title === undefined || title === '') return err(422, 'Validation Failed: title is required');
          const labels = isRecord(body) && Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
          for (const label of labels) {
            if (typeof label !== 'string' || !repo.labels.has(label)) {
              return err(422, `Validation Failed: label ${JSON.stringify(label)} does not exist`);
            }
          }
          const { iso } = store.tick();
          const number = store.nextNumber(repo);
          const issue: Issue = {
            number,
            id: store.itemId(repo, number),
            title,
            body: bodyString(body, 'body') ?? '',
            state: 'open',
            labels: labels as string[],
            user: store.viewer.login,
            createdAt: iso,
            updatedAt: iso,
            closedAt: null,
            comments: [],
          };
          repo.issues.push(issue);
          return ok(201, issueObject(store, repo, issue));
        }
      }
      const number = Number(rest[1]);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueObject(store, repo, issue));
        if (method === 'PATCH') {
          const state = bodyString(body, 'state');
          if (state === 'open' || state === 'closed') {
            issue.state = state;
            if (state === 'closed') {
              const { iso } = store.tick();
              issue.closedAt = iso;
              issue.updatedAt = iso;
            } else {
              issue.closedAt = null;
              issue.updatedAt = store.nowIso();
            }
          }
          const title = bodyString(body, 'title');
          if (title !== undefined) issue.title = title;
          const content = bodyString(body, 'body');
          if (content !== undefined) issue.body = content;
          return ok(200, issueObject(store, repo, issue));
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => commentObject(store, repo, issue, comment)));
        }
        if (method === 'POST') {
          const text = bodyString(body, 'body');
          if (text === undefined) return err(422, 'Validation Failed: body is required');
          const { iso } = store.tick();
          const comment: Comment = { id: store.commentId(repo), body: text, user: store.viewer.login, createdAt: iso, updatedAt: iso };
          issue.comments.push(comment);
          return ok(201, commentObject(store, repo, issue, comment));
        }
      }
    }

    // /pulls...
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.number - a.number);
          const page = pageOf(query);
          const { items, link } = paginate(list, page, origin, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query);
          return ok(200, items.map((pull) => pullObject(store, repo, pull)), linkHeaders(link));
        }
        if (method === 'POST') {
          const head = bodyString(body, 'head');
          const base = bodyString(body, 'base');
          const title = bodyString(body, 'title');
          if (head === undefined || base === undefined || title === undefined) {
            return err(422, 'Validation Failed: head, base and title are required');
          }
          const headRef = `refs/heads/${head}`;
          const baseRef = `refs/heads/${base}`;
          const headSha = repo.refs.get(headRef);
          const baseSha = repo.refs.get(baseRef);
          if (headSha === undefined || baseSha === undefined) return err(422, 'Validation Failed: head or base branch does not exist');
          const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
          if (duplicate !== undefined) return err(422, 'Validation Failed: a pull request already exists for this head and base');
          const { iso } = store.tick();
          const number = store.nextNumber(repo);
          const pull: Pull = {
            number,
            id: store.itemId(repo, number),
            title,
            body: bodyString(body, 'body') ?? '',
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
          return ok(201, pullObject(store, repo, pull));
        }
      }
      const number = Number(rest[1]);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (rest.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, pullObject(store, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) return err(404, 'Not Found');
        const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
        const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
        const base = mergeBase(repo, baseSha, headSha);
        if (base === null) return ok(200, []);
        const baseTree = parseCommit(getObject(repo, base)?.data ?? Buffer.alloc(0)).tree;
        const headTree = parseCommit(getObject(repo, headSha)?.data ?? Buffer.alloc(0)).tree;
        const changes = diffTrees(repo, baseTree, headTree);
        return ok(200, changes.map((change) => ({
          sha: change.newOid ?? change.oldOid ?? '',
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
          patch: '',
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) return err(404, 'Not Found');
        if (pull.merged || pull.state !== 'open') return err(405, 'Pull request has already been merged');
        const mergeOid = squashMerge(store, repo, pull);
        if (mergeOid === null) return err(405, 'Merge conflict');
        const { iso } = store.tick();
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = iso;
        pull.mergeCommitSha = mergeOid;
        pull.closedAt = iso;
        pull.updatedAt = iso;
        return ok(200, { sha: mergeOid, merged: true, message: 'Pull request successfully merged' });
      }
    }
  }

  return err(404, 'Not Found');
}
