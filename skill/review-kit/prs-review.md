# Pull request dashboard playbook

Use `project.kind: "prs"` for one dashboard across GitHub repositories. It supports **mine** (getting your PRs merged) and **reviewing** (reviewing other people's changes). Requires Node 18+ and an authenticated GitHub CLI (`gh auth status`). No GitHub token is stored in the review.

## Keep the board accurate

```sh
rk init .review/prs --kind prs --name "My PRs"
rk pr add --mine
rk pr add --requested
rk pr add acme/web#142 --priority 1 --next "Diagnose failing CI"
rk pr add https://github.com/acme/api/pull/88 --reviewing
rk pr sync
rk pr list
rk summary prs
rk build prs
rk serve prs --sync-prs 5
```

Every `pr` command finds the PR review automatically, or accepts `-r prs` / `--review path/to/review.json`. Discovery accepts repeated `--repo owner/name`. Sync preserves role, priority, next, notes, dependencies, findings and the draft verdict. Closed and merged entries stay on the board; `sync --all` refreshes them too. Set dependencies with `rk pr set <id> --depends other-id,another-id`. Record a concrete next step for each open PR.

Read the blockers, diff and conversation. Diagnose CI using read-only `gh run view <runId> -R owner/repo --log-failed`, and read surrounding code when needed. Report what prevents merging in plain words. You may add, sync, set next/notes and read logs without asking. **Do not comment, reply, resolve/unresolve, merge, close/reopen, rerun, update the branch, mark ready/draft, or request reviewers without the user's explicit word for that PR.**

Fix PR code only after approval, in a separate worktree: create one with `git worktree add`, then run `gh pr checkout` inside that worktree. Never check out the PR in the user's current checkout. Push only on the user's word. Do not create a branch or worktree simply to refresh the dashboard.

## Reviewing mode

Read the entire diff and the code in context. If tests help, run them in a separate worktree. Record specific, kind findings with a suggested fix and the exact wording proposed for GitHub:

```sh
rk pr finding acme-web-150 --title "Encode the coupon" --body 'Please use encodeURIComponent(code) so a slash stays inside the code.' --path src/cart/applyCoupon.ts --line 5 --severity P1
rk pr verdict acme-web-150 --event REQUEST_CHANGES --body 'Please fix the URL encoding before merging.'
```

Findings default to unflagged drafts. **Never set `ship` yourself unless the user says which findings to send. Never run `rk pr ship` without the user's explicit word for that PR.** A suggested verdict is a draft, not permission to send it. Show the proposed findings and let the user choose. Record their choice with `rk pr flag <id> f-1,f-3` (`--off` unflags). Edit using `finding <id> --update --finding f-1 ...`, or drop with `finding <id> --drop f-1`.

`rk pr ship <id> --dry-run` prints the JSON proposed for one GitHub review. After explicit approval, `rk pr ship <id>` posts flagged draft findings plus the verdict together. Already posted and dropped findings are excluded. Findings remember their head SHA: stale or missing locations are retained in the review body with a note, never silently discarded. Re-check them before shipping. Approval and request-changes verdicts on your own PR are refused. Shipping requires at least a flagged finding or a verdict body.

## Live and offline use

Loopback `rk serve` enables live actions with a token, same-origin requests and a 64 KB JSON limit. The site offers sync, comment, thread reply/resolve, CI rerun, branch update, ready/draft, reviewer requests, merge, close/reopen and notes editing. Destructive actions show the exact command first; shipping always previews the complete JSON. Findings can be drafted at a diff line and flagged individually. The sticky review bar shows how many will ship. Keyboard: j/k next/previous PR, o GitHub, s sync, ? help; typing fields are excluded.

Built pages work from disk with no fetch and `connect-src 'none'`. They offer standalone `gh` commands, including the complete JSON here-document for a review. Offline edits/flags are temporary browser state and are lost on reload; persist drafts with the CLI. `serve --host 0.0.0.0` disables actions. `--allow-remote-actions` explicitly overrides the binding restriction and prints a warning, but non-loopback Host headers remain forbidden by the API contract. Background sync is opt-in (`--sync-prs <minutes>`), and open live pages show an update/reload notice.

Review JSON and generated sites must contain relative asset paths. Before sharing, inspect PR text, findings and diffs for sensitive information; synced private PR contents become part of the dashboard.
