/** Build the static review site from review.json. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ReviewError } from './errors.js';
import { escape } from './htmlparser.js';
import * as images from './images.js';
import { print } from './io.js';
import * as markdown from './markdown.js';
import * as model from './model.js';
import { dumps } from './pyjson.js';
import {
  abspath, capitalize, cmpStr, exists, get, has, isabs, isdir, isfile, islink, join, listdir, normpath, pySlice,
  readText, realpath, relpath, sorted, splitext, strftime, strip, truthy, walk,
} from './py.js';
import * as safety from './safety.js';
import * as validate from './validate.js';
import { VERSION } from './version.js';

export const MARKER = '.review-kit-site';
export const STATUS_LABELS = {
  open: 'Open', partial: 'Partly fixed', fixed: 'Fixed', notabug: 'Not a bug', wontfix: "Won't fix",
};
export const PLAN_LABELS = { todo: 'To do', doing: 'In progress', partial: 'Partly done', done: 'Done', dropped: 'Dropped' };

const S = model.s;

function cssIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/gu, '_');
}

const or = <T>(v: any, d: T) => (truthy(v) ? v : d);
const dget = (d: any, k: string, def: unknown) => (has(d, k) ? d[k] : def);

export type Stats = { copied: number; resized: number; kept: number };

/** Maps source files to site paths and records what must be copied. */
export class Assets {
  base: string;
  out: string;
  files = new Map<string, string>(); // site rel path -> abs source
  cache = new Map<string, Record<string, any>>();
  stats: Stats = { copied: 0, resized: 0, kept: 0 };

  /** `ns` namespaces the copies (img/<ns>/..., files/<ns>/...) so several reviews can share one site. */
  constructor(base: string, out: string, public maxWidth: number | null, public tool: string | null, public ns = '') {
    this.base = realpath(base);
    this.out = realpath(out);
  }

  private dest(absSrc: string, kind: string): string {
    const rel = relpath(absSrc, this.base);
    if (rel.startsWith('..') || isabs(rel)) throw new ReviewError('asset must stay inside the review folder');
    const safe = rel.replace(/[^A-Za-z0-9._/-]/gu, '_');
    const folder = this.ns ? `${kind}/${this.ns}` : kind;
    let dest = `${folder}/${safe}`;
    const prev = this.files.get(dest);
    if (prev !== undefined && prev !== absSrc) {
      // Another source sanitised to the same name ("a b.png" vs "a_b.png"): keep both apart.
      const [stem, ext] = splitext(safe);
      dest = `${folder}/${stem}-${crypto.createHash('sha1').update(rel, 'utf8').digest('hex').slice(0, 8)}${ext}`;
    }
    return dest;
  }

  image(img: any, fmt: string): Record<string, any> {
    const src = model.imageSrc(img);
    const absSrc = safety.localSource(this.base, src, true);
    if (!this.cache.has(absSrc)) {
      const dest = this.dest(absSrc, 'img');
      this.files.set(dest, absSrc);
      const dim = images.size(absSrc);
      this.cache.set(absSrc, { src: `${dest}?v=${images.fingerprint(absSrc)}`, w: dim ? dim[0] : null, h: dim ? dim[1] : null });
    }
    const out: Record<string, any> = { ...this.cache.get(absSrc) };
    const isObj = typeof img === 'object' && img !== null;
    out.cap = markdown.toHtml(isObj ? dget(img, 'caption', '') : '', fmt);
    out.alt = isObj ? dget(img, 'alt', '') : '';
    return out;
  }

  link(href: string): string {
    if (safety.safeUrl(href) !== href) throw new ReviewError('unsafe link URL');
    if (!safety.isLocalLink(href)) return href;
    const absSrc = safety.localSource(this.base, href);
    if (!isfile(absSrc)) throw new ReviewError('local link target not found');
    const dest = this.dest(absSrc, 'files');
    this.files.set(dest, absSrc);
    return `${dest}?v=${images.fingerprint(absSrc)}`;
  }

  write(): void {
    this.publish();
    prune(this.out, this.files.keys());
  }

  /** Copy (or resize) every recorded file into the site. */
  publish(): void {
    for (const [dest, src] of this.files) {
      const target = join(this.out, dest);
      const mw = dest.startsWith('img/') ? this.maxWidth : null;
      this.stats[images.publish(src, target, mw, this.tool)] += 1;
    }
  }
}

/** Remove files under out/img and out/files that are not in `dests` (site-relative paths), then empty folders. */
function prune(out: string, dests: Iterable<string>): void {
  const keep = new Set([...dests].map((d) => normpath(join(out, d))));
  for (const folder of ['img', 'files']) {
    const root = join(out, folder);
    if (!isdir(root)) continue;
    for (const [dirpath, , filenames] of walk(root, false)) {
      for (const n of filenames) {
        const p = normpath(join(dirpath, n));
        if (!keep.has(p)) fs.unlinkSync(p);
      }
      if (dirpath !== root && !listdir(dirpath).length) fs.rmdirSync(dirpath);
    }
  }
}

function shape(list: any[]): string {
  const ratios = list.filter((i) => truthy(i.w) && truthy(i.h)).map((i) => i.h / i.w).sort((a, b) => a - b);
  if (!ratios.length) return 'landscape';
  return ratios[Math.floor(ratios.length / 2)] > 1.15 ? 'portrait' : 'landscape';
}

/** Turn a validated review.json into the structure the site's app.js reads. */
export function compileData(data: any, base: string, assets: Assets): Record<string, any> {
  const proj = data.project;
  const fmt = dget(proj, 'textFormat', 'markdown');
  const rich = (t: any) => markdown.toHtml(truthy(t) ? t : '', fmt);
  const plats = model.platforms(data);
  const platIds: any[] = plats.map((p: any) => p.id);
  const byPlatImgs = new Map<any, any[]>(platIds.map((p) => [p, []]));

  const img = (x: any, plat: any = null) => {
    const out = assets.image(x, fmt);
    if (byPlatImgs.has(plat)) byPlatImgs.get(plat)!.push(out);
    return out;
  };

  const areas = (get(data, 'areas') || []).map((a: any) => ({
    id: a.id, title: a.title, num: dget(a, 'num', ''), platform: get(a, 'platform') ?? null,
    desc: rich(get(a, 'description')),
    shots: (get(a, 'screenshots') || []).map((s: any) => img(s, get(a, 'platform') ?? null)),
  }));
  const fixesFor = new Map<any, any[]>();
  for (const fx of get(data, 'fixes') || []) {
    for (const i of get(fx, 'issues') || []) {
      if (!fixesFor.has(i)) fixesFor.set(i, []);
      fixesFor.get(i)!.push(fx.id);
    }
  }
  const issues = (get(data, 'issues') || []).map((it: any) => {
    const plat = or(get(it, 'platform'), platIds[0]);
    return {
      id: it.id, platform: plat, area: dget(it, 'area', ''), sev: get(it, 'severity') ?? null,
      status: dget(it, 'status', 'open'), title: it.title, html: rich(get(it, 'details')),
      note: rich(get(it, 'note')), where: rich(get(it, 'where')), date: dget(it, 'date', ''),
      top: truthy(get(it, 'top')), rank: get(it, 'rank') ?? null, counted: dget(it, 'counted', true),
      tags: or(get(it, 'tags'), []), shots: (get(it, 'screenshots') || []).map((s: any) => img(s, plat)),
      fixes: fixesFor.has(it.id) ? fixesFor.get(it.id) : [],
    };
  });
  const fixes = (get(data, 'fixes') || []).map((fx: any, n: number) => {
    const pdata: Record<string, any> = {};
    const fplats = or(get(fx, 'platforms'), {});
    for (const pid of Object.keys(fplats)) {
      const p = fplats[pid];
      const pairs = (get(p, 'pairs') || []).map((pr: any) => {
        const before = truthy(get(pr, 'before')) ? img(pr.before, pid) : null;
        const after = truthy(get(pr, 'after')) ? img(pr.after, pid) : null;
        return { before, after, cap: rich(get(pr, 'caption')) };
      });
      const desc = rich(get(p, 'description'));
      pdata[pid] = { desc, pairs, other: (get(p, 'images') || []).map((x: any) => img(x, pid)) };
    }
    const head = {
      id: fx.id, num: get(fx, 'number') ?? null, title: fx.title, date: dget(fx, 'date', ''),
      summary: rich(get(fx, 'summary')), files: or(get(fx, 'files'), []), commits: or(get(fx, 'commits'), []),
    };
    const links = (get(fx, 'links') || []).map((l: any) => ({ label: l.label, href: assets.link(l.href), kind: dget(l, 'kind', '') }));
    return { ...head, links, issues: or(get(fx, 'issues'), []), platforms: pdata, order: n };
  });
  const plan = (get(data, 'plan') || []).map((g: any) => {
    const items = (get(g, 'items') || []).map((it: any) => {
      let files = get(it, 'files');
      if (Array.isArray(files)) files = files.map((f) => (fmt === 'markdown' ? `\`${S(f)}\`` : `<code>${S(f)}</code>`)).join(', ');
      return {
        id: dget(it, 'id', ''), phase: dget(it, 'phase', ''), sev: get(it, 'severity') ?? null,
        title: markdown.toHtml(it.title, fmt), details: rich(get(it, 'details')),
        files: rich(files), effort: dget(it, 'effort', ''), status: dget(it, 'status', 'todo'),
        note: rich(get(it, 'note')), issues: or(get(it, 'issues'), []), fixes: or(get(it, 'fixes'), []),
      };
    });
    return { id: dget(g, 'id', ''), title: g.title, platform: get(g, 'platform') ?? null, intro: rich(get(g, 'intro')), items };
  });
  const appendix = (get(data, 'appendix') || []).map((a: any) => ({ title: a.title, platform: get(a, 'platform') ?? null, body: rich(a.body) }));
  const theme = or(get(proj, 'theme'), {});
  const outPlats = plats.map((p: any) => {
    let shp = dget(p, 'shape', 'auto');
    if (shp === 'auto') shp = shape(byPlatImgs.get(p.id)!);
    return { id: p.id, label: truthy(get(p, 'label')) ? p.label : capitalize(p.id), shape: shp, desc: dget(p, 'description', '') };
  });
  const generated = strftime('%d %b %Y %H:%M');
  const desc = rich(get(proj, 'description'));
  const projLinks = (get(proj, 'links') || []).map((l: any) => ({ label: l.label, href: assets.link(l.href), kind: dget(l, 'kind', '') }));
  return {
    kit: VERSION,
    generated,
    project: {
      name: proj.name, title: dget(proj, 'title', 'Review'), desc,
      date: dget(proj, 'date', ''), repo: dget(proj, 'repo', ''),
      links: projLinks,
      theme: {
        accent: dget(theme, 'accent', model.DEFAULT_ACCENT), accentDark: dget(theme, 'accentDark', ''),
        logoText: truthy(get(theme, 'logoText')) ? theme.logoText : pySlice(proj.name, 0, 1).toUpperCase(),
      },
    },
    platforms: outPlats,
    severities: model.severities(data).map((s: any) => ({
      id: s.id, label: truthy(get(s, 'label')) ? s.label : s.id, color: dget(s, 'color', '#6f7f83'),
      desc: dget(s, 'description', ''), cls: 'sv-' + cssIdent(s.id),
    })),
    statusLabels: STATUS_LABELS,
    planLabels: PLAN_LABELS,
    areas, issues, fixes, plan, appendix,
  };
}

function checkOut(out: string, base: string, reviewPath: string, force: boolean): void {
  const outAbs = realpath(out);
  if (outAbs === realpath(base) || realpath(reviewPath).startsWith(outAbs + '/')) {
    throw new ReviewError(`--out ${out} would overwrite the review sources; choose a separate folder (e.g. site/)`);
  }
  if (isdir(outAbs) && listdir(outAbs).length && !exists(join(outAbs, MARKER)) && !force) {
    throw new ReviewError(`${out} exists and was not created by review-kit; use --force to build into it anyway`);
  }
  if (islink(out)) throw new ReviewError('output directory must not be a symlink');
  const expected = new Set([MARKER, 'index.html', 'app.js', 'app.css', 'data.js']);
  for (const [root, dirs, files] of walk(outAbs)) {
    for (const name of [...dirs, ...files]) {
      const path = join(root, name);
      if (islink(path)) throw new ReviewError('output contains a symlink; choose a fresh output directory');
      const rel = relpath(path, outAbs);
      if (root === outAbs && expected.has(name) && files.includes(name)) continue;
      if (!['img', 'files'].includes(rel.split('/')[0])) {
        throw new ReviewError('output contains unexpected files; choose a fresh output directory');
      }
    }
  }
}

export interface BuildOptions {
  maxWidth?: number | null;
  force?: boolean;
  checkFiles?: boolean;
  quiet?: boolean;
  clean?: boolean;
}

function prepareOut(out: string, clean: boolean): void {
  if (clean && isdir(out)) {
    for (const folder of ['img', 'files']) {
      try {
        fs.rmSync(join(out, folder), { recursive: true, force: true });
      } catch {
        /* ignore_errors=True */
      }
    }
  }
  fs.mkdirSync(out, { recursive: true });
}

/** Write data.js, the page templates and the manifest. */
function writeSite(out: string, payload: string, title: string, accent: string, assetFiles: string[]): void {
  model.writeText(join(out, 'data.js'), payload); // atomic: `serve --watch` may be reading it
  let verSrc = payload;
  for (const name of ['index.html', 'app.css', 'app.js']) verSrc += readText(join(model.SITE_SRC, name));
  const ver = crypto.createHash('sha1').update(verSrc, 'utf8').digest('hex').slice(0, 10);
  for (const name of ['index.html', 'app.css', 'app.js']) {
    let s = readText(join(model.SITE_SRC, name)).split('__VER__').join(ver);
    if (name === 'index.html') s = s.split('__TITLE__').join(escape(title)).split('__ACCENT__').join(accent);
    model.writeText(join(out, name), s);
  }
  model.save(join(out, MARKER), { version: 1, files: ['index.html', 'app.css', 'app.js', 'data.js', ...sorted(assetFiles)] });
}

/** Counts for one compiled review, as build() returns them. */
function siteStats(site: Record<string, any>, assets: Assets): Record<string, any> {
  const counted = site.issues.filter((i: any) => truthy(i.counted));
  const stats: Record<string, any> = {
    issues: counted.length, summary_rows: site.issues.length - counted.length, fixes: site.fixes.length,
    pairs: site.fixes.reduce((n: number, fx: any) => n + Object.values(fx.platforms).reduce((m: number, p: any) => m + p.pairs.length, 0), 0),
    images: [...assets.files.keys()].filter((d) => d.startsWith('img/')).length,
    plan_items: site.plan.reduce((n: number, g: any) => n + g.items.length, 0),
    status: {} as Record<string, number>,
  };
  for (const i of counted) stats.status[i.status] = (stats.status[i.status] || 0) + 1;
  return stats;
}

function statsLine(stats: Record<string, any>, assets: Stats): string {
  const st = Object.keys(stats.status).sort(cmpStr).map((k) => `${stats.status[k]} ${k}`).join(', ');
  return `${stats.issues} issues (${st || 'none'}), ${stats.fixes} fixes with ${stats.pairs} before/after pairs, `
    + `${stats.plan_items} plan items, ${stats.images} images `
    + `(${assets.copied} copied, ${assets.resized} resized, ${assets.kept} unchanged)`;
}

/** Load and validate one review; throws on validation errors. Returns [data, base, warnings]. */
function loadValid(reviewPath: string, checkFiles: boolean, label = ''): [any, string, string[]] {
  const data = model.load(reviewPath);
  const base = model.baseDir(reviewPath);
  const [errors, warnings] = validate.validate(data, base, checkFiles);
  if (errors.length) throw new ReviewError(`${label ? reviewPath + ': ' : ''}validation failed:\n  ` + errors.join('\n  '));
  return [data, base, warnings];
}

/** Validate reviewPath and write the site to out. Returns a stats object. */
export function build(reviewPath: string, out: string, opts: BuildOptions = {}): Record<string, any> {
  const { maxWidth = null, force = false, checkFiles = true, quiet = false, clean = false } = opts;
  const [data, base, warnings] = loadValid(reviewPath, checkFiles);
  checkOut(out, base, reviewPath, force);
  prepareOut(out, clean);
  const tool = maxWidth ? images.resizer() : null;
  const assets = new Assets(base, abspath(out), maxWidth, tool);
  const site = compileData(data, base, assets);
  assets.write();
  const proj = site.project;
  writeSite(out, 'window.REVIEW = ' + dumps(site, null) + ';\n', strip(`${S(proj.name)} ${S(proj.title)}`),
    proj.theme.accent, [...assets.files.keys()]);
  const stats = siteStats(site, assets);
  Object.assign(stats, { warnings, assets: assets.stats, resizer: tool, out: abspath(out) });
  if (!quiet) {
    for (const w of warnings) print('warning:', w);
    print(statsLine(stats, assets.stats));
    if (maxWidth && !tool) print('note: no resize tool (sips/magick/convert) found; images copied at full size');
    print('site ->', join(stats.out, 'index.html'));
  }
  return stats;
}

// ---------------------------------------------------------------- several reviews in one site
/** Switch labels and order for the review kinds; other kinds sort after these, labelled by their title. */
export const KIND_ORDER = ['ui', 'backend'];
export const KIND_LABELS: Record<string, string> = { ui: 'UI/UX', backend: 'Backend' };
const RESERVED_KEYS = new Set(['', 'all', 'overview', 'fixes', 'issues', 'plan']);

export interface ReviewRef { path: string; key: string; label: string; kind: string; data: any; base: string; warnings: string[] }

/** Load and validate several reviews, order them (ui, then backend, then the rest) and give each a unique hash key. */
export function loadReviews(reviewPaths: string[], checkFiles = true): ReviewRef[] {
  const refs = reviewPaths.map((p) => {
    const [data, base, warnings] = loadValid(p, checkFiles, p);
    const kind = String(dget(data.project, 'kind', 'ui'));
    return { path: p, key: '', label: '', kind, data, base, warnings };
  });
  const rank = (k: string) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : KIND_ORDER.length);
  const order = refs.map((r, i) => [r, i] as [ReviewRef, number]).sort((a, b) => rank(a[0].kind) - rank(b[0].kind) || a[1] - b[1]);
  const keys = new Set<string>();
  const labels = new Set<string>();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '');
  const out = order.map(([r]) => {
    let key = slug(r.kind);
    if (keys.has(key) || RESERVED_KEYS.has(key)) key = slug(r.base.split('/').pop() || '') || 'review';
    for (let n = 2, k0 = key; keys.has(key) || RESERVED_KEYS.has(key); n++) key = `${k0}-${n}`;
    keys.add(key);
    let label = has(KIND_LABELS, r.kind) ? KIND_LABELS[r.kind] : S(dget(r.data.project, 'title', 'Review'));
    if (labels.has(label)) label = S(dget(r.data.project, 'title', '')) || key;
    labels.add(label);
    return { ...r, key, label };
  });
  return out;
}

/** Validate several reviews and write ONE site (window.REVIEWS) to out, assets namespaced per review. */
export function buildCombined(reviewPaths: string[], out: string, opts: BuildOptions = {}): Record<string, any> {
  const { maxWidth = null, force = false, checkFiles = true, quiet = false, clean = false } = opts;
  if (reviewPaths.length < 2) throw new ReviewError('a combined site needs at least two reviews');
  const refs = loadReviews(reviewPaths, checkFiles);
  for (const r of refs) checkOut(out, r.base, r.path, force);
  prepareOut(out, clean);
  const tool = maxWidth ? images.resizer() : null;
  const compiled = refs.map((r) => {
    const assets = new Assets(r.base, abspath(out), maxWidth, tool, r.key);
    return { r, assets, site: compileData(r.data, r.base, assets) };
  });
  const dests: string[] = [];
  for (const c of compiled) {
    c.assets.publish();
    dests.push(...c.assets.files.keys());
  }
  prune(abspath(out), dests);
  const reviews = compiled.map((c) => ({ key: c.r.key, label: c.r.label, data: c.site }));
  const names = [...new Set(compiled.map((c) => strip(S(c.site.project.name))))];
  const title = names.length === 1 ? `${names[0]} reviews` : 'Reviews';
  writeSite(out, 'window.REVIEWS = ' + dumps(reviews, null) + ';\n', title, compiled[0].site.project.theme.accent, dests);
  const per = compiled.map((c) => ({
    key: c.r.key, label: c.r.label, path: c.r.path, ...siteStats(c.site, c.assets), warnings: c.r.warnings, assets: c.assets.stats,
  }));
  const stats: Record<string, any> = { reviews: per, resizer: tool, out: abspath(out) };
  if (!quiet) {
    for (const p of per) {
      for (const w of p.warnings) print(`warning: ${p.label}:`, w);
      print(`${p.label}: ${statsLine(p, p.assets)}`);
    }
    if (maxWidth && !tool) print('note: no resize tool (sips/magick/convert) found; images copied at full size');
    print('site ->', join(stats.out, 'index.html'));
  }
  return stats;
}

/** build() for one review, buildCombined() for several. */
export function buildAny(reviewPaths: string | string[], out: string, opts: BuildOptions = {}): Record<string, any> {
  const paths = typeof reviewPaths === 'string' ? [reviewPaths] : reviewPaths;
  return paths.length === 1 ? build(paths[0], out, opts) : buildCombined(paths, out, opts);
}
