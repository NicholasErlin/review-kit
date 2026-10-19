/** Commands that edit research, ideas and design proposals: add-research, add-idea, decide, add-proposal, recommend. */
import { appendNote, slug } from './edit.js';
import { ReviewError } from './errors.js';
import * as model from './model.js';
import { copyDict, get, has, isDict, pyEq, setKey, today, truthy } from './py.js';

const S = model.s;

function setdefault(d: Record<string, any>, k: string, v: unknown): any {
  if (!has(d, k)) setKey(d, k, v);
  return d[k];
}

function nextId(prefix: string, items: any[]): string {
  const ids = new Set(items.map((i) => get(i, 'id')));
  let n = items.length + 1;
  while (ids.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/** Insert or (update=true) merge an entry keyed by id. `mergeKey` decides how a field of an update is combined. */
function upsert(list: any[], item: Record<string, any>, what: string, update: boolean,
  mergeKey: (k: string, old: any, add: any) => any = (_k, _old, add) => add): Record<string, any> {
  for (let i = 0; i < list.length; i++) {
    if (pyEq(get(list[i], 'id'), item.id)) {
      if (!update) throw new ReviewError(`${what} "${S(item.id)}" already exists (use --update to merge fields)`);
      const merged = copyDict(list[i]);
      for (const k of Object.keys(item)) setKey(merged, k, has(merged, k) ? mergeKey(k, merged[k], item[k]) : item[k]);
      list[i] = merged;
      return merged;
    }
  }
  if (update) throw new ReviewError(`--update: no ${what} with id "${S(item.id)}"`);
  list.push(item);
  return item;
}

// ---------------------------------------------------------------- research
/** "Label=URL" like add-fix --link (split at the first "="), or a bare URL. */
export function parseSource(arg: string): { label: string; href: string } {
  const i = arg.indexOf('=');
  const label = i < 0 ? '' : arg.slice(0, i).trim();
  const href = (i < 0 ? arg : arg.slice(i + 1)).trim();
  if (!href) throw new ReviewError(`--source ${JSON.stringify(arg)}: expected "Label=URL"`);
  return { label: label || href, href };
}

export function upsertResearch(data: Record<string, any>, entry: Record<string, any>, update = false): Record<string, any> {
  const list: any[] = setdefault(data, 'research', []);
  entry = copyDict(entry);
  if (!truthy(get(entry, 'id'))) {
    if (update) throw new ReviewError('--update needs --id');
    entry.id = nextId('r', list);
  }
  if (!update) {
    if (!truthy(get(entry, 'title'))) throw new ReviewError('a research entry needs a title');
    setdefault(entry, 'date', today());
  }
  // Sources given with --update are added to the existing ones (same href: replaced).
  return upsert(list, entry, 'research entry', update, (k, old, add) => {
    if (k !== 'sources' || !Array.isArray(old) || !Array.isArray(add)) return add;
    const out = old.filter((s: any) => !add.some((a: any) => a.href === get(s, 'href')));
    return [...out, ...add];
  });
}

// ---------------------------------------------------------------- ideas
export function upsertIdea(data: Record<string, any>, idea: Record<string, any>, update = false): Record<string, any> {
  const list: any[] = setdefault(data, 'ideas', []);
  idea = copyDict(idea);
  if (!truthy(get(idea, 'id'))) {
    if (update) throw new ReviewError('--update needs --id');
    idea.id = nextId('i', list);
  }
  if (!update) {
    if (!truthy(get(idea, 'title'))) throw new ReviewError('an idea needs a title');
    setdefault(idea, 'status', 'proposed');
    setdefault(idea, 'date', today());
  }
  return upsert(list, idea, 'idea', update);
}

/** decide <idea> <status> [--note]: the user's call on an idea. */
export function decide(data: any, ideaId: string, status: string, note = ''): string {
  if (!model.IDEA_STATUSES.includes(status)) {
    throw new ReviewError(`decide: status must be one of ${model.IDEA_STATUSES.join(', ')}`);
  }
  const idea = (get(data, 'ideas') || []).find((i: any) => pyEq(i.id, ideaId));
  if (!idea) throw new ReviewError(`decide: no idea with id "${ideaId}"`);
  idea.status = status;
  if (note) idea.decision = appendNote(get(idea, 'decision') || '', note);
  return `idea ${S(idea.id)} -> ${status}`;
}

// ---------------------------------------------------------------- proposals
export function checkRefId(id: unknown, what: string): string {
  if (typeof id !== 'string' || !model.REF_ID.test(id)) {
    throw new ReviewError(`${what} id ${JSON.stringify(id)} is not allowed: use lower-case letters, digits and "-" `
      + '(up to 41 characters, starting with a letter or digit); it becomes part of a git branch name');
  }
  return id;
}

/** "id=Label:weight", "id=Label", "Label:weight" or "Label" (the id is then derived from the label). */
export function parseCriterion(arg: string): Record<string, any> {
  let rest = arg.trim();
  let weight: number | null = null;
  const w = /:\s*(\d+)\s*$/.exec(rest);
  if (w) {
    weight = Number(w[1]);
    rest = rest.slice(0, w.index).trim();
    if (!Number.isInteger(weight) || weight < 1 || weight > 5) throw new ReviewError(`--criterion ${JSON.stringify(arg)}: weight must be 1 to 5`);
  }
  const eq = rest.indexOf('=');
  let id = eq >= 0 ? rest.slice(0, eq).trim() : '';
  const label = (eq >= 0 ? rest.slice(eq + 1) : rest).trim();
  if (!label) throw new ReviewError(`--criterion ${JSON.stringify(arg)}: expected "id=Label:weight"`);
  if (!id) id = slug(label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new ReviewError(`--criterion ${JSON.stringify(arg)}: invalid id "${id}"`);
  const c: Record<string, any> = { id, label };
  if (weight !== null) c.weight = weight;
  return c;
}

export function findProposal(data: any, id: string): any {
  const pr = (get(data, 'proposals') || []).find((p: any) => pyEq(get(p, 'id'), id));
  if (!pr) throw new ReviewError(`no proposal with id "${id}" (create it with \`review-kit add-proposal --id ${id} ...\`)`);
  return pr;
}

export function findOption(pr: any, id: string): any {
  const o = (get(pr, 'options') || []).find((x: any) => pyEq(get(x, 'id'), id));
  if (!o) {
    throw new ReviewError(`proposal "${S(pr.id)}" has no option "${id}" (start one with \`review-kit option new ${S(pr.id)} ${id} --title ...\`)`);
  }
  return o;
}

export function upsertProposal(data: Record<string, any>, proposal: Record<string, any>, update = false): Record<string, any> {
  const list: any[] = setdefault(data, 'proposals', []);
  proposal = copyDict(proposal);
  checkRefId(get(proposal, 'id'), 'proposal');
  if (!update) {
    if (!truthy(get(proposal, 'title'))) throw new ReviewError('a proposal needs a title');
    setdefault(proposal, 'status', 'open');
    setdefault(proposal, 'date', today());
    setdefault(proposal, 'criteria', []);
    setdefault(proposal, 'options', []);
  }
  // Criteria given with --update replace those with the same id and add the rest.
  return upsert(list, proposal, 'proposal', update, (k, old, add) => {
    if (k !== 'criteria' || !Array.isArray(old) || !Array.isArray(add)) return add;
    const out = old.map((c: any) => add.find((a: any) => a.id === get(c, 'id')) || c);
    return [...out, ...add.filter((a: any) => !old.some((c: any) => get(c, 'id') === a.id))];
  });
}

export function recommend(data: any, proposalId: string, optionId: string, reasoning: string): string {
  const pr = findProposal(data, proposalId);
  findOption(pr, optionId);
  if (!reasoning.trim()) throw new ReviewError('recommend: --reasoning is required (why it wins, and when another option would)');
  pr.recommendation = { option: optionId, reasoning };
  return `proposal ${S(pr.id)}: recommends ${optionId}`;
}

/** "crit=N" or "crit=N:note" for `option record --score`. */
export function parseScore(arg: string, criteria: any[]): [string, Record<string, any>] {
  const m = /^([^=]+)=\s*(\d+)\s*(?::([\s\S]*))?$/.exec(arg);
  if (!m) throw new ReviewError(`--score ${JSON.stringify(arg)}: expected "criterion=N" or "criterion=N:note" (N is 1 to 5)`);
  const id = m[1].trim();
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new ReviewError(`--score ${JSON.stringify(arg)}: the score must be a whole number from 1 to 5`);
  if (!criteria.some((c) => get(c, 'id') === id)) {
    const known = criteria.map((c) => S(get(c, 'id')));
    throw new ReviewError(`--score: unknown criterion "${id}" (known: ${known.length ? known.join(', ') : 'none; add them with add-proposal --update --criterion'})`);
  }
  const sc: Record<string, any> = { score: n };
  if (m[3] !== undefined && m[3].trim()) sc.note = m[3].trim();
  return [id, sc];
}

/** Add a proposal id to an idea's `proposals` (when the idea exists in `data`). Returns true when it changed. */
export function linkIdea(data: any, ideaId: string, proposalId: string): boolean {
  const idea = (get(data, 'ideas') || []).find((i: any) => isDict(i) && pyEq(i.id, ideaId));
  if (!idea) return false;
  const props: any[] = setdefault(idea, 'proposals', []);
  if (props.includes(proposalId)) return false;
  props.push(proposalId);
  return true;
}
