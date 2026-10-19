"""review-kit attach: set a repository up for review-kit in one step.

Creates (or reuses) the review folder and adds a short pointer to the repo's agent instructions file, so any
coding agent working there knows to use the review-kit skill. The pointer sits between markers and is
replaced in place on later runs, so attach can be re-run safely.
"""
import os
import re

from . import edit, model

BEGIN = '<!-- review-kit:begin -->'
END = '<!-- review-kit:end -->'
INSTALL = 'curl -fsSL https://raw.githubusercontent.com/NicholasErlin/review-kit/main/install.sh | bash'
REVIEW_DIRS = ('.review', 'docs/review', 'review', '.')


def pointer(review_rel):
    return f"""{BEGIN}
## Review tracking (review-kit)

When fixing UI/UX issues or working through a multi-step list of fixes here, record the work with review-kit:
issues found, fixes shipped with before/after screenshots, and what is left. The review lives in
`{review_rel}/review.json`.

Before starting, read the review-kit skill: run `review-kit home` and open `skill/review-kit/SKILL.md` in the
folder it prints. If `review-kit` is not installed, install it with:

    {INSTALL}
{END}
"""


def find_existing(repo):
    for d in REVIEW_DIRS:
        p = os.path.join(repo, d, 'review.json')
        if os.path.isfile(p):
            return p
    return None


def _write_pointer(path, block):
    """Insert or replace the marked block. Returns 'created', 'updated', 'added' or 'unchanged'."""
    if not os.path.exists(path):
        with open(path, 'w', encoding='utf-8') as f:
            f.write(block)
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
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new)
    return state


def attach(repo='.', directory='.review', name=None, title='Review', platforms=('mobile', 'desktop'),
           ignore_screenshots=False, accent=None, agent_files=None):
    """Returns a list of human-readable lines describing what was done.

    agent_files=None means AGENTS.md, plus CLAUDE.md when the repo already has one. Pass [] to skip.
    """
    repo = os.path.abspath(repo)
    if not os.path.isdir(repo):
        raise model.ReviewError(f'{repo}: no such directory')
    log = []
    review = find_existing(repo)
    if review:
        log.append(f'using existing {os.path.relpath(review, repo)}')
    else:
        review = edit.init(os.path.join(repo, directory), name or os.path.basename(repo), title, platforms,
                           ignore_screenshots, accent)
        log.append(f'created {os.path.relpath(review, repo)} (+ screenshots/, pending/, .gitignore)')
    review_rel = os.path.relpath(os.path.dirname(review), repo).replace(os.sep, '/')

    if agent_files is None:
        agent_files = ['AGENTS.md'] + (['CLAUDE.md'] if os.path.isfile(os.path.join(repo, 'CLAUDE.md')) else [])
    block = pointer(review_rel)
    for name_ in agent_files:
        state = _write_pointer(os.path.join(repo, name_), block)
        log.append(f'{name_}: review-kit pointer {state}')
    return log
