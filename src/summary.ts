/** Plain-text / Markdown progress summary of a review.json (for status updates and hand-off messages). */
import * as model from './model.js';
import { cmpStr, get, has, strip, truthy, WS } from './py.js';

export const RESOLVED = ['fixed', 'notabug', 'wontfix'];
const S = model.s;

function plain(s: any): string {
  return strip((truthy(s) ? s : '').replace(/<[^>]+>|[*`~]/g, '').replace(new RegExp(`[${WS}]+`, 'g'), ' '));
}

/** Python's round(): halves go to the even neighbour. */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function summarise(data: any, openLimit = 8, markdown = true): string {
  const plats = model.platforms(data);
  const sevs = model.severities(data);
  const plLabel = new Map<any, any>(plats.map((p: any) => [p.id, truthy(get(p, 'label')) ? p.label : p.id]));
  const issues = (get(data, 'issues') || []).filter((i: any) => truthy(has(i, 'counted') ? i.counted : true));
  const fixes: any[] = get(data, 'fixes') || [];
  const b = markdown ? '**' : '';
  const lines: string[] = [];
  const name = data.project.name + ' ' + (has(data.project, 'title') ? data.project.title : 'Review');
  lines.push((markdown ? '# ' : '') + name);

  const status = (i: any) => (has(i, 'status') ? i.status : 'open');
  const counts = (lst: any[]) => {
    const c: Record<string, number> = {};
    for (const s of model.ISSUE_STATUSES) c[s] = 0;
    for (const i of lst) {
      if (!(status(i) in c)) throw new Error(`KeyError: ${S(status(i))}`);
      c[status(i)] += 1;
    }
    return c;
  };

  const research: any[] = get(data, 'research') || [];
  const ideas: any[] = get(data, 'ideas') || [];
  const proposals: any[] = get(data, 'proposals') || [];
  const ideasPart = ideasSummary(research, ideas, proposals, b);
  if (ideasPart.length && !issues.length && !fixes.length) { // an ideas or design review: skip the empty issue lines
    lines.push(...ideasPart, ...planLines(data, b));
    return lines.join('\n');
  }

  const c = counts(issues);
  const done = RESOLVED.reduce((n, s) => n + c[s], 0);
  const pct = issues.length ? pyRound((100 * (done + c.partial / 2)) / issues.length) : 0;
  lines.push(`${b}Issues:${b} ${issues.length} total, ${c.fixed} fixed, ${c.partial} partly fixed, ${c.open} open`
    + (c.notabug ? `, ${c.notabug} not a bug` : '') + (c.wontfix ? `, ${c.wontfix} won't fix` : '')
    + ` (${pct}% done)`);
  let rows: string[] = [];
  for (const s of [...sevs, { id: null, label: 'unranked' }]) {
    const lst = issues.filter((i: any) => (get(i, 'severity') ?? null) === s.id);
    if (lst.length) {
      const cc = counts(lst);
      rows.push(`${S(truthy(get(s, 'label')) ? s.label : s.id)}: ${RESOLVED.reduce((n, x) => n + cc[x], 0)}/${lst.length} resolved, ${cc.partial} partial, ${cc.open} open`);
    }
  }
  if (rows.length) lines.push(`${b}By severity:${b} ` + rows.join('; '));
  if (plats.length > 1) {
    rows = [];
    for (const p of plats) {
      const lst = issues.filter((i: any) => (truthy(get(i, 'platform')) ? i.platform : plats[0].id) === p.id);
      const cc = counts(lst);
      rows.push(`${S(plLabel.get(p.id))}: ${RESOLVED.reduce((n, x) => n + cc[x], 0)}/${lst.length} resolved`);
    }
    lines.push(`${b}By platform:${b} ` + rows.join('; '));
  }
  let pairs = 0;
  for (const f of fixes) for (const p of Object.values(get(f, 'platforms') || {}) as any[]) pairs += (get(p, 'pairs') || []).length;
  lines.push(`${b}Fixes:${b} ${fixes.length} shipped, ${pairs} before/after comparisons`);
  for (const f of fixes.slice(-5).reverse()) {
    const num = get(f, 'number') !== undefined && f.number !== null ? `#${S(f.number)} ` : '';
    lines.push(`- ${num}${S(f.title)}` + (truthy(get(f, 'date')) ? ` (${S(f.date)})` : '')
      + (truthy(get(f, 'issues')) ? ` addresses ${f.issues.join(', ')}` : ''));
  }
  const sevRank = new Map<any, number>();
  sevs.forEach((s: any, n: number) => sevRank.set(s.id, n));
  const left = issues.filter((i: any) => ['open', 'partial'].includes(status(i)))
    .map((i: any, n: number) => ({ i, n, k: [sevRank.has(get(i, 'severity') ?? null) ? sevRank.get(get(i, 'severity') ?? null)! : 99, get(i, 'status') !== 'partial' ? 1 : 0] }))
    .sort((x: any, y: any) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.n - y.n)
    .map((x: any) => x.i);
  if (left.length) {
    lines.push(`${b}Left to do (${left.length}), most severe first:${b}`);
    for (const i of left.slice(0, openLimit)) {
      const sev = truthy(get(i, 'severity')) ? i.severity : 'unranked';
      const plat = plats.length > 1 && truthy(get(i, 'platform'))
        ? ` [${S(plLabel.has(i.platform) ? plLabel.get(i.platform) : i.platform)}]` : '';
      lines.push(`- ${S(sev)} ${S(i.id)}${plat}: ${plain(i.title)}` + (get(i, 'status') === 'partial' ? ' (partly fixed)' : ''));
    }
    if (left.length > openLimit) lines.push(`- ... and ${left.length - openLimit} more`);
  }
  lines.push(...planLines(data, b));
  lines.push(...ideasPart);
  return lines.join('\n');
}

function planLines(data: any, b: string): string[] {
  const out: string[] = [];
  const items: any[] = [];
  for (const g of get(data, 'plan') || []) items.push(...(get(g, 'items') || []));
  if (items.length) {
    const pc = new Map<string, number>();
    for (const it of items) {
      const st = has(it, 'status') ? it.status : 'todo';
      pc.set(st, (pc.get(st) || 0) + 1);
    }
    out.push(`${b}Plan:${b} ${items.length} items: ` + [...pc.keys()].sort(cmpStr).map((k) => `${pc.get(k)} ${k}`).join(', '));
  }
  return out;
}

const SIZE_RANK: Record<string, number> = { L: 0, M: 1, S: 2 };

/** Lines about research, ideas and proposals (none when the review has none). */
function ideasSummary(research: any[], ideas: any[], proposals: any[], b: string): string[] {
  const lines: string[] = [];
  if (research.length) {
    const unsourced = research.filter((r) => !(get(r, 'sources') || []).length).length;
    const sources = research.reduce((n, r) => n + (get(r, 'sources') || []).length, 0);
    lines.push(`${b}Research:${b} ${research.length} findings, ${sources} sources` + (unsourced ? ` (${unsourced} without a source)` : ''));
  }
  if (ideas.length) {
    const st = (i: any) => (has(i, 'status') ? i.status : 'proposed');
    const parts = model.IDEA_STATUSES.map((x) => [x, ideas.filter((i) => st(i) === x).length] as [string, number])
      .filter(([, n]) => n).map(([x, n]) => `${n} ${x}`);
    lines.push(`${b}Ideas:${b} ${ideas.length} total, ${parts.join(', ')}`);
    const top = ideas.map((i, n) => ({ i, n })).filter(({ i }) => st(i) !== 'no')
      .sort((x, y) => (SIZE_RANK[get(x.i, 'impact')] ?? 3) - (SIZE_RANK[get(y.i, 'impact')] ?? 3)
        || (get(x.i, 'rank') ?? 1e9) - (get(y.i, 'rank') ?? 1e9) || x.n - y.n)
      .slice(0, 5);
    if (top.length) {
      lines.push(`${b}Top ideas by impact:${b}`);
      for (const { i } of top) {
        const size = ['impact', 'effort'].filter((k) => truthy(get(i, k))).map((k) => `${k} ${S(i[k])}`).join(', ');
        lines.push(`- ${S(i.id)} [${st(i)}${size ? ', ' + size : ''}]: ${plain(i.title)}`);
      }
    }
  }
  if (proposals.length) {
    lines.push(`${b}Proposals:${b} ${proposals.length}`);
    for (const p of proposals) {
      const opts: any[] = get(p, 'options') || [];
      const rec = get(p, 'recommendation');
      const ad = get(p, 'adopted');
      let state = has(p, 'status') ? p.status : 'open';
      if (ad) state = `adopted ${S(ad.option)}` + (truthy(get(ad, 'commit')) ? ` in ${S(ad.commit).slice(0, 7)}` : ' (not committed)');
      lines.push(`- ${S(p.id)}: ${plain(p.title)} [${state}] ${opts.length} option(s)`
        + (opts.length ? ` (${opts.map((o) => S(o.id)).join(', ')})` : '')
        + (rec ? `; recommends ${S(rec.option)}` : ''));
    }
  }
  return lines;
}
