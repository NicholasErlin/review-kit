/** Build the static review site from review.json. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { ReviewError } from './errors.js';
import { escape } from './htmlparser.js';
import * as images from './images.js';
import { print } from './io.js';
import * as markdown from './markdown.js';
import * as model from './model.js';
import * as prs from './prs.js';
import { dumps } from './pyjson.js';
import {
  abspath, capitalize, cmpStr, dirname, exists, get, has, isabs, isdir, isfile, islink, join, listdir, normpath, pySlice,
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
export const IDEA_LABELS = { proposed: 'Proposed', go: 'Go', maybe: 'Maybe', no: 'No', done: 'Done' };
export const PROPOSAL_LABELS = { open: 'Open', adopted: 'Adopted', closed: 'Closed' };
export const OPTION_LABELS = { proposed: 'Proposed', adopted: 'Adopted', rejected: 'Rejected' };

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
  generated = new Map<string, Buffer>(); // site rel path -> content written by the build (PR diff scripts)
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

  /**
   * A PR diff: the raw file is published with the same size cap (a "raw diff" link), plus a small script that registers its text in
   * window.REVIEW_DIFFS[key], so the page can load it with a <script> tag (no fetch: the CSP blocks connections).
   */
  diff(rel: string, cap: number): Record<string, any> | null {
    const absSrc = safety.localSource(this.base, rel);
    if (!isfile(absSrc)) return null;
    const dest = this.dest(absSrc, 'files');
    this.files.set(dest, absSrc);
    let buf = fs.readFileSync(absSrc);
    let truncated = false;
    if (buf.length > cap) {
      const nl = buf.subarray(0, cap).lastIndexOf(0x0a);
      buf = buf.subarray(0, nl > 0 ? nl + 1 : cap);
      truncated = true;
    }
    this.generated.set(dest, buf); // cap the downloadable patch too, including hand-edited input
    const v = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
    const js = `${dest}.js`;
    const text = JSON.stringify(buf.toString('utf8')).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    this.generated.set(js, Buffer.from(`(window.REVIEW_DIFFS = window.REVIEW_DIFFS || {})[${JSON.stringify(dest)}] = ${text};\n`, 'utf8'));
    return { src: `${js}?v=${v}`, key: dest, raw: `${dest}?v=${v}`, bytes: buf.length, truncated };
  }

  /** Every site path this review publishes. */
  dests(): string[] {
    return [...new Set([...this.files.keys(), ...this.generated.keys()])];
  }

  write(): void {
    this.publish();
    prune(this.out, this.dests());
  }

  /** Copy (or resize) every recorded file into the site. */
  publish(): void {
    for (const [dest, buf] of this.generated) {
      const target = join(this.out, dest);
      if (isfile(target) && fs.readFileSync(target).equals(buf)) {
        this.stats.kept += 1;
        continue;
      }
      fs.mkdirSync(dirname(target), { recursive: true });
      model.writeText(target, buf);
      this.stats.copied += 1;
    }
    for (const [dest, src] of this.files) {
      if (this.generated.has(dest)) continue;
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
  const { research, ideas, proposals } = compileIdeas(data, base, assets, fmt, img);
  const prList = compilePrs(data, base, assets, rich);
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
      name: proj.name, title: dget(proj, 'title', 'Review'), kind: dget(proj, 'kind', 'ui'), desc,
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
    ideaStatusLabels: IDEA_LABELS,
    proposalStatusLabels: PROPOSAL_LABELS,
    optionStatusLabels: OPTION_LABELS,
    areas, issues, fixes, plan, appendix, research, ideas, proposals,
    prs: prList, prGroups: { mine: prs.MINE_GROUPS, reviewing: prs.REVIEWING_GROUPS }, prGroupLabels: prs.GROUP_LABELS,
  };
}

/** The PR dashboard's PRs in board order (see prs.compilePr for the shape). */
function compilePrs(data: any, base: string, assets: Assets, rich: (t: any) => string): any[] {
  const list = prs.prList(data);
  if (!list.length) return [];
  const st = prs.statuses(data);
  return prs.boardOrder(data, st).map((p) => prs.compilePr(p, st.get(p.id)!, rich, (rel) => assets.diff(rel, prs.PR_DIFF_CAP), base));
}

/** Weighted total of an option's scores, normalised to 0-100 (a missing score counts as 0); null without criteria. */
export function weightedTotal(criteria: any[], scores: Record<string, any>): number | null {
  let got = 0;
  let max = 0;
  for (const c of criteria) {
    const w = dget(c, 'weight', 1);
    max += 5 * w;
    const sc = get(scores, c.id);
    if (sc && typeof sc.score === 'number') got += w * sc.score;
  }
  return max ? Math.round((100 * got) / max) : null;
}

/** The diff snapshot as text (capped like `option record`, so a hand-made patch cannot bloat data.js). */
function diffText(base: string, path: string): [string, boolean] {
  const buf = fs.readFileSync(safety.localSource(base, path));
  if (buf.length <= model.DIFF_CAP) return [buf.toString('utf8'), false];
  let cut = buf.subarray(0, model.DIFF_CAP);
  const nl = cut.lastIndexOf(0x0a);
  if (nl > 0) cut = cut.subarray(0, nl + 1);
  return [cut.toString('utf8'), true];
}

/** research, ideas and proposals in the shape app.js reads (rich text rendered; no worktree or absolute paths). */
function compileIdeas(data: any, base: string, assets: Assets, fmt: string, img: (x: any, plat?: any) => any) {
  const rich = (t: any) => markdown.toHtml(truthy(t) ? t : '', fmt);
  const list = (v: any) => (Array.isArray(v) ? v.map((x: any) => rich(x)) : []);
  const ideasIn: any[] = get(data, 'ideas') || [];
  const citedBy = new Map<any, any[]>();
  for (const it of ideasIn) {
    for (const r of get(it, 'evidence') || []) {
      if (!citedBy.has(r)) citedBy.set(r, []);
      if (!citedBy.get(r)!.includes(it.id)) citedBy.get(r)!.push(it.id);
    }
  }
  const research = (get(data, 'research') || []).map((r: any) => ({
    id: r.id, title: r.title, html: rich(get(r, 'summary')),
    sources: (get(r, 'sources') || []).map((x: any) => ({
      label: x.label, href: assets.link(x.href), accessed: dget(x, 'accessed', ''), quote: dget(x, 'quote', ''),
      kind: dget(x, 'kind', ''),
    })),
    confidence: get(r, 'confidence') ?? null, tags: or(get(r, 'tags'), []), date: dget(r, 'date', ''),
    ideas: citedBy.get(r.id) || [],
  }));
  const ideas = ideasIn.map((it: any) => ({
    id: it.id, title: it.title, status: dget(it, 'status', 'proposed'),
    problem: rich(get(it, 'problem')), proposal: rich(get(it, 'proposal')), reasoning: rich(get(it, 'reasoning')),
    alternatives: rich(get(it, 'alternatives')), risks: rich(get(it, 'risks')), decision: rich(get(it, 'decision')),
    pros: list(get(it, 'pros')), cons: list(get(it, 'cons')),
    effort: get(it, 'effort') ?? null, impact: get(it, 'impact') ?? null, confidence: get(it, 'confidence') ?? null,
    evidence: or(get(it, 'evidence'), []), proposals: or(get(it, 'proposals'), []), tags: or(get(it, 'tags'), []),
    date: dget(it, 'date', ''), rank: get(it, 'rank') ?? null,
  }));
  const proposals = (get(data, 'proposals') || []).map((pr: any) => {
    const criteria: any[] = get(pr, 'criteria') || [];
    const rec = get(pr, 'recommendation');
    const adopted = get(pr, 'adopted');
    const options = (get(pr, 'options') || []).map((o: any) => {
      const scores: Record<string, any> = {};
      const raw = or(get(o, 'scores'), {});
      for (const c of Object.keys(raw)) scores[c] = { score: raw[c].score, note: rich(get(raw[c], 'note')) };
      const d = get(o, 'diff');
      let diff = null;
      if (d) {
        const [text, cut] = diffText(base, d.path);
        diff = {
          text, truncated: cut || get(d, 'truncated') === true,
          files: (get(d, 'files') || []).map((f: any) => ({ path: f.path, add: dget(f, 'add', 0), del: dget(f, 'del', 0), binary: get(f, 'binary') === true })),
          insertions: dget(d, 'insertions', 0), deletions: dget(d, 'deletions', 0),
        };
      }
      const pdata: Record<string, any> = {};
      const oplats = or(get(o, 'platforms'), {});
      for (const pid of Object.keys(oplats)) {
        pdata[pid] = { desc: rich(get(oplats[pid], 'description')), images: (get(oplats[pid], 'images') || []).map((x: any) => img(x, pid)) };
      }
      return {
        id: o.id, title: o.title, status: dget(o, 'status', 'proposed'),
        summary: rich(get(o, 'summary')), reasoning: rich(get(o, 'reasoning')), evidence: rich(get(o, 'evidence')),
        pros: list(get(o, 'pros')), cons: list(get(o, 'cons')),
        scores, total: weightedTotal(criteria, raw),
        branch: dget(o, 'branch', ''), base: dget(o, 'base', ''), head: dget(o, 'head', ''), gone: get(o, 'gone') === true,
        diff, platforms: pdata,
      };
    });
    return {
      id: pr.id, title: pr.title, status: dget(pr, 'status', 'open'), brief: rich(get(pr, 'brief')),
      idea: dget(pr, 'idea', ''), date: dget(pr, 'date', ''), decision: rich(get(pr, 'decision')),
      criteria: criteria.map((c: any) => ({ id: c.id, label: c.label, weight: dget(c, 'weight', 1), desc: dget(c, 'description', '') })),
      recommendation: rec ? { option: rec.option, html: rich(get(rec, 'reasoning')) } : null,
      adopted: adopted ? { option: adopted.option, commit: dget(adopted, 'commit', ''), date: dget(adopted, 'date', '') } : null,
      options,
    };
  });
  return { research, ideas, proposals };
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
    research: site.research.length, ideas: site.ideas.length, proposals: site.proposals.length,
    options: site.proposals.reduce((n: number, p: any) => n + p.options.length, 0),
    prs: site.prs.length,
  };
  for (const i of counted) stats.status[i.status] = (stats.status[i.status] || 0) + 1;
  return stats;
}

function statsLine(stats: Record<string, any>, assets: Stats): string {
  const st = Object.keys(stats.status).sort(cmpStr).map((k) => `${stats.status[k]} ${k}`).join(', ');
  const extra = [[stats.prs, 'PRs'], [stats.research, 'research entries'], [stats.ideas, 'ideas'], [stats.proposals, 'proposals'], [stats.options, 'options']]
    .filter(([n]) => n).map(([n, what]) => `${n} ${what}, `).join('');
  const head = extra && !stats.issues && !stats.fixes ? '' // an ideas or design review: no empty issue counts
    : `${stats.issues} issues (${st || 'none'}), ${stats.fixes} fixes with ${stats.pairs} before/after pairs, `;
  return `${head}${stats.plan_items} plan items, ${extra}${stats.images} images `
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
    proj.theme.accent, assets.dests());
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
export const KIND_ORDER = ['prs', 'ideas', 'design', 'ui', 'backend'];
export const KIND_LABELS: Record<string, string> = { prs: 'PRs', ideas: 'Ideas', design: 'Designs', ui: 'UI/UX', backend: 'Backend' };
// View names a review key must not shadow in combined-site hashes. "ideas" is a view too, but the ideas review
// keeps that key (its links are #/ideas/ideas/<id>).
const RESERVED_KEYS = new Set(['', 'all', 'overview', 'fixes', 'issues', 'plan', 'research', 'proposals', 'board', 'pr']);

export interface ReviewRef { path: string; key: string; label: string; kind: string; data: any; base: string; warnings: string[] }

/** Load and validate several reviews, order them (prs, ideas, design, ui, backend, then the rest) and give each a unique hash key. */
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
    dests.push(...c.assets.dests());
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
