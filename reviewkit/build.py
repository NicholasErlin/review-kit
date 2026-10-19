"""Build the static review site from review.json."""
import hashlib
import json
import os
import re
import shutil
import time

from . import __version__, images, markdown, model, safety, validate
from .model import ReviewError

MARKER = '.review-kit-site'
STATUS_LABELS = {
    'open': 'Open', 'partial': 'Partly fixed', 'fixed': 'Fixed', 'notabug': 'Not a bug', 'wontfix': "Won't fix",
}
PLAN_LABELS = {'todo': 'To do', 'doing': 'In progress', 'partial': 'Partly done', 'done': 'Done', 'dropped': 'Dropped'}


def _css_ident(s):
    return re.sub(r'[^A-Za-z0-9_-]', '_', s)


class _Assets:
    """Maps source files to site paths and records what must be copied."""

    def __init__(self, base, out, max_width, tool):
        self.base, self.out = os.path.realpath(base), os.path.realpath(out)
        self.max_width, self.tool = max_width, tool
        self.files = {}  # site rel path -> abs source
        self.cache = {}
        self.stats = {'copied': 0, 'resized': 0, 'kept': 0}

    def _dest(self, abs_src, folder):
        rel = os.path.relpath(abs_src, self.base)
        if rel.startswith('..') or os.path.isabs(rel):
            raise ReviewError('asset must stay inside the review folder')
        rel = rel.replace(os.sep, '/')
        safe = re.sub(r'[^A-Za-z0-9._/-]', '_', rel)
        dest = f'{folder}/{safe}'
        if self.files.get(dest, abs_src) != abs_src:
            # Another source sanitised to the same name ("a b.png" vs "a_b.png"): keep both apart.
            stem, ext = os.path.splitext(safe)
            dest = f'{folder}/{stem}-{hashlib.sha1(rel.encode("utf-8")).hexdigest()[:8]}{ext}'
        return dest

    def image(self, img, fmt):
        src = model.image_src(img)
        abs_src = safety.local_source(self.base, src, image=True)
        key = abs_src
        if key not in self.cache:
            dest = self._dest(abs_src, 'img')
            self.files[dest] = abs_src
            dim = images.size(abs_src)
            self.cache[key] = {'src': f'{dest}?v={images.fingerprint(abs_src)}', 'w': dim[0] if dim else None,
                               'h': dim[1] if dim else None}
        out = dict(self.cache[key])
        out['cap'] = markdown.to_html(img.get('caption', '') if isinstance(img, dict) else '', fmt)
        out['alt'] = img.get('alt', '') if isinstance(img, dict) else ''
        return out

    def link(self, href):
        if safety.safe_url(href) != href:
            raise ReviewError('unsafe link URL')
        if not safety.is_local_link(href):
            return href
        abs_src = safety.local_source(self.base, href)
        if not os.path.isfile(abs_src):
            raise ReviewError('local link target not found')
        dest = self._dest(abs_src, 'files')
        self.files[dest] = abs_src
        return f'{dest}?v={images.fingerprint(abs_src)}'

    def write(self):
        for dest, src in self.files.items():
            target = os.path.join(self.out, dest)
            mw = self.max_width if dest.startswith('img/') else None
            self.stats[images.publish(src, target, mw, self.tool)] += 1
        for folder in ('img', 'files'):
            root = os.path.join(self.out, folder)
            if not os.path.isdir(root):
                continue
            keep = {os.path.normpath(os.path.join(self.out, d)) for d in self.files}
            for dirpath, dirnames, filenames in os.walk(root, topdown=False):
                for n in filenames:
                    p = os.path.normpath(os.path.join(dirpath, n))
                    if p not in keep:
                        os.remove(p)
                if dirpath != root and not os.listdir(dirpath):
                    os.rmdir(dirpath)


def _shape(images_list):
    ratios = sorted(i['h'] / i['w'] for i in images_list if i.get('w') and i.get('h'))
    if not ratios:
        return 'landscape'
    return 'portrait' if ratios[len(ratios) // 2] > 1.15 else 'landscape'


def compile_data(data, base, assets):
    """Turn a validated review.json into the structure the site's app.js reads."""
    proj = data['project']
    fmt = proj.get('textFormat', 'markdown')
    rich = lambda t: markdown.to_html(t or '', fmt)  # noqa: E731
    plats = model.platforms(data)
    plat_ids = [p['id'] for p in plats]
    by_plat_imgs = {p: [] for p in plat_ids}

    def img(x, plat=None):
        out = assets.image(x, fmt)
        if plat in by_plat_imgs:
            by_plat_imgs[plat].append(out)
        return out

    areas = []
    for a in data.get('areas') or []:
        areas.append({'id': a['id'], 'title': a['title'], 'num': a.get('num', ''), 'platform': a.get('platform'),
                      'desc': rich(a.get('description')),
                      'shots': [img(s, a.get('platform')) for s in a.get('screenshots') or []]})
    fixes_for = {}
    for fx in data.get('fixes') or []:
        for i in fx.get('issues') or []:
            fixes_for.setdefault(i, []).append(fx['id'])
    issues = []
    for it in data.get('issues') or []:
        plat = it.get('platform') or plat_ids[0]
        issues.append({
            'id': it['id'], 'platform': plat, 'area': it.get('area', ''), 'sev': it.get('severity'),
            'status': it.get('status', 'open'), 'title': it['title'], 'html': rich(it.get('details')),
            'note': rich(it.get('note')), 'where': rich(it.get('where')), 'date': it.get('date', ''),
            'top': bool(it.get('top')), 'rank': it.get('rank'), 'counted': it.get('counted', True),
            'tags': it.get('tags') or [], 'shots': [img(s, plat) for s in it.get('screenshots') or []],
            'fixes': fixes_for.get(it['id'], []),
        })
    fixes = []
    for n, fx in enumerate(data.get('fixes') or []):
        pdata = {}
        for pid, p in (fx.get('platforms') or {}).items():
            pairs = []
            for pr in p.get('pairs') or []:
                pairs.append({'before': img(pr['before'], pid) if pr.get('before') else None,
                              'after': img(pr['after'], pid) if pr.get('after') else None,
                              'cap': rich(pr.get('caption'))})
            pdata[pid] = {'desc': rich(p.get('description')), 'pairs': pairs,
                          'other': [img(x, pid) for x in p.get('images') or []]}
        fixes.append({
            'id': fx['id'], 'num': fx.get('number'), 'title': fx['title'], 'date': fx.get('date', ''),
            'summary': rich(fx.get('summary')), 'files': fx.get('files') or [], 'commits': fx.get('commits') or [],
            'links': [{'label': l['label'], 'href': assets.link(l['href']), 'kind': l.get('kind', '')} for l in fx.get('links') or []],
            'issues': fx.get('issues') or [], 'platforms': pdata, 'order': n,
        })
    plan = []
    for g in data.get('plan') or []:
        items = []
        for it in g.get('items') or []:
            files = it.get('files')
            if isinstance(files, list):
                files = ', '.join(f'`{f}`' if fmt == 'markdown' else f'<code>{f}</code>' for f in files)
            items.append({'id': it.get('id', ''), 'phase': it.get('phase', ''), 'sev': it.get('severity'),
                          'title': markdown.to_html(it['title'], fmt), 'details': rich(it.get('details')),
                          'files': rich(files), 'effort': it.get('effort', ''), 'status': it.get('status', 'todo'),
                          'note': rich(it.get('note')), 'issues': it.get('issues') or [], 'fixes': it.get('fixes') or []})
        plan.append({'id': g.get('id', ''), 'title': g['title'], 'platform': g.get('platform'),
                     'intro': rich(g.get('intro')), 'items': items})
    appendix = [{'title': a['title'], 'platform': a.get('platform'), 'body': rich(a['body'])}
                for a in data.get('appendix') or []]
    theme = proj.get('theme') or {}
    out_plats = []
    for p in plats:
        shape = p.get('shape', 'auto')
        if shape == 'auto':
            shape = _shape(by_plat_imgs[p['id']])
        out_plats.append({'id': p['id'], 'label': p.get('label') or p['id'].capitalize(), 'shape': shape,
                          'desc': p.get('description', '')})
    return {
        'kit': __version__,
        'generated': time.strftime('%d %b %Y %H:%M'),
        'project': {
            'name': proj['name'], 'title': proj.get('title', 'Review'), 'desc': rich(proj.get('description')),
            'date': proj.get('date', ''), 'repo': proj.get('repo', ''),
            'links': [{'label': l['label'], 'href': assets.link(l['href']), 'kind': l.get('kind', '')}
                      for l in proj.get('links') or []],
            'theme': {'accent': theme.get('accent', model.DEFAULT_ACCENT), 'accentDark': theme.get('accentDark', ''),
                      'logoText': theme.get('logoText') or proj['name'][:1].upper()},
        },
        'platforms': out_plats,
        'severities': [{'id': s['id'], 'label': s.get('label') or s['id'], 'color': s.get('color', '#6f7f83'),
                        'desc': s.get('description', ''), 'cls': 'sv-' + _css_ident(s['id'])}
                       for s in model.severities(data)],
        'statusLabels': STATUS_LABELS,
        'planLabels': PLAN_LABELS,
        'areas': areas, 'issues': issues, 'fixes': fixes, 'plan': plan, 'appendix': appendix,
    }


def _check_out(out, base, review_path, force):
    out_abs = os.path.realpath(out)
    if out_abs == os.path.realpath(base) or os.path.realpath(review_path).startswith(out_abs + os.sep):
        raise ReviewError(f'--out {out} would overwrite the review sources; choose a separate folder (e.g. site/)')
    if os.path.isdir(out_abs) and os.listdir(out_abs) and not os.path.exists(os.path.join(out_abs, MARKER)) and not force:
        raise ReviewError(f'{out} exists and was not created by review-kit; use --force to build into it anyway')
    if os.path.islink(out):
        raise ReviewError('output directory must not be a symlink')
    expected = {MARKER, 'index.html', 'app.js', 'app.css', 'data.js'}
    for root, dirs, files in os.walk(out_abs):
        for name in dirs + files:
            path = os.path.join(root, name)
            if os.path.islink(path):
                raise ReviewError('output contains a symlink; choose a fresh output directory')
            rel = os.path.relpath(path, out_abs)
            if root == out_abs and name in expected and name in files:
                continue
            if rel.split(os.sep)[0] not in ('img', 'files'):
                raise ReviewError('output contains unexpected files; choose a fresh output directory')


def build(review_path, out, max_width=None, force=False, check_files=True, quiet=False, clean=False):
    """Validate review_path and write the site to out. Returns a stats dict."""
    data = model.load(review_path)
    base = model.base_dir(review_path)
    errors, warnings = validate.validate(data, base, check_files=check_files)
    if errors:
        raise ReviewError('validation failed:\n  ' + '\n  '.join(errors))
    _check_out(out, base, review_path, force)
    if clean and os.path.isdir(out):
        for folder in ('img', 'files'):
            shutil.rmtree(os.path.join(out, folder), ignore_errors=True)
    os.makedirs(out, exist_ok=True)
    tool = images.resizer() if max_width else None
    assets = _Assets(base, os.path.abspath(out), max_width, tool)
    site = compile_data(data, base, assets)
    assets.write()
    payload = 'window.REVIEW = ' + json.dumps(site, ensure_ascii=False, separators=(',', ':')) + ';\n'
    model.write_text(os.path.join(out, 'data.js'), payload)  # atomic: `serve --watch` may be reading it
    ver_src = payload
    for name in ('index.html', 'app.css', 'app.js'):
        with open(os.path.join(model.SITE_SRC, name), encoding='utf-8') as f:
            ver_src += f.read()
    ver = hashlib.sha1(ver_src.encode('utf-8')).hexdigest()[:10]
    proj = site['project']
    title = f'{proj["name"]} {proj["title"]}'.strip()
    for name in ('index.html', 'app.css', 'app.js'):
        with open(os.path.join(model.SITE_SRC, name), encoding='utf-8') as f:
            s = f.read()
        s = s.replace('__VER__', ver)
        if name == 'index.html':
            import html as _html
            s = s.replace('__TITLE__', _html.escape(title)).replace('__ACCENT__', proj['theme']['accent'])
        model.write_text(os.path.join(out, name), s)
    model.save(os.path.join(out, MARKER), {'version': 1,
               'files': ['index.html', 'app.css', 'app.js', 'data.js'] + sorted(assets.files)})
    counted = [i for i in site['issues'] if i['counted']]
    stats = {
        'issues': len(counted), 'summary_rows': len(site['issues']) - len(counted), 'fixes': len(site['fixes']),
        'pairs': sum(len(p['pairs']) for fx in site['fixes'] for p in fx['platforms'].values()),
        'images': len([d for d in assets.files if d.startswith('img/')]), 'plan_items': sum(len(g['items']) for g in site['plan']),
        'status': {}, 'warnings': warnings, 'assets': assets.stats, 'resizer': tool, 'out': os.path.abspath(out),
    }
    for i in counted:
        stats['status'][i['status']] = stats['status'].get(i['status'], 0) + 1
    if not quiet:
        for w in warnings:
            print('warning:', w)
        st = ', '.join(f'{v} {k}' for k, v in sorted(stats['status'].items()))
        print(f'{stats["issues"]} issues ({st or "none"}), {stats["fixes"]} fixes with {stats["pairs"]} before/after pairs, '
              f'{stats["plan_items"]} plan items, {stats["images"]} images '
              f'({assets.stats["copied"]} copied, {assets.stats["resized"]} resized, {assets.stats["kept"]} unchanged)')
        if max_width and not tool:
            print('note: no resize tool (sips/magick/convert) found; images copied at full size')
        print('site ->', os.path.join(stats['out'], 'index.html'))
    return stats
