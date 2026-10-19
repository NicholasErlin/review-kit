"""Plain-text / Markdown progress summary of a review.json (for status updates and hand-off messages)."""
import re

from . import model

RESOLVED = ('fixed', 'notabug', 'wontfix')


def _plain(s):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>|[*`~]', '', s or '')).strip()


def summarise(data, open_limit=8, markdown=True):
    plats = model.platforms(data)
    sevs = model.severities(data)
    pl_label = {p['id']: p.get('label') or p['id'] for p in plats}
    issues = [i for i in data.get('issues') or [] if i.get('counted', True)]
    fixes = data.get('fixes') or []
    b = '**' if markdown else ''
    lines = []
    name = data['project']['name'] + ' ' + data['project'].get('title', 'Review')
    lines.append(('# ' if markdown else '') + name)

    def counts(lst):
        c = {s: 0 for s in model.ISSUE_STATUSES}
        for i in lst:
            c[i.get('status', 'open')] += 1
        return c

    c = counts(issues)
    done = sum(c[s] for s in RESOLVED)
    pct = round(100 * (done + c['partial'] / 2) / len(issues)) if issues else 0
    lines.append(f'{b}Issues:{b} {len(issues)} total, {c["fixed"]} fixed, {c["partial"]} partly fixed, {c["open"]} open'
                 + (f', {c["notabug"]} not a bug' if c['notabug'] else '') + (f", {c['wontfix']} won't fix" if c['wontfix'] else '')
                 + f' ({pct}% done)')
    rows = []
    for s in sevs + [{'id': None, 'label': 'unranked'}]:
        lst = [i for i in issues if i.get('severity') == s['id']]
        if lst:
            cc = counts(lst)
            rows.append(f'{s.get("label") or s["id"]}: {sum(cc[x] for x in RESOLVED)}/{len(lst)} resolved, {cc["partial"]} partial, {cc["open"]} open')
    if rows:
        lines.append(f'{b}By severity:{b} ' + '; '.join(rows))
    if len(plats) > 1:
        rows = []
        for p in plats:
            lst = [i for i in issues if (i.get('platform') or plats[0]['id']) == p['id']]
            cc = counts(lst)
            rows.append(f'{pl_label[p["id"]]}: {sum(cc[x] for x in RESOLVED)}/{len(lst)} resolved')
        lines.append(f'{b}By platform:{b} ' + '; '.join(rows))
    pairs = sum(len(p.get('pairs') or []) for f in fixes for p in (f.get('platforms') or {}).values())
    lines.append(f'{b}Fixes:{b} {len(fixes)} shipped, {pairs} before/after comparisons')
    for f in fixes[-5:][::-1]:
        num = f'#{f["number"]} ' if f.get('number') is not None else ''
        lines.append(f'- {num}{f["title"]}' + (f' ({f["date"]})' if f.get('date') else '')
                     + (f' addresses {", ".join(f["issues"])}' if f.get('issues') else ''))
    sev_rank = {s['id']: n for n, s in enumerate(sevs)}
    left = sorted((i for i in issues if i.get('status', 'open') in ('open', 'partial')),
                  key=lambda i: (sev_rank.get(i.get('severity'), 99), i.get('status') != 'partial'))
    if left:
        lines.append(f'{b}Left to do ({len(left)}), most severe first:{b}')
        for i in left[:open_limit]:
            sev = i.get('severity') or 'unranked'
            plat = f' [{pl_label.get(i.get("platform"), i.get("platform"))}]' if len(plats) > 1 and i.get('platform') else ''
            lines.append(f'- {sev} {i["id"]}{plat}: {_plain(i["title"])}' + (' (partly fixed)' if i.get('status') == 'partial' else ''))
        if len(left) > open_limit:
            lines.append(f'- ... and {len(left) - open_limit} more')
    items = [it for g in data.get('plan') or [] for it in g.get('items') or []]
    if items:
        pc = {}
        for it in items:
            pc[it.get('status', 'todo')] = pc.get(it.get('status', 'todo'), 0) + 1
        lines.append(f'{b}Plan:{b} {len(items)} items: ' + ', '.join(f'{v} {k}' for k, v in sorted(pc.items())))
    return '\n'.join(lines)
