/**
 * review-kit clean: remove what a review leaves behind once it has been merged and built.
 *
 * - the built site (only a folder that carries build.MARKER, so nothing else is ever deleted)
 * - pending/*.applied.json hand-off files that apply-pending has already merged
 * - with orphans=true, files under screenshots/ that neither review.json nor a waiting pending/*.json references
 */
import fs from 'node:fs';
import { MARKER } from './build.js';
import * as edit from './edit.js';
import { ReviewError } from './errors.js';
import * as model from './model.js';
import { abspath, get, isdir, islink, join, listdir, normpath, osError, relpath, sorted, truthy, walk } from './py.js';

export const KEEP = new Set(['.gitkeep']);

/** Absolute paths of every local file review.json points at (images and local links). */
function referenced(data: any, base: string): Set<string> {
  const refs = new Set<string>();
  for (const [, img] of model.iterImages(data)) {
    const src = model.imageSrc(img);
    if (truthy(src)) refs.add(normpath(join(base, src)));
  }
  const links: any[] = [...(get(get(data, 'project') || {}, 'links') || [])];
  for (const fx of get(data, 'fixes') || []) links.push(...(get(fx, 'links') || []));
  for (const link of links) {
    const href = get(link, 'href') || '';
    if (href && !/^[a-z][a-z0-9+.-]*:|^\/|^#/i.test(href)) refs.add(normpath(join(base, href)));
  }
  return refs;
}

/** Files that hand-offs waiting in pending/ point at: their screenshots are not orphans yet. */
function pendingRefs(base: string): Set<string> {
  const pending = join(base, 'pending');
  const refs = new Set<string>();
  if (!isdir(pending)) return refs;
  for (const n of sorted(listdir(pending))) {
    if (n.endsWith('.json') && !n.endsWith('.applied.json')) {
      let env: any;
      try {
        env = edit.normaliseEnvelope(model.load(join(pending, n)));
      } catch (e) {
        if (!(e instanceof ReviewError)) throw e;
        throw new ReviewError(`${e.message}\n(--orphans needs every pending hand-off readable; fix or apply it first)`);
      }
      const fix = get(env, 'fix');
      for (const r of referenced({ issues: get(env, 'issues') || [], fixes: truthy(fix) ? [fix] : [] }, base)) refs.add(r);
    }
  }
  return refs;
}

/** Files under screenshots/ that nothing in review.json references. */
export function orphans(reviewPath: string): string[] {
  const base = model.baseDir(reviewPath);
  const shots = join(base, 'screenshots');
  if (!isdir(shots)) return [];
  const refs = referenced(model.load(reviewPath), base);
  for (const r of pendingRefs(base)) refs.add(r);
  const out: string[] = [];
  for (const [root, , files] of walk(shots)) {
    for (const n of sorted(files)) {
      const p = normpath(join(root, n));
      if (!KEEP.has(n) && !refs.has(p)) out.push(p);
    }
  }
  return sorted(out);
}

function removeEmptyDirs(top: string): void {
  for (const [root] of walk(top, false)) {
    if (root !== top && !listdir(root).length) fs.rmdirSync(root);
  }
}

/** shutil.rmtree */
function rmtree(path: string): void {
  if (islink(path)) throw osError('EINVAL', undefined, 'Cannot call rmtree on a symbolic link');
  fs.rmSync(path, { recursive: true });
}

/** Remove a built site folder, but only one that carries build.MARKER. Returns [removed, skipped]. */
export function cleanSite(out: string, dryRun = false): [string[], string[]] {
  if (!isdir(out)) return [[], []];
  if (!fs.existsSync(join(out, MARKER))) return [[], [`${relpath(out)}: not built by review-kit (no ${MARKER}); left alone`]];
  if (!dryRun) rmtree(out);
  return [[relpath(out) + '/'], []];
}

export interface CleanOptions {
  out?: string | null;
  site?: boolean;
  applied?: boolean;
  orphaned?: boolean;
  dryRun?: boolean;
}

/** Returns [removed, skipped]: lists of human-readable lines. Nothing is touched when dryRun is set. */
export function clean(reviewPath: string, opts: CleanOptions = {}): [string[], string[]] {
  const { site = true, applied = true, orphaned = false, dryRun = false } = opts;
  const base = model.baseDir(reviewPath);
  const removed: string[] = [];
  const skipped: string[] = [];

  if (site) {
    const [r, s] = cleanSite(abspath(opts.out || join(base, 'site')), dryRun);
    removed.push(...r);
    skipped.push(...s);
  }

  if (applied) {
    const pending = join(base, 'pending');
    if (isdir(pending)) {
      for (const n of sorted(listdir(pending))) {
        if (n.endsWith('.applied.json')) {
          const p = join(pending, n);
          removed.push(relpath(p));
          if (!dryRun) fs.unlinkSync(p);
        }
      }
    }
  }

  if (orphaned) {
    for (const p of orphans(reviewPath)) {
      removed.push(relpath(p));
      if (!dryRun) fs.unlinkSync(p);
    }
    if (!dryRun && isdir(join(base, 'screenshots'))) removeEmptyDirs(join(base, 'screenshots'));
  }

  return [removed, skipped];
}
