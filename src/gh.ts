/**
 * The GitHub CLI (`gh`) calls the PR dashboard needs. gh runs via spawnSync with an argument list (never a shell); repo
 * names, numbers, thread ids and reviewer names are checked against strict patterns first, and text (comment bodies)
 * goes in on stdin or as a GraphQL variable, so nothing user-typed can be read as an option.
 *
 * The binary is $REVIEW_KIT_GH when set (tests point it at a fake), else `gh` on PATH. Every call runs in the system
 * temp folder with -R, so gh never infers a repository from (or touches branches of) the folder review-kit runs in.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { ReviewError } from './errors.js';

export interface GhResult { status: number; stdout: string; stderr: string }

/** gh itself failed (missing, not logged in, or GitHub refused the call), as opposed to a bad argument. */
export class GhError extends ReviewError {
  override name = 'GhError';
}

const MAX_BUFFER = 256 * 1024 * 1024;
const TIMEOUT = 180_000;

/** owner/name as GitHub allows them (owners never start with "-"; names may hold dots and underscores). */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
/** A user login or an org/team slug, as accepted by `gh pr edit --add-reviewer`. */
export const REVIEWER_RE = /^@?[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9._-]{1,100})?$/;
/** GraphQL node ids (PRRT_kwDO...). */
export const NODE_ID_RE = /^[A-Za-z0-9_=-]{4,200}$/;

export function binary(): string {
  return process.env.REVIEW_KIT_GH || 'gh';
}

let ready = false;

/** Run gh. Throws ReviewError when gh is missing; a non-zero exit is returned (or thrown when `check`). */
export function run(args: string[], opts: { input?: string; check?: boolean } = {}): GhResult {
  const r = spawnSync(binary(), args, {
    cwd: os.tmpdir(),
    input: opts.input ?? '',
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: TIMEOUT,
    windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', CLICOLOR: '0', GH_PAGER: '', PAGER: 'cat' },
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new GhError('the GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com '
        + 'and run `gh auth login`');
    }
    if (code === 'ETIMEDOUT') throw new GhError(`gh ${args.slice(0, 2).join(' ')} timed out`);
    throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed: ${r.error.message}`);
  }
  const res = { status: r.status ?? 1, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
  if (opts.check && res.status !== 0) throw new GhError(ghError(args, res));
  return res;
}

/** A one-line description of a failed gh call: its stderr (trimmed), else the exit status. */
export function ghError(args: string[], r: GhResult): string {
  const msg = r.stderr || r.stdout.trim() || `exit status ${r.status}`;
  const short = msg.length > 2000 ? msg.slice(0, 2000) + '…' : msg;
  return `gh ${args.slice(0, 2).join(' ')} failed: ${short}`;
}

/** Make sure gh exists and is logged in (checked once per process). */
export function ensureReady(): void {
  if (ready) return;
  const r = run(['auth', 'status']);
  if (r.status !== 0) {
    throw new GhError('gh is not logged in to GitHub; run `gh auth login` (gh auth status: '
      + (r.stderr || r.stdout.trim() || `exit status ${r.status}`).split('\n')[0] + ')');
  }
  ready = true;
}

/** Forget the cached `gh auth status` result (tests). */
export function resetReady(): void {
  ready = false;
  viewerLogin = null;
}

function json(args: string[]): any {
  ensureReady();
  const r = run(args, { check: true });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new GhError(`gh ${args.slice(0, 2).join(' ')}: unexpected output (not JSON)`);
  }
}

// ---------------------------------------------------------------- refs
export interface PrRef { repo: string; number: number }

export function checkRepo(repo: string): string {
  if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.endsWith('.git')) {
    throw new ReviewError(`"${repo}" is not a GitHub repository (expected owner/name)`);
  }
  return repo;
}

function checkNumber(n: string | number): number {
  const s = String(n);
  if (!/^[1-9][0-9]{0,15}$/.test(s) || !Number.isSafeInteger(Number(s))) throw new ReviewError(`"${s}" is not a pull request number`);
  return Number(s);
}

/**
 * A PR reference: https://github.com/owner/repo/pull/123 (anything after the number is ignored), owner/repo#123, or
 * owner/repo followed by the number as the next argument. Returns the ref and how many arguments it used.
 */
export function parseRef(arg: string, next?: string): [PrRef, number] {
  const a = String(arg).trim();
  let m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pulls?\/(\d+)(?:[/?#].*)?$/i.exec(a);
  if (m) return [{ repo: checkRepo(m[1]), number: checkNumber(m[2]) }, 1];
  if (/^https?:\/\//i.test(a)) throw new ReviewError(`${a}: not a github.com pull request URL (https://github.com/owner/repo/pull/123)`);
  m = /^([^#\s]+)#(\d+)$/.exec(a);
  if (m) return [{ repo: checkRepo(m[1]), number: checkNumber(m[2]) }, 1];
  if (REPO_RE.test(a) && next !== undefined && /^#?\d+$/.test(next.trim())) {
    return [{ repo: checkRepo(a), number: checkNumber(next.trim().replace(/^#/, '')) }, 2];
  }
  throw new ReviewError(`"${a}" is not a pull request (use a URL, owner/repo#123 or owner/repo 123)`);
}

/** Every ref in a list of arguments (owner/repo 123 takes two). */
export function parseRefs(args: string[]): PrRef[] {
  const out: PrRef[] = [];
  for (let i = 0; i < args.length;) {
    const [ref, used] = parseRef(args[i], args[i + 1]);
    out.push(ref);
    i += used;
  }
  return out;
}

// ---------------------------------------------------------------- reads
export const VIEW_FIELDS = [
  'number', 'url', 'title', 'body', 'state', 'isDraft', 'author', 'headRefName', 'baseRefName', 'headRefOid',
  'createdAt', 'updatedAt', 'mergedAt', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'additions', 'deletions',
  'changedFiles', 'labels', 'reviewRequests', 'statusCheckRollup', 'reviews', 'comments', 'files',
];

const R = (ref: PrRef) => [String(ref.number), '-R', checkRepo(ref.repo)];

export function viewArgs(ref: PrRef): string[] {
  return ['pr', 'view', ...R(ref), '--json', VIEW_FIELDS.join(',')];
}

export function prView(ref: PrRef): any {
  return json(viewArgs(ref));
}

/** The PR's diff, or null with the reason when GitHub will not produce one (e.g. too large). */
export function prDiff(ref: PrRef): [string | null, string] {
  ensureReady();
  const args = ['pr', 'diff', ...R(ref), '--color', 'never'];
  const r = run(args);
  if (r.status !== 0) return [null, ghError(args, r)];
  return [r.stdout, ''];
}

export const THREADS_QUERY = 'query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { '
  + 'pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id isResolved isOutdated path line originalLine '
  + 'comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { author { login } body createdAt url } } } } } } }';

export function threadsArgs(ref: PrRef): string[] {
  const [owner, name] = checkRepo(ref.repo).split('/');
  return ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${ref.number}`];
}

const COMMENTS_QUERY = 'query($id: ID!, $after: String) { node(id: $id) { ... on PullRequestReviewThread { '
  + 'comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { login } body createdAt url } } } } }';

/** Page through complete thread/comment connections, refusing partial GraphQL answers. */
export function prThreads(ref: PrRef): any[] {
  const out: any[] = [];
  const next = (c: any): string => {
    if (!c?.pageInfo?.hasNextPage) return '';
    if (typeof c.pageInfo.endCursor !== 'string' || !c.pageInfo.endCursor) throw new GhError('gh api graphql: missing page cursor');
    return c.pageInfo.endCursor;
  };
  const connection = (d: any, c: any): any => {
    if (d?.errors?.length || !Array.isArray(c?.nodes)) {
      const error = Array.isArray(d?.errors) ? d.errors.map((e: any) => e?.message).join('; ') : 'no review threads in the answer';
      throw new GhError(`gh api graphql (${ref.repo}#${ref.number}): ${error}`);
    }
    return c;
  };
  let cursor = '';
  const seen = new Set<string>();
  do {
    const d = json([...threadsArgs(ref), ...(cursor ? ['-f', `after=${cursor}`] : [])]);
    const c = connection(d, d?.data?.repository?.pullRequest?.reviewThreads);
    for (const thread of c.nodes) {
      let comments = thread.comments;
      let after = next(comments);
      const pages = new Set<string>();
      while (after) {
        if (pages.has(after) || pages.size >= 1000) throw new GhError('gh api graphql: review comment pagination did not finish');
        pages.add(after);
        const page = json(['api', 'graphql', '-f', `query=${COMMENTS_QUERY}`, '-f', `id=${checkThread(thread.id)}`, '-f', `after=${after}`]);
        const more = connection(page, page?.data?.node?.comments);
        comments.nodes.push(...more.nodes);
        after = next(more);
      }
      out.push(thread);
    }
    cursor = next(c);
    if (cursor && (seen.has(cursor) || seen.size >= 1000)) throw new GhError('gh api graphql: review thread pagination did not finish');
    seen.add(cursor);
  } while (cursor);
  return out;
}

export const SEARCH_FIELDS = ['number', 'repository', 'url', 'title', 'isDraft', 'updatedAt'];

/** `gh search prs` for my open PRs, or (requested) open PRs where my review is requested. */
export function searchArgs(repos: string[] = [], requested = false): string[] {
  return ['search', 'prs', requested ? '--review-requested' : '--author', '@me', '--state', 'open', '--limit', '200',
    '--json', SEARCH_FIELDS.join(','), ...repos.flatMap((r) => ['--repo', checkRepo(r)])];
}

let viewerLogin: string | null = null;

/** The login gh is authenticated as (cached per process). */
export function viewer(): string {
  if (viewerLogin === null) {
    const d = json(['api', 'user']);
    if (typeof d?.login !== 'string' || !d.login) throw new GhError('gh api user: cannot determine the authenticated login');
    viewerLogin = d.login;
  }
  return viewerLogin ?? '';
}

/** Open PRs that are mine (or, with `requested`, that wait for my review), optionally only in `repos`. */
export function search(repos: string[] = [], requested = false): PrRef[] {
  const d = json(searchArgs(repos, requested));
  if (!Array.isArray(d)) throw new GhError('gh search prs: unexpected output');
  const out: PrRef[] = [];
  for (const x of d) {
    const repo = x?.repository?.nameWithOwner;
    if (typeof repo === 'string' && REPO_RE.test(repo) && Number.isInteger(x.number)) out.push({ repo, number: x.number });
  }
  return out;
}

// ---------------------------------------------------------------- writes (each returns the argv it ran)
export interface Mutation { args: string[]; input?: string }

function mutate(m: Mutation): GhResult {
  ensureReady();
  const r = run(m.args, { input: m.input });
  if (r.status !== 0) throw new GhError(ghError(m.args, r));
  return r;
}

function checkBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) throw new ReviewError('the comment body is empty');
  if (body.length > 60000) throw new ReviewError('the comment body is longer than 60000 characters');
  return body;
}

export function checkThread(id: unknown): string {
  if (typeof id !== 'string' || !NODE_ID_RE.test(id)) throw new ReviewError(`"${String(id)}" is not a review thread id`);
  return id;
}

export function checkReviewer(r: string): string {
  if (!REVIEWER_RE.test(r)) throw new ReviewError(`"${r}" is not a GitHub login or org/team`);
  return r.replace(/^@/, '');
}

export const REPLY_MUTATION = 'mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: '
  + '{pullRequestReviewThreadId: $thread, body: $body}) { comment { url } } }';
export const RESOLVE_MUTATION = 'mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }';
export const UNRESOLVE_MUTATION = 'mutation($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }';

export const mutations = {
  comment: (ref: PrRef, body: string): Mutation => ({ args: ['pr', 'comment', ...R(ref), '--body-file', '-'], input: checkBody(body) }),
  reply: (thread: string, body: string): Mutation => ({
    args: ['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-f', `thread=${checkThread(thread)}`, '-f', `body=${checkBody(body)}`],
  }),
  resolve: (thread: string, unresolve = false): Mutation => ({
    args: ['api', 'graphql', '-f', `query=${unresolve ? UNRESOLVE_MUTATION : RESOLVE_MUTATION}`, '-f', `thread=${checkThread(thread)}`],
  }),
  rerun: (repo: string, runId: number, failedOnly = true): Mutation => ({
    args: ['run', 'rerun', String(checkNumber(runId)), ...(failedOnly ? ['--failed'] : []), '-R', checkRepo(repo)],
  }),
  updateBranch: (ref: PrRef, rebase = false): Mutation => ({ args: ['pr', 'update-branch', ...R(ref), ...(rebase ? ['--rebase'] : [])] }),
  ready: (ref: PrRef, undo = false): Mutation => ({ args: ['pr', 'ready', ...R(ref), ...(undo ? ['--undo'] : [])] }),
  merge: (ref: PrRef, method: string, auto = false, deleteBranch = false): Mutation => {
    if (!['squash', 'merge', 'rebase'].includes(method)) throw new ReviewError('merge: pick --squash, --merge or --rebase');
    return { args: ['pr', 'merge', ...R(ref), `--${method}`, ...(auto ? ['--auto'] : []), ...(deleteBranch ? ['--delete-branch'] : [])] };
  },
  close: (ref: PrRef): Mutation => ({ args: ['pr', 'close', ...R(ref)] }),
  reopen: (ref: PrRef): Mutation => ({ args: ['pr', 'reopen', ...R(ref)] }),
  /** One pull request review (inline comments + verdict) as JSON on stdin. */
  review: (ref: PrRef, payload: Record<string, any>): Mutation => ({
    args: ['api', `repos/${checkRepo(ref.repo)}/pulls/${checkNumber(ref.number)}/reviews`, '-X', 'POST', '--input', '-'],
    input: JSON.stringify(payload),
  }),
  request: (ref: PrRef, reviewers: string[]): Mutation => {
    const list = reviewers.map(checkReviewer);
    if (!list.length) throw new ReviewError('request: give --reviewers a,b');
    return { args: ['pr', 'edit', ...R(ref), '--add-reviewer', list.join(',')] };
  },
};

export function exec(m: Mutation): string {
  const output = mutate(m).stdout.trim();
  if (m.args[0] === 'api' && m.args[1] === 'graphql') {
    let data: any;
    try { data = JSON.parse(output); } catch { throw new GhError('gh api graphql: unexpected output (not JSON)'); }
    if (Array.isArray(data.errors) && data.errors.length) throw new GhError('gh api graphql: ' + data.errors.map((e: any) => e.message).join('; ').slice(0, 2000));
  }
  return output;
}
