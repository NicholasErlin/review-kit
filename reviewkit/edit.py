"""Commands that create or update review.json: init, add-issue, add-fix, add-plan, mark, apply-pending."""
import copy
import datetime
import filecmp
import os
import re
import shutil

from . import FORMAT_VERSION, model, safety, validate
from .model import ReviewError

PENDING_KEYS = {'fix', 'issues', 'marks', 'plan'}


# ---------------------------------------------------------------- init
def init(directory, name, title='Review', platforms=('mobile', 'desktop'), ignore_screenshots=False, accent=None,
         kind=None):
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, 'review.json')
    if os.path.exists(path):
        raise ReviewError(f'{path} already exists')
    plats = []
    for p in platforms:
        pid = re.sub(r'[^A-Za-z0-9_-]+', '-', p.strip()).strip('-') or 'default'
        shape = 'portrait' if pid.lower() in ('mobile', 'phone', 'ios', 'android') else 'auto'
        plats.append({'id': pid, 'label': p.strip().capitalize() if p.islower() else p.strip(), 'shape': shape})
    data = {
        '$schema': model.SCHEMA_URL,
        'version': FORMAT_VERSION,
        'project': {'name': name, 'title': title, 'date': datetime.date.today().isoformat(), 'links': []},
        'platforms': plats,
        'severities': copy.deepcopy(model.DEFAULT_SEVERITIES),
        'areas': [], 'issues': [], 'fixes': [], 'plan': [],
    }
    if kind:
        data['project']['kind'] = kind
    if accent:
        data['project']['theme'] = {'accent': accent}
    model.save(path, data)
    for sub in ('screenshots', 'pending'):
        os.makedirs(os.path.join(directory, sub), exist_ok=True)
        keep = os.path.join(directory, sub, '.gitkeep')
        if not os.path.exists(keep):
            open(keep, 'w').close()
    ignore = ['# review-kit build output', 'site/', '# Local secrets and browser sessions',
              '.env', '.env.*', '!.env.example', '!.env.sample', '*.pem', '*.key', '*.p12', '*.pfx',
              '*.keystore', 'credentials', 'credentials.json', 'secrets.json', 'state.json', 'storage-state.json',
              'storageState.json', 'auth.json', 'cookies.json', '.auth/', 'playwright/.auth/',
              'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.ssh/', '.aws/']
    if ignore_screenshots:
        ignore += ['# screenshots are large; keep them out of git', 'screenshots/*', '!screenshots/.gitkeep']
    gi = os.path.join(directory, '.gitignore')
    if not os.path.exists(gi):
        with open(gi, 'w') as f:
            f.write('\n'.join(ignore) + '\n')
    return path


# ---------------------------------------------------------------- helpers
def _today():
    return datetime.date.today().isoformat()


def _slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:40] or 'item'


def _unique(base, taken):
    if base not in taken:
        return base
    n = 2
    while f'{base}-{n}' in taken:
        n += 1
    return f'{base}-{n}'


def _import_image(img, review_dir, subdir):
    """Absolute image paths are copied into <review>/screenshots/<subdir>/ and rewritten as relative."""
    src = model.image_src(img)
    if not src or not os.path.isabs(src):
        return img
    if not os.path.isfile(src):
        raise ReviewError(f'image not found: {src}')
    if os.path.splitext(src)[1].lower() not in safety.IMAGE_EXTS:
        raise ReviewError('only raster screenshots may be imported')
    rd = os.path.abspath(review_dir)
    if os.path.abspath(src).startswith(rd + os.sep):
        rel = os.path.relpath(src, rd)
    else:
        dest_dir = os.path.join(rd, 'screenshots', subdir)
        os.makedirs(dest_dir, exist_ok=True)
        stem, ext = os.path.splitext(os.path.basename(src))
        dest, n = os.path.join(dest_dir, stem + ext), 2
        # Never overwrite a different image that already has this name (before/ and after/ folders often share names).
        while os.path.exists(dest) and not filecmp.cmp(src, dest, shallow=False):
            dest, n = os.path.join(dest_dir, f'{stem}-{n}{ext}'), n + 1
        if not os.path.exists(dest):
            shutil.copy2(src, dest)
        rel = os.path.relpath(dest, rd)
    rel = rel.replace(os.sep, '/')
    if isinstance(img, str):
        return rel
    out = dict(img)
    out['src'] = rel
    return out


def _import_issue_images(issue, review_dir):
    if issue.get('screenshots'):
        issue['screenshots'] = [_import_image(s, review_dir, 'issues') for s in issue['screenshots']]


def _import_fix_images(fix, review_dir):
    sub = fix['id']
    for p in (fix.get('platforms') or {}).values():
        for pair in p.get('pairs') or []:
            for role in ('before', 'after'):
                if pair.get(role):
                    pair[role] = _import_image(pair[role], review_dir, sub)
        if p.get('images'):
            p['images'] = [_import_image(x, review_dir, sub) for x in p['images']]


def _append_note(old, new):
    if not old:
        return new
    if not new or new in old:
        return old
    return old.rstrip() + '\n\n' + new


# ---------------------------------------------------------------- issues
def upsert_issue(data, issue, review_dir, update=False):
    issues = data.setdefault('issues', [])
    issue = dict(issue)
    ids = {i['id'] for i in issues}
    if not issue.get('id'):
        prefix = (issue.get('platform') or 'issue')[:1].lower() if len(model.platforms(data)) > 1 else 'issue'
        n = len(issues) + 1
        while f'{prefix}-{n}' in ids:
            n += 1
        issue['id'] = f'{prefix}-{n}'
    _import_issue_images(issue, review_dir)
    for i, old in enumerate(issues):
        if old['id'] == issue['id']:
            if not update:
                raise ReviewError(f'issue "{issue["id"]}" already exists (use --update to merge fields)')
            merged = dict(old)
            merged.update(issue)
            issues[i] = merged
            return merged
    if not issue.get('title'):
        raise ReviewError('a new issue needs a "title"')
    issue.setdefault('status', 'open')
    if 'severity' not in issue:
        issue['severity'] = None
    if len(model.platforms(data)) == 1 and 'platform' not in issue:
        issue['platform'] = model.platforms(data)[0]['id']
    issues.append(issue)
    return issue


# ---------------------------------------------------------------- marks
def _find_plan_item(data, ident):
    for g in data.get('plan') or []:
        for it in g.get('items') or []:
            if it.get('id') == ident:
                return it
    return None


def apply_mark(data, mark, fix_id=None):
    """mark = {"issue"|"plan"|"id": ..., "status": ..., "note": ...}. Returns a description string."""
    status = mark.get('status')
    note = mark.get('note', '')
    if 'plan' in mark:
        target, kind = _find_plan_item(data, mark['plan']), 'plan'
    else:
        ident = mark.get('issue') or mark.get('id')
        target = next((i for i in data.get('issues') or [] if i['id'] == ident), None)
        kind = 'issue'
        if target is None and 'issue' not in mark:
            target, kind = _find_plan_item(data, ident), 'plan'
    ident = mark.get('plan') or mark.get('issue') or mark.get('id')
    if target is None:
        raise ReviewError(f'mark: no issue or plan item with id "{ident}"')
    allowed = model.PLAN_STATUSES if kind == 'plan' else model.ISSUE_STATUSES
    if status not in allowed:
        raise ReviewError(f'mark {ident}: status must be one of {", ".join(allowed)}')
    target['status'] = status
    if note:
        target['note'] = _append_note(target.get('note', ''), note)
    if fix_id:
        if kind == 'issue':
            fx = next((f for f in data.get('fixes') or [] if f['id'] == fix_id), None)
            if fx is not None and ident not in (fx.get('issues') or []):
                fx.setdefault('issues', []).append(ident)
        else:
            if fix_id not in (target.get('fixes') or []):
                target.setdefault('fixes', []).append(fix_id)
    return f'{kind} {ident} -> {status}'


# ---------------------------------------------------------------- fixes
def upsert_fix(data, fix, review_dir, update=False):
    fixes = data.setdefault('fixes', [])
    fix = dict(fix)
    if 'number' not in fix:
        nums = [f['number'] for f in fixes if isinstance(f.get('number'), int)]
        fix['number'] = (max(nums) + 1) if nums else 1
    elif fix['number'] is None:
        del fix['number']
    if not fix.get('id'):
        fix['id'] = _unique(f'fix-{fix["number"]}' if 'number' in fix else 'fix-' + _slug(fix.get('title', '')),
                            {f['id'] for f in fixes})
    fix.setdefault('date', _today())
    if not fix.get('title'):
        raise ReviewError('a fix needs a "title"')
    _import_fix_images(fix, review_dir)
    for i, old in enumerate(fixes):
        if old['id'] == fix['id']:
            if not update:
                raise ReviewError(f'fix "{fix["id"]}" already exists (use --update to replace it)')
            fixes[i] = fix
            return fix
    fixes.append(fix)
    return fix


def add_plan_item(data, group, item):
    plan = data.setdefault('plan', [])
    g = next((x for x in plan if x.get('id') == group or x['title'] == group), None)
    if g is None:
        g = {'id': _unique(_slug(group), {x.get('id') for x in plan}), 'title': group, 'items': []}
        plan.append(g)
    item = dict(item)
    if not item.get('title'):
        raise ReviewError('a plan item needs a "title"')
    taken = {it.get('id') for x in plan for it in x.get('items') or []}
    if item.get('id') and item['id'] in taken:
        raise ReviewError(f'plan item "{item["id"]}" already exists')
    if not item.get('id'):
        item['id'] = _unique('plan-' + _slug(re.sub(r'<[^>]+>', '', item['title']))[:30], taken)
    item.setdefault('status', 'todo')
    g.setdefault('items', []).append(item)
    return item


# ---------------------------------------------------------------- envelopes
def normalise_envelope(obj):
    """Accept a pending envelope {"fix", "issues", "marks", "plan"} or a bare fix object."""
    if not isinstance(obj, dict):
        raise ReviewError('expected a JSON object')
    if PENDING_KEYS & set(obj) and 'title' not in obj:
        unknown = set(obj) - PENDING_KEYS
        if unknown:
            raise ReviewError(f'unknown hand-off keys: {", ".join(sorted(unknown))} (allowed: {", ".join(sorted(PENDING_KEYS))})')
        env = obj
    else:
        env = {'fix': obj}
    errors = _envelope_errors(env)
    if errors:
        raise ReviewError('invalid hand-off:\n  ' + '\n  '.join(errors))
    return env


def _shape_errors(value, ref, where, ignore=()):
    """Schema errors for one hand-off object; ids and titles may still be filled in later, so nothing is required."""
    schema = model.load_schema()
    sub = dict(schema['$defs'][ref])
    sub.pop('required', None)
    if isinstance(value, dict):
        value = {k: v for k, v in value.items() if k not in ignore}
    return validate.SchemaValidator(schema).errors(value, sub, where)


def _envelope_errors(env):
    errors = []
    if env.get('fix') is not None:
        errors += _shape_errors(env['fix'], 'fix', 'fix', ignore={'marks'})
    marks = list(env.get('marks') or [])
    if isinstance(env.get('fix'), dict):
        marks += env['fix'].get('marks') or []
    for key, ref, ignore in (('issues', 'issue', ()), ('plan', 'planItem', ('group',)), ('marks', None, ())):
        items = marks if key == 'marks' else env.get(key)
        if items is None:
            continue
        if not isinstance(items, list):
            errors.append(f'{key}: expected a list, got {type(items).__name__}')
            continue
        for i, it in enumerate(items):
            if ref:
                errors += _shape_errors(it, ref, f'{key}[{i}]', ignore)
            elif not isinstance(it, dict) or not isinstance(it.get('status'), str):
                errors.append(f'{key}[{i}]: expected {{"issue"|"plan": id, "status": ...}}')
    return errors


def load_checked(path):
    """Load review.json for editing, refusing a document whose shape the editing code cannot rely on."""
    data = model.load(path)
    errors = validate.SchemaValidator(model.load_schema()).errors(data)
    if errors:
        raise ReviewError(f'{path} is not a valid review (run `review-kit validate` for details):\n  '
                          + '\n  '.join(errors[:5]))
    return data


def merge(data, envelope, review_dir, update=False):
    """Apply a hand-off envelope to data in place. Returns a list of change descriptions."""
    env = normalise_envelope(envelope)
    log = []
    for issue in env.get('issues') or []:
        exists = any(i['id'] == issue.get('id') for i in data.get('issues') or [])
        it = upsert_issue(data, issue, review_dir, update=exists or update)
        log.append(f'issue {it["id"]} {"updated" if exists else "added"}')
    fix_id = None
    marks = list(env.get('marks') or [])
    if env.get('fix'):
        fx = dict(env['fix'])
        marks += [dict(m) for m in fx.pop('marks', [])]
        fx = upsert_fix(data, fx, review_dir, update=update)
        fix_id = fx['id']
        log.append(f'fix {fix_id} (#{fx.get("number", "-")}) {"replaced" if update else "added"}')
    for p in env.get('plan') or []:
        p = dict(p)
        group = p.pop('group', None) or 'Plan'
        it = add_plan_item(data, group, p)
        log.append(f'plan item {it["id"]} added to "{group}"')
    for m in marks:
        log.append(apply_mark(data, m, fix_id))
    return log


def check(data, review_dir):
    errors, warnings = validate.validate(data, os.path.abspath(review_dir))
    if errors:
        raise ReviewError('the result would not validate; review.json left unchanged:\n  ' + '\n  '.join(errors))
    return warnings


def apply_pending(review_path, pending_dir=None):
    """Merge every <pending>/*.json (not *.applied.json) in natural order, renaming each to .applied.json."""
    review_dir = model.base_dir(review_path)
    pending_dir = pending_dir or os.path.join(review_dir, 'pending')
    if not os.path.isdir(pending_dir):
        raise ReviewError(f'{pending_dir}: no such directory')

    def natural(n):
        return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', n)]

    names = sorted((n for n in os.listdir(pending_dir) if n.endswith('.json') and not n.endswith('.applied.json')), key=natural)
    results = []
    for n in names:
        data = load_checked(review_path)
        p = os.path.join(pending_dir, n)
        env = model.load(p)
        log = merge(data, env, review_dir)
        warnings = check(data, review_dir)
        model.save(review_path, data)
        os.replace(p, p[:-5] + '.applied.json')
        results.append((n, log, warnings))
    return results
