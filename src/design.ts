/**
 * Design options on git branches: option new / option record / adopt / discard.
 *
 * Each option is built on its own branch, design/<proposal>/<option>, in a worktree outside the repository (nested
 * worktrees confuse test runners and linters). `option record` snapshots the branch's diff into the review folder, so
 * the site keeps showing every option after its branch is gone. Only `adopt` touches the user's branch, and only
 * when the user picked an option; nothing here pushes.
 */
import fs from 'node:fs';
import { importImage } from './edit.js';
import { ReviewError } from './errors.js';
import * as git from './git.js';
import { checkRefId, findOption, findProposal, parseScore } from './ideas.js';
import * as model from './model.js';
import { abspath, basename, copyDict, dirname, exists, get, has, isabs, isdir, join, normpath, realpath, relpath, setKey, today, truthy } from './py.js';

const S = model.s;
/** Parent folders that hold one review per kind; changes there never block `adopt`. */
const REVIEW_PARENTS = ['.review', 'docs/review'];

export const branchName = (proposal: string, option: string) => `design/${proposal}/${option}`;
export const snapshotName = (proposal: string, option: string) => `${proposal}--${option}`;

interface Ctx { reviewPath: string; base: string; root: string }

/** The repository holding review.json; refuses a review that lives inside a linked worktree (a stale copy). */
function context(reviewPath: string): Ctx {
  const base = realpath(model.baseDir(reviewPath));
  const root = git.root(base);
  if (!git.isMainCheckout(base)) {
    throw new ReviewError(`${reviewPath} is inside a linked worktree; run review-kit from the main checkout, `
      + 'where the review that records every option lives');
  }
  return { reviewPath, base, root };
}

/** Absolute worktree folder of an option (recorded relative to the repository root). */
function worktreeAbs(ctx: Ctx, rel: string): string {
  return normpath(join(ctx.root, rel));
}

// ---------------------------------------------------------------- option new
export interface OptionNewResult { option: any; worktree: string; branch: string; base: string; log: string[] }

export function optionNew(reviewPath: string, data: any, proposalId: string, optionId: string, title: string,
  baseRef = 'HEAD', worktreeRoot: string | null = null): OptionNewResult {
  checkRefId(proposalId, 'proposal');
  checkRefId(optionId, 'option');
  if (!title || !title.trim()) throw new ReviewError('option new: --title is required');
  const pr = findProposal(data, proposalId);
  const ctx = context(reviewPath);
  const options: any[] = has(pr, 'options') ? pr.options : (pr.options = []);
  const existing = options.find((o: any) => get(o, 'id') === optionId);
  if (existing && (truthy(get(existing, 'branch')) || truthy(get(existing, 'worktree')))) {
    throw new ReviewError(`option "${optionId}" of "${proposalId}" already has a branch (${S(get(existing, 'branch'))})`);
  }
  const branch = branchName(proposalId, optionId);
  if (git.branchExists(ctx.root, branch)) {
    throw new ReviewError(`branch ${branch} already exists; pick another option id, or remove it with \`review-kit discard ${proposalId} --option ${optionId}\``);
  }
  const baseSha = git.commit(ctx.root, baseRef);
  const wtRoot = worktreeRoot ? abspath(worktreeRoot) : join(dirname(ctx.root), basename(ctx.root) + '.designs');
  fs.mkdirSync(wtRoot, { recursive: true });
  const wt = join(realpath(wtRoot), snapshotName(proposalId, optionId));
  if (exists(wt)) throw new ReviewError(`${wt} already exists; remove it or pass --worktree-root DIR`);
  const log: string[] = [];
  const rel = relpath(wt, ctx.root);
  if (!rel.startsWith('..')) {
    log.push('warning: the worktree is inside the repository; test runners, linters and `adopt` will see it as untracked files');
  }
  git.run(ctx.root, ['worktree', 'add', '-b', branch, wt, baseSha]);
  const opt: Record<string, any> = existing ? copyDict(existing) : { id: optionId, title, status: 'proposed' };
  opt.title = title;
  Object.assign(opt, { branch, base: baseSha, worktree: rel });
  delete opt.gone;
  if (existing) options[options.indexOf(existing)] = opt;
  else options.push(opt);
  return { option: opt, worktree: wt, branch, base: baseSha, log };
}

// ---------------------------------------------------------------- option record
export interface RecordFields {
  title?: string | null;
  summary?: string | null;
  reasoning?: string | null;
  evidence?: string | null;
  pros?: string[] | null;
  cons?: string[] | null;
  scores?: string[];
  shots?: [string, string, string?][];
}

/** Write the diff of base...branch to diffs/<p>--<o>.patch (capped) and return the option's `diff` object. */
function snapshot(ctx: Ctx, proposalId: string, optionId: string, baseSha: string, branch: string): Record<string, any> {
  const range = `${baseSha}...refs/heads/${branch}`;
  const patch = git.run(ctx.root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', range, '--']).stdout;
  const numstat = git.run(ctx.root, ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', range, '--']).stdout.toString('utf8');
  let body = patch;
  let truncated = false;
  if (body.length > model.DIFF_CAP) {
    const nl = body.subarray(0, model.DIFF_CAP).lastIndexOf(0x0a);
    body = body.subarray(0, nl > 0 ? nl + 1 : model.DIFF_CAP);
    truncated = true;
  }
  const rel = `diffs/${snapshotName(proposalId, optionId)}.patch`;
  fs.mkdirSync(join(ctx.base, 'diffs'), { recursive: true });
  model.writeText(join(ctx.base, rel), body);
  const files = git.parseNumstat(numstat);
  const diff: Record<string, any> = {
    path: rel, files,
    insertions: files.reduce((n, f) => n + f.add, 0), deletions: files.reduce((n, f) => n + f.del, 0),
  };
  if (truncated) diff.truncated = true;
  return diff;
}

/**
 * Record an option's write-up and refresh its diff snapshot from the branch. Fields given replace the old ones;
 * scores are merged per criterion and screenshots are added. Returns log lines (warnings start with "warning:").
 */
export function optionRecord(reviewPath: string, data: any, proposalId: string, optionId: string, f: RecordFields): string[] {
  const pr = findProposal(data, proposalId);
  const opt = findOption(pr, optionId);
  const log: string[] = [];
  const parsedScores = (f.scores || []).map((s) => parseScore(s, get(pr, 'criteria') || []));
  const plats = model.platforms(data).map((p: any) => p.id);
  for (const [plat] of f.shots || []) {
    if (!plats.includes(plat)) throw new ReviewError(`--shot: unknown platform "${plat}" (known: ${plats.join(', ')})`);
  }
  const branch = get(opt, 'branch');
  if (truthy(branch)) {
    const ctx = context(reviewPath);
    if (!git.branchExists(ctx.root, branch)) {
      log.push(`warning: branch ${branch} not found; kept the existing diff snapshot`);
    } else {
      const baseSha = truthy(get(opt, 'base')) ? git.commit(ctx.root, opt.base) : git.commit(ctx.root, 'HEAD');
      opt.base = baseSha;
      opt.head = git.commit(ctx.root, `refs/heads/${branch}`);
      opt.diff = snapshot(ctx, proposalId, optionId, baseSha, branch);
      const d = opt.diff;
      log.push(`snapshot ${d.path}: ${d.files.length} file(s), +${d.insertions} -${d.deletions}${d.truncated ? ' (truncated at 400 KB)' : ''}`);
      if (!d.files.length) log.push(`warning: ${branch} has no changes over its base; commit the option's work on the branch first`);
      const wt = truthy(get(opt, 'worktree')) ? worktreeAbs(ctx, opt.worktree) : null;
      if (wt && isdir(wt)) {
        const dirty = git.status(wt);
        if (dirty.length) {
          log.push(`warning: ${dirty.length} uncommitted change(s) in the worktree are not in the snapshot; commit them on ${branch} and record again`);
        }
      }
    }
  }
  for (const k of ['title', 'summary', 'reasoning', 'evidence'] as const) {
    const v = f[k];
    if (v !== null && v !== undefined) setKey(opt, k, v);
  }
  if (f.pros) opt.pros = f.pros;
  if (f.cons) opt.cons = f.cons;
  if (parsedScores.length) {
    const scores: Record<string, any> = has(opt, 'scores') ? opt.scores : (opt.scores = {});
    for (const [id, sc] of parsedScores) setKey(scores, id, sc);
  }
  const base = model.baseDir(reviewPath);
  for (const [plat, path, caption] of f.shots || []) {
    const platforms: Record<string, any> = has(opt, 'platforms') ? opt.platforms : (opt.platforms = {});
    if (!has(platforms, plat)) setKey(platforms, plat, {});
    const p = platforms[plat];
    const images: any[] = has(p, 'images') ? p.images : (p.images = []);
    const img = importImage(caption ? { src: path, caption } : path, base, snapshotName(proposalId, optionId));
    const src = model.imageSrc(img);
    const at = images.findIndex((x) => model.imageSrc(x) === src);
    if (at >= 0) images[at] = img;
    else images.push(img);
    log.push(`${plat}: ${src}`);
  }
  return log;
}

// ---------------------------------------------------------------- adopt
/** Paths outside the review folders with changes (staged, unstaged or untracked); staged review files count too. */
function blockingChanges(ctx: Ctx): string[] {
  const relBase = relpath(ctx.base, ctx.root);
  const parent = dirname(relBase);
  const ignored = ['.review', relBase, ...(REVIEW_PARENTS.includes(parent) ? [parent] : [])].filter((p) => p && p !== '.');
  const inside = (p: string) => ignored.some((d) => p === d || p.startsWith(d + '/'));
  const out: string[] = [];
  for (const e of git.status(ctx.root)) {
    const staged = e.x !== ' ' && e.x !== '?';
    if (!inside(e.path) || (e.orig && !inside(e.orig))) out.push(e.path);
    else if (staged) out.push(`${e.path} (staged)`);
  }
  return out;
}

export interface AdoptOptions { commit?: boolean; message?: string | null; recordOnly?: boolean }

/** Mark the option adopted (the others rejected) in data. */
function recordAdoption(pr: any, opt: any, adopted: Record<string, any>): void {
  adopted.date = today();
  pr.status = 'adopted';
  pr.adopted = adopted;
  for (const o of get(pr, 'options') || []) o.status = o === opt ? 'adopted' : 'rejected';
}

/**
 * Merge an option into the current branch (squash: one commit), or apply its diff snapshot when the branch is gone.
 * On a conflict git's state is left as it is and the adoption is not recorded.
 */
export function adopt(reviewPath: string, data: any, proposalId: string, optionId: string, opts: AdoptOptions = {}): string[] {
  const { commit = true, message = null } = opts;
  const pr = findProposal(data, proposalId);
  const opt = findOption(pr, optionId);
  if (get(pr, 'status') === 'adopted' && isDictLike(get(pr, 'adopted'))) {
    throw new ReviewError(`proposal "${proposalId}" already adopted option "${S(pr.adopted.option)}"`);
  }
  const ctx = context(reviewPath);
  if (opts.recordOnly) { // the user merged it by hand (e.g. after resolving a conflict): record HEAD
    const adopted = { option: optionId, commit: git.commit(ctx.root, 'HEAD') };
    recordAdoption(pr, opt, adopted);
    return [`proposal ${proposalId}: recorded ${optionId} as adopted at ${adopted.commit.slice(0, 7)} (no git changes made)`];
  }
  const current = git.currentBranch(ctx.root);
  if (current === null) throw new ReviewError('HEAD is detached; check out the branch the option should go into, then adopt');
  if (current.startsWith('design/')) {
    throw new ReviewError(`the current branch ${current} is a design branch; switch to the branch the option should go into`);
  }
  const dirty = blockingChanges(ctx);
  if (dirty.length) {
    throw new ReviewError('the working tree has changes outside the review folders; commit or stash them first:\n  '
      + dirty.slice(0, 10).join('\n  ') + (dirty.length > 10 ? `\n  ... and ${dirty.length - 10} more` : ''));
  }
  const branch = truthy(get(opt, 'branch')) ? opt.branch : branchName(proposalId, optionId);
  if (typeof branch !== 'string' || !branch.startsWith('design/')) throw new ReviewError(`option branch ${S(branch)} is not a design/ branch`);
  const log: string[] = [];
  const undo = 'to give up instead, run `git reset --merge` (`git merge --abort` does not work after a squash merge)';
  if (git.branchExists(ctx.root, branch)) {
    const r = git.run(ctx.root, ['merge', '--squash', `refs/heads/${branch}`], true);
    if (r.status !== 0) {
      const files = git.conflicts(ctx.root);
      if (files.length) {
        throw new ReviewError(`merging ${branch} into ${current} conflicts in:\n  ${files.join('\n  ')}\n`
          + `resolve them, \`git add\` the files and commit; ${undo}. The adoption was not recorded; after committing, `
          + `record it with \`review-kit adopt ${proposalId} ${optionId} --record-only\``);
      }
      throw new ReviewError(`git merge --squash ${branch} failed: ${r.stderr || r.stdout.toString('utf8').trim()}`);
    }
    log.push(`merged ${branch} into ${current} (squashed)`);
  } else {
    const d = get(opt, 'diff');
    if (!isDictLike(d)) throw new ReviewError(`branch ${branch} is gone and the option has no diff snapshot to apply`);
    if (get(d, 'truncated') === true) throw new ReviewError(`branch ${branch} is gone and its diff snapshot was truncated; it cannot be applied`);
    const patch = join(ctx.base, d.path);
    if (!exists(patch)) throw new ReviewError(`branch ${branch} is gone and ${d.path} is missing`);
    const r = git.run(ctx.root, ['apply', '--3way', '--index', abspath(patch)], true);
    if (r.status !== 0) {
      const files = git.conflicts(ctx.root);
      if (files.length) {
        throw new ReviewError(`applying ${d.path} conflicts in:\n  ${files.join('\n  ')}\nresolve them, \`git add\` the files and commit; ${undo}. `
          + `The adoption was not recorded; after committing, record it with \`review-kit adopt ${proposalId} ${optionId} --record-only\``);
      }
      throw new ReviewError(`branch ${branch} is gone and ${d.path} does not apply: ${r.stderr}`);
    }
    log.push(`branch ${branch} is gone; applied ${d.path} instead`);
  }
  if (git.run(ctx.root, ['diff', '--cached', '--quiet'], true).status === 0) {
    throw new ReviewError(`${branch} brings no changes into ${current} (already adopted, or nothing committed on the branch)`);
  }
  const adopted: Record<string, any> = { option: optionId };
  if (commit) {
    const msg = message || `Adopt design ${proposalId}: ${S(opt.title)}`;
    const r = git.run(ctx.root, ['commit', '-m', msg], true);
    if (r.status === 0) {
      adopted.commit = git.commit(ctx.root, 'HEAD');
      log.push(`committed ${adopted.commit.slice(0, 7)} "${msg}"`);
    } else {
      log.push(`warning: git commit failed (${r.stderr || r.stdout.toString('utf8').trim()}); the changes are staged, commit them yourself`);
    }
  } else log.push('changes are staged, not committed (--no-commit)');
  recordAdoption(pr, opt, adopted);
  log.push(`proposal ${proposalId}: adopted ${optionId}; other options marked rejected (\`review-kit discard ${proposalId}\` removes their branches)`);
  return log;
}

const isDictLike = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------- discard
export interface DiscardOptions { options?: string[]; force?: boolean; dryRun?: boolean }

/**
 * Remove the worktrees and branches of a proposal's options. Default: every option that was not adopted, plus the
 * adopted one once its commit is in HEAD. Snapshots and screenshots stay; discarded options get `gone: true` and
 * lose their `worktree` (the `branch` name is kept for the record).
 */
export function discard(reviewPath: string, data: any, proposalId: string, opts: DiscardOptions = {}): string[] {
  const { force = false, dryRun = false } = opts;
  const pr = findProposal(data, proposalId);
  const ctx = context(reviewPath);
  let targets: any[];
  if (opts.options && opts.options.length) targets = opts.options.map((id) => findOption(pr, id));
  else {
    targets = [];
    const adopted = get(pr, 'adopted');
    for (const o of get(pr, 'options') || []) {
      if (isDictLike(adopted) && adopted.option === o.id) {
        const c = get(adopted, 'commit');
        if (!truthy(c) || !git.isAncestor(ctx.root, c, 'HEAD')) continue; // not merged yet: keep it
      }
      targets.push(o);
    }
  }
  const log: string[] = [];
  const verb = dryRun ? 'would remove' : 'removed';
  for (const o of targets) {
    const branch = get(o, 'branch');
    if (!truthy(branch)) {
      log.push(`${o.id}: no branch recorded; nothing to remove`);
      continue;
    }
    if (typeof branch !== 'string' || !branch.startsWith('design/')) {
      log.push(`${o.id}: branch ${S(branch)} is not a design/ branch; left alone`);
      continue;
    }
    const rel = get(o, 'worktree');
    const wt = typeof rel === 'string' && rel && !isabs(rel) ? worktreeAbs(ctx, rel) : null;
    let ok = true;
    if (wt && isdir(wt)) {
      if (dryRun) log.push(`${o.id}: ${verb} worktree ${rel}`);
      else {
        const r = git.run(ctx.root, ['worktree', 'remove', ...(force ? ['--force'] : []), wt], true);
        if (r.status === 0) log.push(`${o.id}: ${verb} worktree ${rel}`);
        else {
          ok = false;
          log.push(`${o.id}: kept worktree ${rel}: ${r.stderr}${force ? '' : ' (pass --force to remove it anyway)'}`);
        }
      }
    }
    if (ok && git.branchExists(ctx.root, branch)) {
      if (dryRun) log.push(`${o.id}: ${verb} branch ${branch}`);
      else {
        git.run(ctx.root, ['worktree', 'prune'], true);
        const r = git.run(ctx.root, ['branch', '-D', branch], true);
        if (r.status === 0) log.push(`${o.id}: ${verb} branch ${branch}`);
        else {
          ok = false;
          log.push(`${o.id}: kept branch ${branch}: ${r.stderr}`);
        }
      }
    }
    if (ok && !dryRun) {
      delete o.worktree;
      o.gone = true;
    }
  }
  if (!targets.length) log.push('nothing to discard');
  return log;
}
