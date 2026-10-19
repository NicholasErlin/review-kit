"""Companion skills: the third-party agent skills each review kind leans on.

A UI/UX review uses ui-ux-pro-max for its UX rules; a backend review uses a few of the backend skills from
wshobson/agents. Both are MIT licensed and bundled in skill/companions/ (each folder keeps its upstream LICENSE
and a SOURCE file with the commit it came from). `review-kit companions` reports where they are installed,
`review-kit companions install` links the bundled copies into skills folders, and `review-kit companions update`
(for maintainers) refreshes the bundle from the pinned commits.
"""
import glob
import io
import os
import shutil
import tarfile
import urllib.request

from . import model
from .model import ReviewError

KINDS = ('ui', 'backend')

# The commits the bundle was taken from. Bump deliberately, then run `review-kit companions update`.
SOURCES = {
    'nextlevelbuilder/ui-ux-pro-max-skill': '56ea9cf174ed86786187daa9de0e6247cb0747e4',
    'wshobson/agents': '0874a27b17a22e2b7c2e2bcd725768e0803cad06',
}

COMPANIONS = {
    'ui': [
        {'name': 'ui-ux-pro-max', 'repo': 'nextlevelbuilder/ui-ux-pro-max-skill',
         'path': '.claude/skills/ui-ux-pro-max',
         'use': 'UX rules (accessibility, touch, layout, type, forms, navigation) to ground and rank UI issues'},
    ],
    'backend': [
        {'name': 'api-design-principles', 'repo': 'wshobson/agents',
         'path': 'plugins/backend-development/skills/api-design-principles',
         'use': 'HTTP/CLI interface design: resources, status codes, errors, versioning, pagination'},
        {'name': 'architecture-patterns', 'repo': 'wshobson/agents',
         'path': 'plugins/backend-development/skills/architecture-patterns',
         'use': 'layering, dependency direction, module boundaries'},
        {'name': 'error-handling-patterns', 'repo': 'wshobson/agents',
         'path': 'plugins/developer-essentials/skills/error-handling-patterns',
         'use': 'error propagation, failure modes, retries, graceful degradation'},
    ],
}

BUNDLE = os.path.join(model.ROOT, 'skill', 'companions')
SKIP = ('scripts/tests/',)  # upstream test suites aren't needed to use the skill
MAX_DOWNLOAD = 200 * 1024 * 1024


def skill_dirs(repo='.'):
    """Folders where agents commonly keep skills, user-wide and per repo."""
    home = os.path.expanduser('~')
    dirs = [os.path.join(home, d) for d in ('.claude/skills', '.agents/skills', '.codex/skills', '.cursor/skills')]
    dirs += [os.path.join(os.path.abspath(repo), d) for d in ('.claude/skills', '.agents/skills')]
    return dirs


def find(name, repo='.', bundle=None):
    """Path to the companion's SKILL.md: an installed copy if there is one, else the bundled copy."""
    for d in skill_dirs(repo):
        p = os.path.join(d, name, 'SKILL.md')
        if os.path.isfile(p):
            return p
    plugins = os.path.expanduser('~/.claude/plugins')
    for pattern in ('*/*/plugins/*/skills/%s/SKILL.md', '*/*/*/skills/%s/SKILL.md', '*/*/skills/%s/SKILL.md'):
        hits = sorted(glob.glob(os.path.join(plugins, pattern % name)))
        if hits:
            return hits[0]
    p = os.path.join(bundle or BUNDLE, name, 'SKILL.md')
    return p if os.path.isfile(p) else None


def status(kinds=KINDS, repo='.'):
    """[(kind, companion, path or None)]"""
    return [(k, c, find(c['name'], repo)) for k in kinds for c in COMPANIONS[k]]


def _wanted(kinds):
    out = {}
    for k in kinds:
        if k not in COMPANIONS:
            raise ReviewError(f'unknown review kind {k!r}; expected one of {", ".join(KINDS)}')
        for c in COMPANIONS[k]:
            out.setdefault(c['repo'], []).append(c)
    return out


def _link(src, skills_dir):
    """Link a bundled skill into skills_dir. Never replaces a skill the user installed some other way."""
    target = os.path.join(skills_dir, os.path.basename(src))
    if os.path.islink(target):
        real = os.path.realpath(target)
        if real == os.path.realpath(src):
            return 'already linked'
        if not real.startswith(os.path.realpath(model.ROOT) + os.sep) and os.path.exists(target):
            return 'left alone (links elsewhere)'
        os.remove(target)  # an older review-kit link, or a dangling one
    elif os.path.exists(target):
        return 'left alone (already installed)'
    os.makedirs(skills_dir, exist_ok=True)
    os.symlink(src, target)
    return 'linked'


def install(kinds=KINDS, skills_dirs=None, bundle=None):
    """Link the bundled companions for `kinds` into skills folders. Returns log lines."""
    bundle = bundle or BUNDLE
    if skills_dirs is None:
        claude = os.path.expanduser('~/.claude')
        skills_dirs = [os.path.join(claude, 'skills')] if os.path.isdir(claude) else []
    log = []
    for comps in _wanted(kinds).values():
        for c in comps:
            src = os.path.join(bundle, c['name'])
            if not os.path.isfile(os.path.join(src, 'SKILL.md')):
                raise ReviewError(f"{src}: bundled skill missing; run `review-kit companions update`")
            log.append(f"{c['name']}:")
            for d in skills_dirs:
                log.append(f"  {d}: {_link(src, d)}")
    if not skills_dirs:
        log.append(f'no skills folder given; agents can read the skills in {bundle} (`review-kit companions` shows the paths)')
    return log


# ---------------------------------------------------------------- maintainers: refresh the bundle
def _download(repo, sha, opener=urllib.request.urlopen, limit=MAX_DOWNLOAD):
    url = f'https://codeload.github.com/{repo}/tar.gz/{sha}'
    try:
        with opener(url, timeout=60) as r:
            blob = r.read(limit + 1)
    except OSError as e:
        raise ReviewError(f'could not download {url}: {e}')
    if len(blob) > limit:
        raise ReviewError(f'{url}: larger than {limit // (1024 * 1024)} MB; refusing')
    return blob


def _extract(blob, companions, dest, repo, sha, license_text=None):
    """Extract only the companion folders, refusing anything that could land outside them."""
    try:
        tar = tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz')
        members = tar.getmembers()
    except (tarfile.TarError, OSError, EOFError) as e:
        raise ReviewError(f'{repo}: download is not a valid archive: {e}')
    with tar:
        top = members[0].name.split('/')[0] if members else ''
        lic = next((m for m in members if m.name == f'{top}/LICENSE' and m.isfile()), None)
        if lic is not None:
            license_text = tar.extractfile(lic).read()
        for c in companions:
            prefix = f"{top}/{c['path'].strip('/')}/"
            out = os.path.join(dest, c['name'])
            tmp = out + '.partial'
            shutil.rmtree(tmp, ignore_errors=True)
            found = False
            for m in members:
                if not m.name.startswith(prefix):
                    continue
                rel = m.name[len(prefix):]
                parts = rel.split('/')
                if not rel or os.path.isabs(rel) or '..' in parts or any(rel.startswith(s) for s in SKIP):
                    continue
                target = os.path.join(tmp, *parts)
                if m.isdir():
                    os.makedirs(target, exist_ok=True)
                elif m.isfile():
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with tar.extractfile(m) as src, open(target, 'wb') as f:
                        shutil.copyfileobj(src, f)
                    found = found or rel == 'SKILL.md'
                # links, devices and fifos are skipped
            if not found:
                shutil.rmtree(tmp, ignore_errors=True)
                raise ReviewError(f"{repo}: {c['path']}/SKILL.md not found in the download")
            if license_text and not os.path.exists(os.path.join(tmp, 'LICENSE')):
                with open(os.path.join(tmp, 'LICENSE'), 'wb') as f:
                    f.write(license_text)
            with open(os.path.join(tmp, 'SOURCE'), 'w', encoding='utf-8') as f:
                f.write(f"https://github.com/{repo}/tree/{sha}/{c['path']}\n"
                        'Bundled by review-kit; refresh with `review-kit companions update`.\n')
            shutil.rmtree(out, ignore_errors=True)
            os.rename(tmp, out)


def update(kinds=KINDS, bundle=None, opener=urllib.request.urlopen):
    """Re-download the pinned commits into the bundle. Returns log lines."""
    bundle = bundle or BUNDLE
    os.makedirs(bundle, exist_ok=True)
    log = []
    for repo, comps in _wanted(kinds).items():
        sha = SOURCES[repo]
        _extract(_download(repo, sha, opener), comps, bundle, repo, sha)
        log += [f"{c['name']}: refreshed from {repo}@{sha[:7]}" for c in comps]
    return log
