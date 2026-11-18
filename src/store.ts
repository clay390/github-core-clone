// The forge's whole state: one in-memory store shared by git, REST, GraphQL and MCP.
//
// Determinism: nothing here reads the wall clock or Math.random. Every timestamp comes from a
// single counter (seconds past the scenario epoch), so two runs that take the same requests in
// the same order produce the same bytes. Object ids are content hashes; repository, issue and
// comment ids are sequential counters.

import { SCENARIO_EPOCH_SEC, VIEWER, type ScenarioUser } from './scenario.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitpack.ts';

export const DEFAULT_BRANCH = 'main';

/** Format a deterministic timestamp (seconds since the epoch) as ISO 8601. */
/** The branch name of a full ref: `refs/heads/main` -> `main` (other refs unchanged). */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** The identity server-made commits carry: the token owner. */
export function identityOf(user: ScenarioUser): string {
  return `${user.name} <${user.email}>`;
}

// -------------------------------------------------------------------------------------------
// models
// -------------------------------------------------------------------------------------------

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly user: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
}

export interface Pull {
  readonly number: number;
  readonly id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly user: string;
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** refs/heads/* and refs/tags/* -> tip oid. */
  readonly refs: Map<string, string>;
  /** Every git object ever stored, by oid. */
  readonly objects: Map<string, GitObject>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  readonly labels: Map<string, Label>;
  /** One counter for issues + pull requests (GitHub numbers them together). */
  nextNumber: number;
  nextCommentId: number;
  /** Creation order, for stable list ordering. */
  readonly createdSeq: number;
}

// -------------------------------------------------------------------------------------------
// the store
// -------------------------------------------------------------------------------------------

export class Store {
  /** Key `${owner}/${name}`. Only the viewer's repositories ever exist. */
  readonly repos = new Map<string, Repo>();
  /** Repositories in creation order. */
  readonly repoOrder: Repo[] = [];
  /** Deterministic clock: seconds past the scenario epoch, bumped per mutation. */
  private clock = 0;
  private nextRepoId = 5000;
  private createdSeq = 0;

  /** The token owner's identity. */
  readonly viewer: ScenarioUser = VIEWER;

  /** The next deterministic timestamp (seconds), and its ISO form. */
  tick(): { epoch: number; iso: string } {
    this.clock += 1;
    const epoch = SCENARIO_EPOCH_SEC + this.clock;
    return { epoch, iso: isoOf(epoch) };
  }

  /** The current deterministic time without ticking (for read-only stamps). */
  nowIso(): string {
    return isoOf(SCENARIO_EPOCH_SEC + this.clock);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const { iso } = this.tick();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewer.login,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: iso,
      updatedAt: iso,
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      issues: [],
      pulls: [],
      labels: new Map<string, Label>(),
      nextNumber: 1,
      nextCommentId: 1,
      createdSeq: this.createdSeq,
    };
    this.nextRepoId += 1;
    this.createdSeq += 1;
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.repoOrder.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
  }

  /** The next issue/pull-request number for a repository (shared counter, from 1). */
  nextNumber(repo: Repo): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  /** A stable numeric id for an issue or pull request (repo id block + number). */
  itemId(repo: Repo, number: number): number {
    return repo.id * 1_000_000 + number;
  }

  /** A stable numeric id for a comment (repo id block + per-repo sequence). */
  commentId(repo: Repo): number {
    const id = repo.id * 1_000_000 + repo.nextCommentId;
    repo.nextCommentId += 1;
    return id;
  }
}

// -------------------------------------------------------------------------------------------
// git object graph helpers (operate on one repository's object map)
// -------------------------------------------------------------------------------------------

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Resolve a ref or oid to the commit it points at (following annotated tags). */
export function resolveToCommit(repo: Repo, oid: string): { commitOid: string; tagOids: string[] } | null {
  let current = oid;
  const tagOids: string[] = [];
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return { commitOid: current, tagOids };
    if (object.type === 'tag') {
      tagOids.push(current);
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All objects reachable from `roots`: commits, their trees and blobs, tags and their targets. */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The tree closure of one commit: the commit, its tree, and every tree/blob under it. */
export function treeClosure(repo: Repo, commitOid: string): Set<string> {
  const seen = new Set<string>();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return seen;
  seen.add(commitOid);
  const stack: string[] = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return seen;
}

/** Is `ancestor` reachable from `descendant` (or equal to it)? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The first common ancestor of two commits (linear histories: the exact merge-base). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Map<string, number>();
  const queueA: Array<{ oid: string; dist: number }> = [{ oid: a, dist: 0 }];
  while (queueA.length > 0) {
    const { oid, dist } = queueA.shift() as { oid: string; dist: number };
    if (ancestorsA.has(oid)) continue;
    ancestorsA.set(oid, dist);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push({ oid: parent, dist: dist + 1 });
  }
  const queueB: Array<{ oid: string; dist: number }> = [{ oid: b, dist: 0 }];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const { oid, dist } = queueB.shift() as { oid: string; dist: number };
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const distA = ancestorsA.get(oid);
    if (distA !== undefined) {
      const score = distA + dist;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push({ oid: parent, dist: dist + 1 });
  }
  return best;
}

/** Walk a commit's history newest-first (parents after the commit itself). */
export function walkHistory(repo: Repo, tip: string, limit = 10_000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------

export interface FetchSelection {
  /** Objects to send, each with its oid (plain objects; no deltas). */
  readonly objects: Array<{ oid: string; type: ObjType; data: Buffer }>;
  /** New shallow boundaries (commits at the depth cutoff). */
  readonly shallow: string[];
  /** Old boundaries that are now fully included. */
  readonly unshallow: string[];
}

/**
 * What a fetch delivers, by the protocol's own rules.
 *
 * - A want is a commit (a tag want resolves to its target, the tag object itself included).
 * - A have the client holds contributes its full closure, unless it is a shallow boundary of
 *   this fetch, in which case only the commit and its tree closure are held (its parents are
 *   not held, so a deepen can still deliver them).
 * - With a depth, only commits at distance <= depth from a want are included; the boundary is
 *   the included commits at max depth.
 * - Nothing already held is re-sent.
 */
export function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
  deepenSince: number | undefined,
  deepenNot: readonly string[],
): FetchSelection {
  const boundarySet = new Set(shallowBoundaries);
  // Held set: what the client already has.
  const held = new Set<string>();
  for (const have of haves) {
    const resolved = resolveToCommit(repo, have);
    if (resolved === null) continue;
    if (boundarySet.has(have) || boundarySet.has(resolved.commitOid)) {
      for (const oid of treeClosure(repo, resolved.commitOid)) held.add(oid);
      for (const tag of resolved.tagOids) held.add(tag);
    } else {
      for (const oid of collectReachable(repo, [have])) held.add(oid);
    }
  }
  // Distances from the wants (1 = a want commit itself).
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const tagObjects: string[] = [];
  for (const want of wants) {
    const resolved = resolveToCommit(repo, want);
    if (resolved === null) continue;
    for (const tag of resolved.tagOids) tagObjects.push(tag);
    if (!dist.has(resolved.commitOid)) {
      dist.set(resolved.commitOid, 1);
      queue.push(resolved.commitOid);
    }
  }
  // BFS over parents, honouring depth and deepen-since.
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    const d = dist.get(oid) as number;
    if (depth !== undefined && d >= depth) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (dist.has(parent)) continue;
      if (deepenSince !== undefined) {
        const parentObject = repo.objects.get(parent);
        if (parentObject !== undefined && parentObject.type === 'commit') {
          if (parseCommit(parentObject.data).timestamp < deepenSince) continue;
        }
      }
      dist.set(parent, d + 1);
      queue.push(parent);
    }
  }
  const included = new Set<string>(dist.keys());
  // deepen-not: drop everything reachable from the excluded refs.
  if (deepenNot.length > 0) {
    const excluded = collectReachable(repo, deepenNot);
    for (const oid of excluded) included.delete(oid);
  }
  // Send = closure(included commits + tag objects) minus held.
  const send = new Set<string>();
  for (const tag of tagObjects) {
    if (!held.has(tag)) send.add(tag);
  }
  for (const commitOid of included) {
    for (const oid of treeClosure(repo, commitOid)) {
      if (!held.has(oid)) send.add(oid);
    }
    // The commit itself is in its tree closure; parents are included only via their own entry.
  }
  // A shallow boundary's own tree closure was held, but a *new* boundary commit that is also an
  // old boundary must still be sent when it is a want: its tree is held, the commit is not (the
  // boundary hold covers the commit id itself — treeClosure adds the commit oid, so it is held).
  // That is correct: the client already has the boundary commit.
  const objects: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push({ oid, type: object.type, data: object.data });
  }
  // Shallow-info: new boundaries are the included commits at max depth; old boundaries that are
  // now included become unshallow.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of dist) {
      if (d === depth && included.has(oid)) shallow.push(oid);
    }
  }
  for (const boundary of boundarySet) {
    const resolved = resolveToCommit(repo, boundary);
    const commitOid = resolved === null ? boundary : resolved.commitOid;
    if (included.has(commitOid)) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

// -------------------------------------------------------------------------------------------
// trees and merges
// -------------------------------------------------------------------------------------------

/** Flatten a tree into path -> {mode, oid}, following subtrees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, base: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, prefix);
  return out;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
  readonly additions: number;
  readonly deletions: number;
}

/** Line counts, naive: lines in the new blob are additions, lines in the old are deletions. */
export function countLines(data: Buffer | null): number {
  if (data === null || data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry !== undefined && newEntry !== undefined) {
      if (oldEntry.oid === newEntry.oid) continue;
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
      const newData = repo.objects.get(newEntry.oid)?.data ?? null;
      changes.push({
        path,
        status: 'modified',
        oldOid: oldEntry.oid,
        newOid: newEntry.oid,
        additions: countLines(newData),
        deletions: countLines(oldData),
      });
    } else if (newEntry !== undefined) {
      const newData = repo.objects.get(newEntry.oid)?.data ?? null;
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: countLines(newData), deletions: 0 });
    } else if (oldEntry !== undefined) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? null;
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: countLines(oldData) });
    }
  }
  return changes;
}

/** Build a tree object from a flat path map, creating intermediate trees. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Would squashing `headTip` onto `baseTip` conflict? (same file changed both sides, differently) */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseCommit = repo.objects.get(base);
  const headCommit = repo.objects.get(headTip);
  const baseTipCommit = repo.objects.get(baseTip);
  if (baseCommit === undefined || headCommit === undefined || baseTipCommit === undefined) return false;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const tipTree = parseCommit(baseTipCommit.data).tree;
  const headChanges = diffTrees(repo, baseTree, headTree);
  const tipChanges = diffTrees(repo, baseTree, tipTree);
  const tipByPath = new Map(tipChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = tipByPath.get(change.path);
    if (other === undefined) continue;
    if (other.newOid !== change.newOid) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request: apply the head branch's diff (against the merge-base) onto the
 * current base tree, commit on the base branch. Returns the merge commit oid, or null on conflict.
 */
export function squashMerge(store: Store, repo: Repo, pull: Pull): string | null {
  const baseTip = repo.refs.get(pull.baseRef);
  const headTip = repo.refs.get(pull.headRef);
  if (baseTip === undefined || headTip === undefined) return null;
  if (mergeConflicts(repo, baseTip, headTip)) return null;
  const base = mergeBase(repo, baseTip, headTip);
  const baseCommit = base === null ? undefined : repo.objects.get(base);
  const headCommit = repo.objects.get(headTip);
  const baseTipCommit = repo.objects.get(baseTip);
  if (headCommit === undefined || baseTipCommit === undefined) return null;
  const baseTree = baseCommit === undefined ? parseCommit(baseTipCommit.data).tree : parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const tipTree = parseCommit(baseTipCommit.data).tree;
  // Apply the head's changes onto the base tip's tree.
  const flat = flattenTree(repo, tipTree);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    if (change.status === 'removed') flat.delete(change.path);
    else if (change.newOid !== null) flat.set(change.path, { mode: '100644', oid: change.newOid });
  }
  const newTree = buildTreeFromFlat(repo, flat);
  const { epoch } = store.tick();
  const identity = identityOf(store.viewer);
  const message = `${pull.title}\n`;
  const commitData = buildCommit({
    tree: newTree,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: epoch,
  });
  const mergeOid = putObject(repo, 'commit', commitData);
  repo.refs.set(pull.baseRef, mergeOid);
  return mergeOid;
}

/** Create a commit on a branch from a flat file map (one file changed, the rest carried over). */
export function commitFiles(
  store: Store,
  repo: Repo,
  branchRef: string,
  changes: Map<string, Buffer | null>,
  message: string,
): { commitOid: string; treeOid: string } {
  const rawTip = repo.refs.get(branchRef);
  const tip = rawTip === undefined || rawTip === ZERO_OID ? undefined : rawTip;
  const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = parentTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo, parentTree);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: putObject(repo, 'blob', content) });
  }
  const treeOid = buildTreeFromFlat(repo, flat);
  const { epoch } = store.tick();
  const identity = identityOf(store.viewer);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip === undefined ? [] : [tip],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: identity,
    committer: identity,
    timestamp: epoch,
  });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(branchRef, commitOid);
  return { commitOid, treeOid };
}

/** The blob oid of a file at a ref (or null when the path is absent). */
export function blobAtPath(repo: Repo, ref: string, path: string): { blobOid: string; data: Buffer } | null {
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return null;
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return { blobOid: entry.oid, data: blob.data };
}

/** The directory listing of a path at a ref: null when the path is a file, [] when absent. */
export function dirAtPath(repo: Repo, ref: string, path: string): Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> | null {
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return null;
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const prefix = path === '' ? '' : `${path}/`;
  const entries = new Map<string, { name: string; path: string; type: 'file' | 'dir'; sha: string }>();
  for (const [filePath, entry] of flat) {
    if (prefix !== '' && !filePath.startsWith(prefix)) continue;
    const rest = prefix === '' ? filePath : filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.set(rest, { name: rest, path: filePath, type: 'file', sha: entry.oid });
    } else {
      const dirName = rest.slice(0, slash);
      if (!entries.has(dirName)) {
        // The dir's sha is its tree oid: find it by walking the tree.
        const dirOid = findTreeOid(repo, parseCommit(commit.data).tree, path === '' ? dirName : `${path}/${dirName}`);
        entries.set(dirName, { name: dirName, path: path === '' ? dirName : `${path}/${dirName}`, type: 'dir', sha: dirOid ?? ZERO_OID });
      }
    }
  }
  if (entries.size === 0) {
    // A file at exactly this path means this is a file, not a directory.
    if (flat.has(path)) return null;
    return [];
  }
  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

function findTreeOid(repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}
