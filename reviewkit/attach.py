"""review-kit attach: set a repository up for review-kit in one step.

Creates (or reuses) one review folder per kind (UI/UX, backend) and adds a short pointer to the repo's agent instructions file, so any
coding agent working there knows to use the review-kit skill. The pointer sits between markers and is
replaced in place on later runs, so attach can be re-run safely.
"""
import os
import re

from . import companions, edit, model
from .model import ReviewError

BEGIN = '<!-- review-kit:begin -->'
END = '<!-- review-kit:end -->'
INSTALL = 'curl -fsSL https://raw.githubusercontent.com/NicholasErlin/review-kit/main/install.sh | bash'
LEGACY_DIRS = ('.review', 'docs/review', 'review', '.')
KIND_DEFAULTS = {
    'ui': {'title': 'UI/UX review', 'platforms': ['mobile', 'desktop'], 'label': 'UI/UX'},
    'backend': {'title': 'Backend review', 'platforms': ['default'], 'label': 'Backend practices'},
}


def pointer(reviews):
    """reviews: [(kind, review_rel_dir)]"""
    rows = '\n'.join(f'- {KIND_DEFAULTS[k]["label"]}: `{rel}/review.json`' for k, rel in reviews)
    return f"""{BEGIN}
## Review tracking (review-kit)

When reviewing or fixing this repo across several steps, record the work with review-kit: issues found, fixes
shipped with their evidence (before/after screenshots for UI, code and test output for backend), and what is
left. A review run only reports problems; apply fixes only for the issues the user approves. The reviews live in:

{rows}

Before starting, read the review-kit skill: run `review-kit home` and open `skill/review-kit/SKILL.md` in the
folder it prints. It points to a playbook per review kind. If `review-kit` is not installed, install it with:

    {INSTALL}
{END}
"""


def kind_of(path):
    try:
        return model.load(path)['project'].get('kind', 'ui')
    except (ReviewError, KeyError, TypeError):
        return None


def find_existing(repo, kind='ui', base='.review'):
    p = os.path.join(repo, base, kind, 'review.json')
    if os.path.isfile(p):
        return p
    for d in LEGACY_DIRS:
        p = os.path.join(repo, d, 'review.json')
        if os.path.isfile(p) and kind_of(p) == kind:
            return p
    return None


def _write_pointer(path, block):
    """Insert or replace the marked block. Returns 'created', 'updated', 'added' or 'unchanged'."""
    if not os.path.exists(path):
        model.write_text(path, block)
        return 'created'
    with open(path, encoding='utf-8') as f:
        old = f.read()
    if BEGIN in old and END in old:
        new = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?', lambda _: block, old, count=1, flags=re.S)
        state = 'updated'
    else:
        new = old + ('' if old.endswith('\n') or not old else '\n') + ('\n' if old else '') + block
        state = 'added'
    if new == old:
        return 'unchanged'
    model.write_text(path, new)
    return state


def attach(repo='.', kinds=('ui',), directory='.review', name=None, title=None, platforms=None,
           ignore_screenshots=False, accent=None, agent_files=None):
    """Create (or reuse) one review per kind under <directory>/<kind>/. Returns human-readable log lines.

    title and platforms override the kind's defaults (platforms only apply to UI reviews).
    agent_files=None means AGENTS.md, plus CLAUDE.md when the repo already has one. Pass [] to skip.
    """
    repo = os.path.abspath(repo)
    if not os.path.isdir(repo):
        raise ReviewError(f'{repo}: no such directory')
    kinds = list(dict.fromkeys(kinds)) or ['ui']
    for k in kinds:
        if k not in KIND_DEFAULTS:
            raise ReviewError(f'unknown review kind {k!r}; expected one of {", ".join(KIND_DEFAULTS)}')
    log, reviews = [], []
    for k in kinds:
        review = find_existing(repo, k, directory)
        if review:
            log.append(f'{k}: using existing {os.path.relpath(review, repo)}')
        else:
            d = KIND_DEFAULTS[k]
            plats = (platforms if platforms and k == 'ui' else None) or d['platforms']
            review = edit.init(os.path.join(repo, directory, k), name or os.path.basename(repo),
                               (title if title and len(kinds) == 1 else None) or d['title'], plats,
                               ignore_screenshots, accent, kind=k)
            log.append(f'{k}: created {os.path.relpath(review, repo)} (+ screenshots/, pending/, .gitignore)')
        reviews.append((k, os.path.relpath(os.path.dirname(review), repo).replace(os.sep, '/')))
        missing = [c['name'] for _, c, path in companions.status([k], repo) if not path]
        if missing:
            log.append(f'{k}: companion skills not found: {", ".join(missing)} '
                       f'(optional; `review-kit companions install --kind {k}` adds them)')

    for k in KIND_DEFAULTS:  # keep reviews of other kinds in the pointer
        existing = None if k in kinds else find_existing(repo, k, directory)
        if existing:
            reviews.append((k, os.path.relpath(os.path.dirname(existing), repo).replace(os.sep, '/')))
    reviews.sort(key=lambda r: list(KIND_DEFAULTS).index(r[0]))

    if agent_files is None:
        agent_files = ['AGENTS.md'] + (['CLAUDE.md'] if os.path.isfile(os.path.join(repo, 'CLAUDE.md')) else [])
    block = pointer(reviews)
    for name_ in agent_files:
        state = _write_pointer(os.path.join(repo, name_), block)
        log.append(f'{name_}: review-kit pointer {state}')
    return log
