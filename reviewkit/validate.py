"""Validation: a small JSON Schema interpreter (the subset review.schema.json uses) plus cross-reference checks.

Supported keywords: type, enum, const, required, properties, additionalProperties, items,
minItems, minLength, maxLength, pattern, minimum, oneOf, anyOf, $ref (local #/$defs/...).
Unknown keywords (description, default, title, ...) are ignored.
"""
import os
import re

from . import model, safety

_TYPES = {
    'object': lambda v: isinstance(v, dict),
    'array': lambda v: isinstance(v, list),
    'string': lambda v: isinstance(v, str),
    'integer': lambda v: isinstance(v, int) and not isinstance(v, bool),
    'number': lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    'boolean': lambda v: isinstance(v, bool),
    'null': lambda v: v is None,
}


def _ecma_pattern(p):
    """JSON Schema patterns are ECMA-262: an unescaped trailing $ is the very end, but Python's $ also matches
    before a final newline, so translate it to \\Z."""
    if p.endswith('$'):
        backslashes = len(p[:-1]) - len(p[:-1].rstrip('\\'))
        if backslashes % 2 == 0:  # an escaped \$ is a literal dollar sign
            return p[:-1] + r'\Z'
    return p


def _path(p):
    return p or '(root)'


class SchemaValidator:
    def __init__(self, schema):
        self.root = schema

    def resolve(self, ref):
        if not ref.startswith('#/'):
            raise ValueError(f'unsupported $ref {ref}')
        node = self.root
        for part in ref[2:].split('/'):
            node = node[part]
        return node

    def errors(self, value, schema=None, path=''):
        out = []
        self._check(value, self.root if schema is None else schema, path, out)
        return out

    def _check(self, v, s, path, out):
        if '$ref' in s:
            self._check(v, self.resolve(s['$ref']), path, out)
        if 'type' in s:
            types = s['type'] if isinstance(s['type'], list) else [s['type']]
            if not any(_TYPES[t](v) for t in types):
                out.append(f'{_path(path)}: expected {" or ".join(types)}, got {type(v).__name__}')
                return
        if 'const' in s and v != s['const']:
            out.append(f'{_path(path)}: must be {s["const"]!r}')
        if 'enum' in s and v not in s['enum']:
            out.append(f'{_path(path)}: {v!r} is not one of {", ".join(map(str, s["enum"]))}')
        if isinstance(v, str):
            if 'minLength' in s and len(v) < s['minLength']:
                out.append(f'{_path(path)}: must not be empty' if s['minLength'] == 1 else f'{_path(path)}: shorter than {s["minLength"]}')
            if 'maxLength' in s and len(v) > s['maxLength']:
                out.append(f'{_path(path)}: longer than {s["maxLength"]} characters')
            if 'pattern' in s and not re.search(_ecma_pattern(s['pattern']), v):
                out.append(f'{_path(path)}: {v!r} does not match {s["pattern"]}')
        if _TYPES['number'](v) and 'minimum' in s and v < s['minimum']:
            out.append(f'{_path(path)}: must be >= {s["minimum"]}')
        if isinstance(v, list):
            if 'minItems' in s and len(v) < s['minItems']:
                out.append(f'{_path(path)}: needs at least {s["minItems"]} item(s)')
            if 'items' in s:
                for i, x in enumerate(v):
                    self._check(x, s['items'], f'{path}[{i}]', out)
        if isinstance(v, dict):
            for k in s.get('required', []):
                if k not in v:
                    out.append(f'{_path(path)}: missing required "{k}"')
            props = s.get('properties', {})
            extra = s.get('additionalProperties', True)
            for k, x in v.items():
                sub = f'{path}.{k}' if path else k
                if k in props:
                    self._check(x, props[k], sub, out)
                elif extra is False:
                    out.append(f'{_path(path)}: unknown property "{k}"')
                elif isinstance(extra, dict):
                    self._check(x, extra, sub, out)
        if 'anyOf' in s:
            if not any(not self.errors(v, sub, path) for sub in s['anyOf']):
                req = [x.get('required') for x in s['anyOf'] if x.get('required')]
                if req and len(req) == len(s['anyOf']):
                    out.append(f'{_path(path)}: needs one of {", ".join(r[0] for r in req)}')
                else:
                    out.append(f'{_path(path)}: does not match any allowed form')
        if 'oneOf' in s:
            results = [self.errors(v, sub, path) for sub in s['oneOf']]
            ok = sum(1 for r in results if not r)
            if ok != 1:
                if ok == 0:
                    # report the errors of the alternative whose type matches (else the one with fewest errors)
                    def type_ok(sub):
                        sub = self.resolve(sub['$ref']) if '$ref' in sub else sub
                        t = sub.get('type')
                        return t is None or any(_TYPES[x](v) for x in (t if isinstance(t, list) else [t]))
                    typed = [r for sub, r in zip(s['oneOf'], results) if type_ok(sub)]
                    out.extend(min(typed or results, key=len))
                else:
                    out.append(f'{_path(path)}: matches more than one allowed form')


def _dupes(items, what, out):
    seen = set()
    for x in items:
        i = x.get('id') if isinstance(x, dict) else None
        if i is None:
            continue
        if i in seen:
            out.append(f'duplicate {what} id "{i}"')
        seen.add(i)


def semantic(data, base, check_files=True):
    """Cross-reference checks the schema cannot express. Returns (errors, warnings)."""
    errors, warnings = [], []
    plats = [p['id'] for p in model.platforms(data)]
    sevs = [s['id'] for s in model.severities(data)]
    areas = {a['id']: a for a in data.get('areas') or []}
    issues = data.get('issues') or []
    fixes = data.get('fixes') or []
    plan_items = [it for g in data.get('plan') or [] for it in g.get('items') or []]
    _dupes(model.platforms(data), 'platform', errors)
    _dupes(model.severities(data), 'severity', errors)
    _dupes(data.get('areas') or [], 'area', errors)
    _dupes(issues, 'issue', errors)
    _dupes(fixes, 'fix', errors)
    _dupes(plan_items, 'plan item', errors)
    issue_ids = {i['id'] for i in issues}
    fix_ids = {f['id'] for f in fixes}
    multi = len(plats) > 1

    def plat_ok(where, p):
        if p is not None and p not in plats:
            errors.append(f'{where}: unknown platform "{p}" (known: {", ".join(plats)})')

    def sev_ok(where, s):
        if s is not None and s not in sevs:
            errors.append(f'{where}: unknown severity "{s}" (known: {", ".join(sevs)})')

    for a in data.get('areas') or []:
        plat_ok(f'areas[{a["id"]}]', a.get('platform'))
    for it in issues:
        w = f'issues[{it["id"]}]'
        plat_ok(w, it.get('platform'))
        if multi and not it.get('platform'):
            warnings.append(f'{w}: no platform set; it will be listed under "{plats[0]}"')
        sev_ok(w, it.get('severity'))
        a = it.get('area')
        if a and areas and a not in areas:
            warnings.append(f'{w}: area "{a}" is not an area id; shown as free text')
        elif a and a in areas and areas[a].get('platform') and it.get('platform') and areas[a]['platform'] != it['platform']:
            warnings.append(f'{w}: area "{a}" belongs to platform "{areas[a]["platform"]}"')
    numbers = {}
    for fx in fixes:
        w = f'fixes[{fx["id"]}]'
        for p in (fx.get('platforms') or {}):
            plat_ok(w, p)
        for i in fx.get('issues') or []:
            if i not in issue_ids:
                errors.append(f'{w}: unknown issue "{i}"')
        n = fx.get('number')
        if n is not None:
            if n in numbers:
                warnings.append(f'{w}: number {n} also used by fixes[{numbers[n]}]')
            numbers[n] = fx['id']
    for g in data.get('plan') or []:
        plat_ok(f'plan[{g["title"]}]', g.get('platform'))
        for it in g.get('items') or []:
            w = f'plan[{g["title"]}] item "{it.get("id") or it["title"][:40]}"'
            sev_ok(w, it.get('severity'))
            for i in it.get('issues') or []:
                if i not in issue_ids:
                    errors.append(f'{w}: unknown issue "{i}"')
            for i in it.get('fixes') or []:
                if i not in fix_ids:
                    errors.append(f'{w}: unknown fix "{i}"')
    for a in data.get('appendix') or []:
        plat_ok(f'appendix[{a["title"]}]', a.get('platform'))
    for where, img in model.iter_images(data):
        src = model.image_src(img)
        try:
            target = safety.local_source(base, src, image=True)
            if check_files and not os.path.isfile(target):
                errors.append(f'{where}: image not found: {src}')
        except model.ReviewError as e:
            errors.append(f'{where}: {e}')
    links = [('project.links', link) for link in data['project'].get('links') or []]
    for fx in fixes:
        links += [(f'fixes[{fx["id"]}].links', link) for link in fx.get('links') or []]
        for commit in fx.get('commits') or []:
            if commit.get('url') and safety.safe_url(commit['url']) != commit['url']:
                errors.append(f'fixes[{fx["id"]}].commits: unsafe URL')
    for where, link in links:
        href = link['href']
        if safety.safe_url(href) != href:
            errors.append(f'{where}: unsafe URL')
            continue
        if safety.is_local_link(href):
            try:
                target = safety.local_source(base, href)
                if check_files and not os.path.isfile(target):
                    errors.append(f'{where}: local file not found: {href}')
            except model.ReviewError as e:
                errors.append(f'{where}: {e}')
    repo = data['project'].get('repo', '')
    if repo and not re.match(r'^https?://', repo, re.I):
        errors.append('project.repo: use a public HTTP(S) URL instead of a local path')
    elif repo and safety.safe_url(repo) != repo:
        errors.append('project.repo: unsafe URL')
    return errors, warnings


def validate(data, base, check_files=True):
    """Full validation. Returns (errors, warnings); schema errors short-circuit the semantic checks."""
    errs = SchemaValidator(model.load_schema()).errors(data)
    if errs:
        return errs, []
    return semantic(data, base, check_files)
