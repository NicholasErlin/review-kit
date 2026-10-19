"""Command line interface: review-kit <command> ...  (run `review-kit -h`)."""
import argparse
import glob
import json
import os
import sys

from . import __version__, attach, clean, companions, edit, model, summary, validate
from . import build as builder
from .model import ReviewError

CANDIDATES = ('review.json', '.review/review.json', 'docs/review/review.json', 'review/review.json')
KIND_PARENTS = ('.review', 'docs/review')


def find_review(path=None):
    if path:
        if not os.path.exists(path) and path in attach.KIND_DEFAULTS:
            for parent in KIND_PARENTS:
                if os.path.isfile(os.path.join(parent, path, 'review.json')):
                    return os.path.join(parent, path, 'review.json')
        if os.path.isdir(path):
            path = os.path.join(path, 'review.json')
        return path
    for c in CANDIDATES:
        if os.path.isfile(c):
            return c
    found = sorted(glob.glob(os.path.join('.review', '*', 'review.json')) +
                   glob.glob(os.path.join('docs', 'review', '*', 'review.json')))
    if len(found) == 1:
        return found[0]
    if found:
        raise ReviewError('several reviews here (' + ', '.join(found) + '); pass one, e.g. `review-kit build ui`')
    raise ReviewError('no review.json found here (looked for ' + ', '.join(CANDIDATES) +
                      ', .review/<kind>/review.json); pass a path or run `review-kit init`')


def _read_json_arg(args):
    if getattr(args, 'json', None):
        try:
            return json.loads(args.json)
        except ValueError as e:
            raise ReviewError(f'--json: invalid JSON: {e}')
    if getattr(args, 'file', None):
        if args.file == '-':
            try:
                return json.load(sys.stdin)
            except ValueError as e:
                raise ReviewError(f'stdin: invalid JSON: {e}')
        return model.load(args.file)
    return None


def _csv(s):
    return [x.strip() for x in s.split(',') if x.strip()] if s else []


def _cli_path(p, review_path):
    """Image paths on the command line: relative to review.json if found there, else to the cwd (then copied in)."""
    if os.path.isabs(p) or os.path.exists(os.path.join(model.base_dir(review_path), p)):
        return p
    return os.path.abspath(p)


def _review_arg(p):
    p.add_argument('review', nargs='?', help='path to review.json or its folder, or a kind (ui, backend) for .review/<kind>/ (default: auto-discover)')
    p.add_argument('-r', '--review-path', dest='review_opt', help=argparse.SUPPRESS)


def _json_args(p):
    p.add_argument('--json', help='the object as a JSON string')
    p.add_argument('--file', help='read the object from a JSON file ("-" for stdin)')


def _save_checked(path, data):
    warnings = edit.check(data, model.base_dir(path))
    model.save(path, data)
    for w in warnings:
        print('warning:', w)


# ---------------------------------------------------------------- commands
def cmd_init(a):
    d = attach.KIND_DEFAULTS.get(a.kind, {})
    platforms = _csv(a.platforms) if a.platforms is not None else d.get('platforms', ['mobile', 'desktop'])
    path = edit.init(a.dir, a.name or os.path.basename(os.path.abspath('.')), a.title or d.get('title', 'Review'),
                     platforms or ['default'], a.ignore_screenshots, a.accent, kind=a.kind)
    d = os.path.dirname(path)
    print(f'created {path}, {d}/screenshots/, {d}/pending/, {d}/.gitignore')
    print(f'next: review-kit add-issue {path} --title "..." --severity P1   |   review-kit build {path}')


def cmd_validate(a):
    path = find_review(a.review or a.review_opt)
    data = model.load(path)
    errors, warnings = validate.validate(data, model.base_dir(path), check_files=not a.no_files)
    for w in warnings:
        print('warning:', w)
    if errors:
        print('\n'.join('error: ' + e for e in errors), file=sys.stderr)
        return 1
    print(f'{path}: valid ({len(data.get("issues") or [])} issues, {len(data.get("fixes") or [])} fixes)')
    return 0


def _default_out(path):
    return os.path.join(model.base_dir(path), 'site')


def cmd_build(a):
    path = find_review(a.review or a.review_opt)
    builder.build(path, a.out or _default_out(path), max_width=a.max_width, force=a.force, clean=a.clean)


def cmd_serve(a):
    from . import serve as server
    target = a.target or a.review_opt
    if target and os.path.isdir(target) and os.path.isfile(os.path.join(target, 'index.html')) \
            and not os.path.isfile(os.path.join(target, 'review.json')):
        server.serve(target, a.host, a.port)
        return
    path = find_review(target)
    out = a.out or _default_out(path)
    if not a.no_build:
        builder.build(path, out, max_width=a.max_width, force=a.force)
    server.serve(out, a.host, a.port, review_path=path, watch=a.watch, max_width=a.max_width)


def cmd_add_issue(a):
    path = find_review(a.review or a.review_opt)
    data = edit.load_checked(path)
    obj = _read_json_arg(a)
    items = obj if isinstance(obj, list) else [obj] if obj else [{}]
    flags = {k: v for k, v in {
        'id': a.id, 'platform': a.platform, 'area': a.area, 'severity': a.severity, 'status': a.status,
        'title': a.title, 'details': a.details, 'note': a.note, 'where': a.where,
    }.items() if v is not None}
    if a.top:
        flags['top'] = True
    if a.screenshot:
        flags['screenshots'] = [_cli_path(x, path) for x in a.screenshot]
    if a.tags:
        flags['tags'] = _csv(a.tags)
    out = []
    for it in items:
        it = dict(it)
        it.update(flags)
        if it.get('severity') in ('', 'none', 'null'):
            it['severity'] = None
        out.append(edit.upsert_issue(data, it, model.base_dir(path), update=a.update))
    _save_checked(path, data)
    for it in out:
        print(f'issue {it["id"]}: {it["title"]} [{it.get("severity") or "-"} / {it.get("status")}]')


def cmd_add_fix(a):
    path = find_review(a.review or a.review_opt)
    data = edit.load_checked(path)
    obj = _read_json_arg(a) or {}
    env = edit.normalise_envelope(obj) if obj else {'fix': {}}
    fx = dict(env.get('fix') or {})
    for k, v in {'id': a.id, 'title': a.title, 'date': a.date, 'summary': a.summary}.items():
        if v is not None:
            fx[k] = v
    if a.number is not None:
        fx['number'] = a.number
    if a.files:
        fx['files'] = _csv(a.files)
    for link in a.link or []:
        label, _, href = link.partition('=')
        fx.setdefault('links', []).append({'label': label, 'href': href} if href else {'label': link, 'href': link})
    for sha in a.commit or []:
        fx.setdefault('commits', []).append({'sha': sha})
    for plat, before, after in a.pair or []:
        p = fx.setdefault('platforms', {}).setdefault(plat, {})
        pr = {}
        for role, val in (('before', before), ('after', after)):
            if val not in ('-', ''):
                pr[role] = _cli_path(val, path)
        p.setdefault('pairs', []).append(pr)
    marks = list(env.get('marks') or [])
    for i in _csv(a.resolves):
        marks.append({'issue': i, 'status': 'fixed'})
    for i in _csv(a.partial):
        marks.append({'issue': i, 'status': 'partial'})
    for i in _csv(a.resolves) + _csv(a.partial):
        if i not in fx.get('issues', []):
            fx.setdefault('issues', []).append(i)
    env = dict(env)
    env['fix'] = fx
    env['marks'] = marks
    log = edit.merge(data, env, model.base_dir(path), update=a.update)
    _save_checked(path, data)
    print('\n'.join(log))


def cmd_add_plan(a):
    path = find_review(a.review or a.review_opt)
    data = edit.load_checked(path)
    it = dict(_read_json_arg(a) or {})
    for k, v in {'id': a.id, 'title': a.title, 'phase': a.phase, 'status': a.status, 'effort': a.effort,
                 'severity': a.severity, 'note': a.note, 'details': a.details}.items():
        if v is not None:
            it[k] = v
    if a.files:
        it['files'] = _csv(a.files)
    group = it.pop('group', None) or a.group or 'Plan'
    item = edit.add_plan_item(data, group, it)
    _save_checked(path, data)
    print(f'plan item {item["id"]} added to "{group}"')


def _looks_like_review(arg):
    return arg in attach.KIND_DEFAULTS or arg.endswith('.json') or os.path.isdir(arg)


def cmd_mark(a):
    # `mark [review] <status> <ids...>`, like the other commands; `-r review` still works.
    statuses = model.ISSUE_STATUSES + model.PLAN_STATUSES
    if a.review_opt is None and a.status not in statuses and _looks_like_review(a.status):
        if not a.ids or a.ids[0] not in statuses:
            raise ReviewError('usage: review-kit mark [review] <status> <ids...> (status: ' + '|'.join(statuses) + ')')
        if len(a.ids) < 2:
            raise ReviewError('mark: give one or more issue or plan item ids after the status')
        a.review_opt, a.status, a.ids = a.status, a.ids[0], a.ids[1:]
    path = find_review(a.review_opt)
    data = edit.load_checked(path)
    msgs = [edit.apply_mark(data, {'id': i, 'status': a.status, 'note': a.note or ''}, a.fix) for i in a.ids]
    _save_checked(path, data)
    print('\n'.join(msgs))


def cmd_apply_pending(a):
    path = find_review(a.review or a.review_opt)
    results = edit.apply_pending(path, a.dir)
    if not results:
        print('nothing pending')
    for name, log, warnings in results:
        print(f'{name}: ' + '; '.join(log))
        for w in warnings:
            print('  warning:', w)


def cmd_summary(a):
    path = find_review(a.review or a.review_opt)
    print(summary.summarise(edit.load_checked(path), open_limit=a.open, markdown=not a.text))


def cmd_clean(a):
    path = find_review(a.review or a.review_opt)
    removed, skipped = clean.clean(path, out=a.out, site=not a.keep_site, applied=not a.keep_applied,
                                   orphaned=a.orphans, dry_run=a.dry_run)
    for line in skipped:
        print('skipped:', line)
    verb = 'would remove' if a.dry_run else 'removed'
    for line in removed:
        print(f'{verb}: {line}')
    if not removed:
        print('nothing to clean')


def cmd_attach(a):
    files = [] if a.no_agents_file else (a.agents_file or None)
    for line in attach.attach(a.repo, _csv(a.kind) or ['ui'], a.dir, a.name, a.title, _csv(a.platforms),
                              a.ignore_screenshots, a.accent, files):
        print(line)
    print('next: ask your agent to run a review (it reports issues, then fixes the ones you approve)')


def cmd_companions(a):
    kinds = _csv(a.kind) or list(companions.KINDS)
    for k in kinds:
        if k not in companions.KINDS:
            raise ReviewError(f'unknown review kind {k!r}; expected one of {", ".join(companions.KINDS)}')
    if a.path:
        found = companions.find(a.path)
        if not found:
            raise ReviewError(f'{a.path}: not installed (`review-kit companions install` adds it)')
        print(os.path.dirname(found))
        return
    if a.action in ('install', 'update'):
        lines = companions.install(kinds, a.skills_dir or None) if a.action == 'install' else companions.update(kinds)
        for line in lines:
            print(line)
        return
    rows = companions.status(kinds)
    if a.json:
        print(json.dumps([{'kind': k, 'name': c['name'], 'use': c['use'], 'source': c['repo'], 'path': p}
                          for k, c, p in rows], indent=2))
        return
    for k, c, p in rows:
        print(f"{k:8} {c['name']:24} {p or 'not installed'}")
        print(f"{'':8} {'':24} {c['use']}")
    if any(p is None for _, _, p in rows):
        print('\nmissing skills are optional; `review-kit companions install` links the bundled copies into '
              '~/.claude/skills, or pass --skills-dir DIR for other agents')


def cmd_home(a):
    print(model.ROOT)


def cmd_schema(a):
    print(model.SCHEMA_PATH)


# ---------------------------------------------------------------- parser
def parser():
    p = argparse.ArgumentParser(prog='review-kit', description='Track issues and fixes (with before/after screenshots) in review.json and publish an offline review site.')
    p.add_argument('--version', action='version', version=f'review-kit {__version__}')
    sub = p.add_subparsers(dest='cmd', metavar='<command>')
    sub.required = True

    s = sub.add_parser('init', help='scaffold review.json, screenshots/ and pending/')
    s.add_argument('dir', nargs='?', default='.review', help='directory to create (default .review)')
    s.add_argument('--name', help='project name (default: current folder name)')
    s.add_argument('--kind', choices=attach.KIND_DEFAULTS, help='ui (UI/UX) or backend; sets the title and platform defaults')
    s.add_argument('--title', help='shown after the name, e.g. "UI/UX audit" (default from --kind, else "Review")')
    s.add_argument('--platforms', help='comma list, e.g. "mobile,desktop" or "web" (default mobile,desktop; none for backend)')
    s.add_argument('--accent', help='header colour, e.g. "#12454f"')
    s.add_argument('--ignore-screenshots', action='store_true', help='gitignore screenshots/ (keeps the repo small)')
    s.set_defaults(fn=cmd_init)

    s = sub.add_parser('attach', help='set a repo up: create (or reuse) .review/<kind>/ and point AGENTS.md at the review-kit skill')
    s.add_argument('repo', nargs='?', default='.', help='repository folder (default: current folder)')
    s.add_argument('--kind', default='ui', help='comma list of review kinds: ui, backend (default ui)')
    s.add_argument('--dir', default='.review', help='parent folder for the reviews (default .review, giving .review/ui/ ...)')
    s.add_argument('--name', help='project name (default: repo folder name)')
    s.add_argument('--title', help='header title (default per kind: "UI/UX review", "Backend review")')
    s.add_argument('--platforms', help='UI review platforms (default mobile,desktop)')
    s.add_argument('--accent')
    s.add_argument('--ignore-screenshots', action='store_true')
    s.add_argument('--agents-file', action='append', metavar='FILE',
                   help='instructions file to add the pointer to (repeatable; default AGENTS.md, plus CLAUDE.md if present)')
    s.add_argument('--no-agents-file', action='store_true', help='only create the review folder')
    s.set_defaults(fn=cmd_attach)

    s = sub.add_parser('validate', help='check review.json against the schema and cross-references')
    _review_arg(s)
    s.add_argument('--no-files', action='store_true', help='skip checking that images exist')
    s.set_defaults(fn=cmd_validate)

    s = sub.add_parser('build', help='validate and write the static site')
    _review_arg(s)
    s.add_argument('--out', help='output folder (default: site/ next to review.json)')
    s.add_argument('--max-width', type=int, help='downscale wider PNG/JPEG images (needs sips or ImageMagick; copied as-is otherwise)')
    s.add_argument('--clean', action='store_true', help='re-copy all images (e.g. after changing --max-width)')
    s.add_argument('--force', action='store_true', help='build into an existing folder not created by review-kit')
    s.set_defaults(fn=cmd_build)

    s = sub.add_parser('serve', help='build (unless --no-build) and serve locally; --host 0.0.0.0 enables network sharing')
    s.add_argument('target', nargs='?', help='review.json, its folder, or a built site folder')
    s.add_argument('-r', dest='review_opt', help=argparse.SUPPRESS)
    s.add_argument('--port', type=int, default=8787, help='default 8787 (0 = pick a free port)')
    s.add_argument('--host', default='127.0.0.1', help='default 127.0.0.1 (local only); use 0.0.0.0 to share on your network')
    s.add_argument('--out', help='site folder (default: site/ next to review.json)')
    s.add_argument('--watch', action='store_true', help='rebuild when review.json or screenshots/ change')
    s.add_argument('--no-build', action='store_true')
    s.add_argument('--max-width', type=int)
    s.add_argument('--force', action='store_true')
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser('add-issue', help='add (or --update) issues from flags or JSON')
    _review_arg(s)
    _json_args(s)
    for f in ('id', 'platform', 'area', 'severity', 'title', 'details', 'note', 'where', 'tags'):
        s.add_argument('--' + f)
    s.add_argument('--status', choices=model.ISSUE_STATUSES)
    s.add_argument('--top', action='store_true', help='list in Overview top issues')
    s.add_argument('--screenshot', action='append', help='image path (repeatable; absolute paths are copied in)')
    s.add_argument('--update', action='store_true', help='merge into an existing issue with the same id')
    s.set_defaults(fn=cmd_add_issue)

    s = sub.add_parser('add-fix', help='add a fix (bare fix JSON or a hand-off envelope) and mark issues')
    _review_arg(s)
    _json_args(s)
    s.add_argument('--id')
    s.add_argument('--title')
    s.add_argument('--number', type=int)
    s.add_argument('--date', help='default today (ISO)')
    s.add_argument('--summary')
    s.add_argument('--files', help='comma list of changed files')
    s.add_argument('--commit', action='append', help='commit sha (repeatable)')
    s.add_argument('--link', action='append', help='"Label=URL" (repeatable)')
    s.add_argument('--pair', nargs=3, action='append', metavar=('PLATFORM', 'BEFORE', 'AFTER'),
                   help='before/after screenshot pair; "-" for a missing side (repeatable)')
    s.add_argument('--resolves', help='comma list of issue ids to mark fixed and link')
    s.add_argument('--partial', help='comma list of issue ids to mark partly fixed and link')
    s.add_argument('--update', action='store_true', help='replace an existing fix with the same id')
    s.set_defaults(fn=cmd_add_fix)

    s = sub.add_parser('add-plan', help='add a plan/roadmap item')
    _review_arg(s)
    _json_args(s)
    s.add_argument('--group', help='plan group title or id (created if missing; default "Plan")')
    for f in ('id', 'title', 'phase', 'effort', 'severity', 'note', 'details', 'files'):
        s.add_argument('--' + f)
    s.add_argument('--status', choices=model.PLAN_STATUSES)
    s.set_defaults(fn=cmd_add_plan)

    s = sub.add_parser('mark', help='set the status of issues or plan items',
                       usage='review-kit mark [review] <status> <ids...> [--note NOTE] [--fix FIX]')
    s.add_argument('-r', '--review', dest='review_opt', help='path to review.json or its folder, or a kind (ui, backend) for .review/<kind>/ (default: auto-discover)')
    s.add_argument('status', help='issue: ' + '|'.join(model.ISSUE_STATUSES) + '; plan: ' + '|'.join(model.PLAN_STATUSES))
    s.add_argument('ids', nargs='+', help='issue or plan item ids')
    s.add_argument('--note')
    s.add_argument('--fix', help='fix id to link (adds the issue to that fix)')
    s.set_defaults(fn=cmd_mark)

    s = sub.add_parser('apply-pending', help='merge hand-off JSON files from pending/ (renamed to *.applied.json)')
    _review_arg(s)
    s.add_argument('--dir', help='pending folder (default: pending/ next to review.json)')
    s.set_defaults(fn=cmd_apply_pending)

    s = sub.add_parser('summary', help='print a Markdown progress summary')
    _review_arg(s)
    s.add_argument('--open', type=int, default=8, help='how many open issues to list (default 8)')
    s.add_argument('--text', action='store_true', help='plain text instead of Markdown')
    s.set_defaults(fn=cmd_summary)

    s = sub.add_parser('clean', help='remove the built site, merged pending/*.applied.json and (--orphans) unused screenshots')
    _review_arg(s)
    s.add_argument('--out', help='site folder (default: site/ next to review.json); only removed if review-kit built it')
    s.add_argument('--orphans', action='store_true', help='also delete files in screenshots/ that review.json does not reference')
    s.add_argument('--keep-site', action='store_true', help='leave the built site in place')
    s.add_argument('--keep-applied', action='store_true', help='leave pending/*.applied.json in place')
    s.add_argument('-n', '--dry-run', action='store_true', help='list what would be removed without deleting anything')
    s.set_defaults(fn=cmd_clean)

    s = sub.add_parser('companions', help='show, install or update the bundled agent skills that UI/UX and backend reviews use')
    s.add_argument('action', nargs='?', choices=['list', 'install', 'update'], default='list',
                   help='list (default), install (link the bundled skills), update (maintainers: refresh the bundle)')
    s.add_argument('--kind', help='comma list: ui, backend (default both)')
    s.add_argument('--skills-dir', action='append', metavar='DIR',
                   help='install: link into this skills folder (repeatable; default ~/.claude/skills if ~/.claude exists)')
    s.add_argument('--json', action='store_true', help='list as JSON')
    s.add_argument('--path', metavar='NAME', help='print the folder of one installed companion skill (exit 1 if missing)')
    s.set_defaults(fn=cmd_companions)

    s = sub.add_parser('home', help='print the folder review-kit is installed in (docs, skill, capture helper)')
    s.set_defaults(fn=cmd_home)

    s = sub.add_parser('schema', help='print the path of review.schema.json')
    s.set_defaults(fn=cmd_schema)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return args.fn(args) or 0
    except ReviewError as e:
        print(f'review-kit: {e}', file=sys.stderr)
        return 1
    except OSError as e:
        where = f'{e.filename}: ' if getattr(e, 'filename', None) else ''
        print(f'review-kit: {where}{e.strerror or e}', file=sys.stderr)
        return 1
