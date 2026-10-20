/**
 * review-kit attach: set a repository up for review-kit in one step.
 *
 * Creates (or reuses) one review folder per kind (UI/UX, backend, ideas, design) and adds a short pointer to the repo's agent
 * instructions file, so any coding agent working there knows to use the review-kit skill. The pointer sits between
 * markers and is replaced in place on later runs, so attach can be re-run safely.
 */
import * as companions from './companions.js';
import * as edit from './edit.js';
import { ReviewError } from './errors.js';
import * as model from './model.js';
import { abspath, basename, dirname, exists, get, has, isDict, isdir, isfile, join, readText, relpath, reprStr } from './py.js';

export const BEGIN = '<!-- review-kit:begin -->';
export const END = '<!-- review-kit:end -->';
export const INSTALL = 'npm i -g @horus52/review-kit && review-kit setup';
export const LEGACY_DIRS = ['.review', 'docs/review', 'review', '.'];
export const KIND_DEFAULTS: Record<string, { title: string; platforms: string[]; label: string }> = {
  ui: { title: 'UI/UX review', platforms: ['mobile', 'desktop'], label: 'UI/UX' },
  backend: { title: 'Backend review', platforms: ['default'], label: 'Backend practices' },
  ideas: { title: 'Ideas and research', platforms: ['default'], label: 'Ideas and research' },
  design: { title: 'Design proposals', platforms: ['mobile', 'desktop'], label: 'Design proposals' },
  prs: { title: 'Pull requests', platforms: ['default'], label: 'Pull request dashboard' },
};
/** Kinds whose --platforms override applies (the screen-based ones). */
const SCREEN_KINDS = ['ui', 'design'];
/** Pointer order: the flow runs ideas -> design -> ui/backend review. */
const POINTER_ORDER = ['prs', 'ideas', 'design', 'ui', 'backend'];
export const KINDS = Object.keys(KIND_DEFAULTS);

/** reviews: [kind, reviewRelDir][] */
export function pointer(reviews: [string, string][]): string {
  const rows = reviews.map(([k, rel]) => `- ${KIND_DEFAULTS[k].label}: \`${rel}/review.json\``).join('\n');
  let flow = reviews.some(([k]) => k === 'ideas' || k === 'design')
    ? '\nIdeation only researches and proposes; design options are built on their own branches and adopted only when the\nuser picks one.\n'
    : '';
  if (reviews.some(([k]) => k === 'prs')) {
    flow += '\nThe PR dashboard is kept in sync and annotated; commenting, merging, closing, re-running, reviewing or pushing\n'
      + 'happens only on the user\'s word for that PR.\n';
  }
  return `${BEGIN}
## Review tracking (review-kit)

When reviewing or fixing this repo across several steps, record the work with review-kit: issues found, fixes
shipped with their evidence (before/after screenshots for UI, code and test output for backend), and what is
left. A review run only reports problems; apply fixes only for the issues the user approves.${flow ? '' : ' The reviews live in:'}
${flow}${flow ? '\nThe reviews live in:\n' : ''}
${rows}

Before starting, read the review-kit skill: run \`review-kit home\` and open \`skill/review-kit/SKILL.md\` in the
folder it prints. It points to a playbook per review kind. If \`review-kit\` is not installed, install it with:

    ${INSTALL}
${END}
`;
}

export function kindOf(path: string): string | null {
  try {
    const data = model.load(path);
    if (!isDict(data) || !has(data, 'project') || !isDict(data.project)) return null;
    return has(data.project, 'kind') ? data.project.kind : 'ui';
  } catch (e) {
    if (e instanceof ReviewError) return null;
    throw e;
  }
}

export function findExisting(repo: string, kind = 'ui', base = '.review'): string | null {
  let p = join(repo, base, kind, 'review.json');
  if (isfile(p)) return p;
  for (const d of LEGACY_DIRS) {
    p = join(repo, d, 'review.json');
    if (isfile(p) && kindOf(p) === kind) return p;
  }
  return null;
}

/** Insert or replace the marked block. Returns 'created', 'updated', 'added' or 'unchanged'. */
function writePointer(path: string, block: string): string {
  if (!exists(path)) {
    model.writeText(path, block);
    return 'created';
  }
  const old = readText(path);
  let next: string;
  let state: string;
  const b = old.indexOf(BEGIN);
  if (b >= 0 && old.includes(END)) {
    const e = old.indexOf(END, b + BEGIN.length);
    if (e >= 0) {
      let end = e + END.length;
      if (old[end] === '\n') end++;
      next = old.slice(0, b) + block + old.slice(end);
    } else next = old;
    state = 'updated';
  } else {
    next = old + (old.endsWith('\n') || !old ? '' : '\n') + (old ? '\n' : '') + block;
    state = 'added';
  }
  if (next === old) return 'unchanged';
  model.writeText(path, next);
  return state;
}

export interface AttachOptions {
  kinds?: string[];
  directory?: string;
  name?: string | null;
  title?: string | null;
  platforms?: string[] | null;
  ignoreScreenshots?: boolean;
  accent?: string | null;
  agentFiles?: string[] | null;
}

/**
 * Create (or reuse) one review per kind under <directory>/<kind>/. Returns human-readable log lines.
 *
 * title and platforms override the kind's defaults (platforms only apply to UI and design reviews).
 * agentFiles=null means AGENTS.md, plus CLAUDE.md when the repo already has one. Pass [] to skip.
 */
export function attach(repo = '.', opts: AttachOptions = {}): string[] {
  const { directory = '.review', name = null, title = null, platforms = null, ignoreScreenshots = false, accent = null } = opts;
  let agentFiles = opts.agentFiles ?? null;
  repo = abspath(repo);
  if (!isdir(repo)) throw new ReviewError(`${repo}: no such directory`);
  let kinds = [...new Set(opts.kinds || ['ui'])];
  if (!kinds.length) kinds = ['ui'];
  for (const k of kinds) {
    if (!has(KIND_DEFAULTS, k)) throw new ReviewError(`unknown review kind ${reprStr(k)}; expected one of ${KINDS.join(', ')}`);
  }
  const log: string[] = [];
  const reviews: [string, string][] = [];
  for (const k of kinds) {
    let review = findExisting(repo, k, directory);
    if (review) log.push(`${k}: using existing ${relpath(review, repo)}`);
    else {
      const d = KIND_DEFAULTS[k];
      const plats = (platforms && platforms.length && SCREEN_KINDS.includes(k) ? platforms : null) || d.platforms;
      review = edit.init(join(repo, directory, k), name || basename(repo),
        (title && kinds.length === 1 ? title : null) || d.title, plats, ignoreScreenshots, accent, k);
      log.push(`${k}: created ${relpath(review, repo)} (+ screenshots/, pending/, .gitignore)`);
    }
    reviews.push([k, relpath(dirname(review), repo)]);
    const missing = companions.status([k], repo).filter(([, , path]) => !path).map(([, c]) => c.name);
    if (missing.length) {
      log.push(`${k}: companion skills not found: ${missing.join(', ')} `
        + `(optional; \`review-kit companions install --kind ${k}\` adds them)`);
    }
  }
  for (const k of KINDS) { // keep reviews of other kinds in the pointer
    const existing = kinds.includes(k) ? null : findExisting(repo, k, directory);
    if (existing) reviews.push([k, relpath(dirname(existing), repo)]);
  }
  reviews.sort((a, b) => POINTER_ORDER.indexOf(a[0]) - POINTER_ORDER.indexOf(b[0]));
  // Several reviews build into one combined site at <directory>/site/: keep it out of git too.
  if (reviews.length > 1 && edit.ignoreCombinedSite(join(repo, directory))) {
    log.push(`${relpath(join(repo, directory, '.gitignore'), repo)}: ignores the combined site/`);
  }

  if (agentFiles === null) agentFiles = ['AGENTS.md', ...(isfile(join(repo, 'CLAUDE.md')) ? ['CLAUDE.md'] : [])];
  const block = pointer(reviews);
  for (const n of agentFiles) {
    const state = writePointer(join(repo, n), block);
    log.push(`${n}: review-kit pointer ${state}`);
  }
  return log;
}

