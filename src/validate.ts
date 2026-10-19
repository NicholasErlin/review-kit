/**
 * Validation: a small JSON Schema interpreter (the subset review.schema.json uses) plus cross-reference checks.
 *
 * Supported keywords: type, enum, const, required, properties, additionalProperties, items,
 * minItems, minLength, maxLength, pattern, minimum, oneOf, anyOf, $ref (local #/$defs/...).
 * Unknown keywords (description, default, title, ...) are ignored.
 */
import { ReviewError } from './errors.js';
import * as model from './model.js';
import { get, has, isDict, isInt, isfile, numStr, pyEq, pyLen, pySlice, repr, str, truthy, typeName } from './py.js';
import * as safety from './safety.js';

const TYPES: Record<string, (v: unknown) => boolean> = {
  object: (v) => isDict(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  integer: (v) => isInt(v),
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

const patterns = new Map<string, RegExp>();

/** JSON Schema patterns are ECMA-262 regular expressions: compile them as such (`$` is the very end). */
function pattern(p: string): RegExp {
  let re = patterns.get(p);
  if (!re) {
    re = new RegExp(p, 'u');
    patterns.set(p, re);
  }
  return re;
}

const P = (p: string) => p || '(root)';

export class SchemaValidator {
  constructor(public root: any) {}

  resolve(ref: string): any {
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
    let node = this.root;
    for (const part of ref.slice(2).split('/')) node = node[part];
    return node;
  }

  errors(value: unknown, schema?: any, path = ''): string[] {
    const out: string[] = [];
    this.check(value, schema === undefined || schema === null ? this.root : schema, path, out);
    return out;
  }

  private check(v: any, s: any, path: string, out: string[]): void {
    if (has(s, '$ref')) this.check(v, this.resolve(s.$ref), path, out);
    if (has(s, 'type')) {
      const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => TYPES[t](v))) {
        out.push(`${P(path)}: expected ${types.join(' or ')}, got ${typeName(v)}`);
        return;
      }
    }
    if (has(s, 'const') && !pyEq(v, s.const)) out.push(`${P(path)}: must be ${repr(s.const)}`);
    if (has(s, 'enum') && !s.enum.some((x: unknown) => pyEq(v, x))) {
      out.push(`${P(path)}: ${repr(v)} is not one of ${s.enum.map(str).join(', ')}`);
    }
    if (typeof v === 'string') {
      if (has(s, 'minLength') && pyLen(v) < s.minLength) {
        out.push(s.minLength === 1 ? `${P(path)}: must not be empty` : `${P(path)}: shorter than ${numStr(s.minLength)}`);
      }
      if (has(s, 'maxLength') && pyLen(v) > s.maxLength) out.push(`${P(path)}: longer than ${numStr(s.maxLength)} characters`);
      if (has(s, 'pattern') && !pattern(s.pattern).test(v)) out.push(`${P(path)}: ${repr(v)} does not match ${s.pattern}`);
    }
    if (TYPES.number(v) && has(s, 'minimum') && v < s.minimum) out.push(`${P(path)}: must be >= ${numStr(s.minimum)}`);
    if (Array.isArray(v)) {
      if (has(s, 'minItems') && v.length < s.minItems) out.push(`${P(path)}: needs at least ${numStr(s.minItems)} item(s)`);
      if (has(s, 'items')) v.forEach((x, i) => this.check(x, s.items, `${path}[${i}]`, out));
    }
    if (isDict(v)) {
      for (const k of get(s, 'required') || []) {
        if (!has(v, k)) out.push(`${P(path)}: missing required "${k}"`);
      }
      const props = get(s, 'properties') || {};
      const extra = has(s, 'additionalProperties') ? s.additionalProperties : true;
      for (const k of Object.keys(v)) {
        const sub = path ? `${path}.${k}` : k;
        if (has(props, k)) this.check(v[k], props[k], sub, out);
        else if (extra === false) out.push(`${P(path)}: unknown property "${k}"`);
        else if (isDict(extra)) this.check(v[k], extra, sub, out);
      }
    }
    if (has(s, 'anyOf')) {
      if (!s.anyOf.some((sub: any) => !this.errors(v, sub, path).length)) {
        const req = s.anyOf.map((x: any) => get(x, 'required')).filter((r: any) => truthy(r));
        if (req.length && req.length === s.anyOf.length) out.push(`${P(path)}: needs one of ${req.map((r: any[]) => r[0]).join(', ')}`);
        else out.push(`${P(path)}: does not match any allowed form`);
      }
    }
    if (has(s, 'oneOf')) {
      const results: string[][] = s.oneOf.map((sub: any) => this.errors(v, sub, path));
      const ok = results.filter((r) => !r.length).length;
      if (ok !== 1) {
        if (ok === 0) {
          // report the errors of the alternative whose type matches (else the one with fewest errors)
          const typeOk = (sub: any) => {
            sub = has(sub, '$ref') ? this.resolve(sub.$ref) : sub;
            const t = get(sub, 'type');
            return t === undefined || t === null || (Array.isArray(t) ? t : [t]).some((x: string) => TYPES[x](v));
          };
          const typed = results.filter((_, i) => typeOk(s.oneOf[i]));
          const pool = typed.length ? typed : results;
          let best = pool[0];
          for (const r of pool) if (r.length < best.length) best = r;
          out.push(...best);
        } else out.push(`${P(path)}: matches more than one allowed form`);
      }
    }
  }
}

function dupes(items: any[], what: string, out: string[]): void {
  const seen: unknown[] = [];
  for (const x of items) {
    const i = isDict(x) ? get(x, 'id') : undefined;
    if (i === undefined || i === null) continue;
    if (seen.some((y) => pyEq(y, i))) out.push(`duplicate ${what} id "${model.s(i)}"`);
    seen.push(i);
  }
}

/** Cross-reference checks the schema cannot express. Returns [errors, warnings]. */
export function semantic(data: any, base: string, checkFiles = true): [string[], string[]] {
  const errors: string[] = [];
  const warnings: string[] = [];
  const S = model.s;
  const plats: any[] = model.platforms(data).map((p: any) => p.id);
  const sevs: any[] = model.severities(data).map((x: any) => x.id);
  const areas = new Map<any, any>();
  for (const a of get(data, 'areas') || []) areas.set(a.id, a);
  const issues: any[] = get(data, 'issues') || [];
  const fixes: any[] = get(data, 'fixes') || [];
  const planItems: any[] = [];
  for (const g of get(data, 'plan') || []) planItems.push(...(get(g, 'items') || []));
  dupes(model.platforms(data), 'platform', errors);
  dupes(model.severities(data), 'severity', errors);
  dupes(get(data, 'areas') || [], 'area', errors);
  dupes(issues, 'issue', errors);
  dupes(fixes, 'fix', errors);
  dupes(planItems, 'plan item', errors);
  const issueIds = new Set(issues.map((i) => i.id));
  const fixIds = new Set(fixes.map((f) => f.id));
  const multi = plats.length > 1;

  const platOk = (where: string, p: any) => {
    if (p !== undefined && p !== null && !plats.includes(p)) {
      errors.push(`${where}: unknown platform "${S(p)}" (known: ${plats.map(S).join(', ')})`);
    }
  };
  const sevOk = (where: string, x: any) => {
    if (x !== undefined && x !== null && !sevs.includes(x)) {
      errors.push(`${where}: unknown severity "${S(x)}" (known: ${sevs.map(S).join(', ')})`);
    }
  };

  for (const a of get(data, 'areas') || []) platOk(`areas[${S(a.id)}]`, get(a, 'platform'));
  for (const it of issues) {
    const w = `issues[${S(it.id)}]`;
    platOk(w, get(it, 'platform'));
    if (multi && !truthy(get(it, 'platform'))) warnings.push(`${w}: no platform set; it will be listed under "${S(plats[0])}"`);
    sevOk(w, get(it, 'severity'));
    const a = get(it, 'area');
    if (truthy(a) && areas.size && !areas.has(a)) warnings.push(`${w}: area "${S(a)}" is not an area id; shown as free text`);
    else if (truthy(a) && areas.has(a) && truthy(get(areas.get(a), 'platform')) && truthy(get(it, 'platform'))
      && areas.get(a).platform !== it.platform) {
      warnings.push(`${w}: area "${S(a)}" belongs to platform "${S(areas.get(a).platform)}"`);
    }
  }
  const numbers = new Map<number, any>();
  for (const fx of fixes) {
    const w = `fixes[${S(fx.id)}]`;
    for (const p of Object.keys(get(fx, 'platforms') || {})) platOk(w, p);
    for (const i of get(fx, 'issues') || []) {
      if (!issueIds.has(i)) errors.push(`${w}: unknown issue "${S(i)}"`);
    }
    const n = get(fx, 'number');
    if (n !== undefined && n !== null) {
      if (numbers.has(n)) warnings.push(`${w}: number ${numStr(n)} also used by fixes[${S(numbers.get(n))}]`);
      numbers.set(n, fx.id);
    }
  }
  for (const g of get(data, 'plan') || []) {
    platOk(`plan[${S(g.title)}]`, get(g, 'platform'));
    for (const it of get(g, 'items') || []) {
      const w = `plan[${S(g.title)}] item "${S(truthy(get(it, 'id')) ? it.id : pySlice(it.title, 0, 40))}"`;
      sevOk(w, get(it, 'severity'));
      for (const i of get(it, 'issues') || []) {
        if (!issueIds.has(i)) errors.push(`${w}: unknown issue "${S(i)}"`);
      }
      for (const i of get(it, 'fixes') || []) {
        if (!fixIds.has(i)) errors.push(`${w}: unknown fix "${S(i)}"`);
      }
    }
  }
  for (const a of get(data, 'appendix') || []) platOk(`appendix[${S(a.title)}]`, get(a, 'platform'));
  for (const [where, img] of model.iterImages(data)) {
    const src = model.imageSrc(img);
    try {
      const target = safety.localSource(base, src, true);
      if (checkFiles && !isfile(target)) errors.push(`${where}: image not found: ${S(src)}`);
    } catch (e) {
      if (!(e instanceof ReviewError)) throw e;
      errors.push(`${where}: ${e.message}`);
    }
  }
  const links: [string, any][] = (get(data.project, 'links') || []).map((l: any) => ['project.links', l]);
  for (const fx of fixes) {
    for (const l of get(fx, 'links') || []) links.push([`fixes[${S(fx.id)}].links`, l]);
    for (const commit of get(fx, 'commits') || []) {
      if (truthy(get(commit, 'url')) && safety.safeUrl(commit.url) !== commit.url) errors.push(`fixes[${S(fx.id)}].commits: unsafe URL`);
    }
  }
  for (const [where, link] of links) {
    const href = link.href;
    if (safety.safeUrl(href) !== href) {
      errors.push(`${where}: unsafe URL`);
      continue;
    }
    if (safety.isLocalLink(href)) {
      try {
        const target = safety.localSource(base, href);
        if (checkFiles && !isfile(target)) errors.push(`${where}: local file not found: ${href}`);
      } catch (e) {
        if (!(e instanceof ReviewError)) throw e;
        errors.push(`${where}: ${e.message}`);
      }
    }
  }
  const repo = has(data.project, 'repo') ? data.project.repo : '';
  if (truthy(repo) && !/^https?:\/\//i.test(repo)) errors.push('project.repo: use a public HTTP(S) URL instead of a local path');
  else if (truthy(repo) && safety.safeUrl(repo) !== repo) errors.push('project.repo: unsafe URL');
  return [errors, warnings];
}

/** Full validation. Returns [errors, warnings]; schema errors short-circuit the semantic checks. */
export function validate(data: unknown, base: string, checkFiles = true): [string[], string[]] {
  const errs = new SchemaValidator(model.loadSchema()).errors(data);
  if (errs.length) return [errs, []];
  return semantic(data, base, checkFiles);
}
