# Workflow: review, fix, show the difference

This guide is for a person or a coding agent that is working through a list of UI/UX or multi-step fixes and wants a reviewable record of the work.

Reviews work in two phases. First audit and report: record issues, build the site and summarise, without changing the project. Then fix only what the user approves. Steps 1, 2 and 6 are the report phase; steps 3 to 5 run only after approval.

The steps below use a UI/UX review, where the evidence is screenshots. A backend review follows the same steps with code evidence instead; see [Backend reviews](#backend-reviews). Deciding what to build, and which way, comes before any of this; see [Ideas, designs and adopting](#ideas-designs-and-adopting) at the end.

## 1. Set up

```bash
review-kit init .review --name "App" --title "UX review" --platforms mobile,desktop [--ignore-screenshots]
```

`review-kit attach --kind ui` (or `--kind ui,backend`) creates `.review/<kind>/` for each kind and also adds a review-kit pointer to the repo's `AGENTS.md` (and `CLAUDE.md` if present), so every agent working in the repo finds the skill. Use it when the setup should stay with the repo.

- Keep the review in `.review/` (or `docs/review/` if it should be visible in the repo). The built `site/` folder is always gitignored.
- Screenshots are usually 50–300 KB each. Commit them if the review should travel with the repo. Pass `--ignore-screenshots` for long audits or public repos. Converting to JPEG keeps the files small: `sips -s format jpeg -s formatOptions 72 --resampleWidth 480 in.png --out out.jpg` on macOS, or `--max-width` at build time.
- Pick platforms that match how the app is checked: `mobile,desktop`, `web`, or `ios,android`. Define custom severities in `review.json` if P0–P2 do not fit.

## 2. Record issues while you audit

```bash
review-kit add-issue --platform mobile --area settings --severity P1 \
  --title "Delete has no confirmation" --details "Tapping **Delete** removes the item at once." \
  --where "src/settings/Danger.tsx:42" --screenshot /tmp/shots/settings-delete.png
```

A few habits help the site later:

- Write one issue per problem.
- Keep titles short and plain; put details in Markdown.
- Use `--top` for the handful of issues that matter most.
- Mark a shared underlying cause as `--severity none --tags root-cause`.

## 3. Capture before/after evidence

1. Capture the **before** screenshot before you edit any code, at each viewport you will verify, for example `mobile` (412x915) and `desktop` (1440x900).
2. Make the fix.
3. Capture the **after** screenshot with the same URL, viewport, data and steps, so the two images line up in the slider.

```bash
SHOT="review-kit shot"
$SHOT --url http://localhost:3000/settings --viewport mobile  --out .review/screenshots/fix-3/settings-mobile-before.png --steps open-danger.mjs
# ... edit code ...
$SHOT --url http://localhost:3000/settings --viewport mobile  --out .review/screenshots/fix-3/settings-mobile-after.png  --steps open-danger.mjs
```

`open-danger.mjs` contains `export default async (page) => { await page.getByRole('button', { name: 'Delete' }).click(); }`.

If the project has no Playwright, try `npx playwright` (it may need `npx playwright install chromium`), the project's own e2e tooling, a simulator or emulator screenshot (`xcrun simctl io booted screenshot`, `adb exec-out screencap -p`), or screenshots the user provides. Name the files `<page>-<platform>-before|after.<ext>`.

## 4. Record the fix

```bash
review-kit add-fix --title "Confirm before deleting" --summary "Delete opens an in-app confirmation; Cancel keeps the item." \
  --files src/settings/Danger.tsx,src/ui/ConfirmDialog.tsx \
  --pair mobile  .review/screenshots/fix-3/settings-mobile-before.png  .review/screenshots/fix-3/settings-mobile-after.png \
  --pair desktop .review/screenshots/fix-3/settings-desktop-before.png .review/screenshots/fix-3/settings-desktop-after.png \
  --resolves m-7 --partial d-4
```

Use `review-kit mark notabug d-9 --note "works as designed: ..."` for findings that turn out to be fine after investigation.

## 5. Parallel fix agents (hand-off pattern)

Agents working at the same time must not edit `review.json` concurrently. Each fix agent writes **one** JSON file, and the orchestrator merges them:

1. Before starting the agents, the orchestrator gives each one a fix key such as `fix7` and lists the issue ids it owns.
2. Each agent:
   - captures its before screenshots into `.review/screenshots/<fixkey>/`;
   - makes the fix;
   - captures the after screenshots;
   - writes `.review/pending/<fixkey>.json`, either as an envelope (see [format.md](format.md#hand-off-envelope-pendingjson)) or as a bare fix object.

   Example:

   ```json
   {
     "fix": {
       "title": "Transaction tables no longer overlap",
       "summary": "Explicit column widths; dates wrap to two lines.",
       "files": ["src/table/DataTable.tsx"],
       "platforms": {
         "desktop": {
           "description": "1440x900, Manage Transactions",
           "pairs": [{
             "before": { "src": "screenshots/fix7/tx-desktop-before.png", "caption": "Date runs into Scope." },
             "after":  { "src": "screenshots/fix7/tx-desktop-after.png",  "caption": "Columns sized; no overlap." }
           }]
         }
       }
     },
     "marks": [
       { "issue": "d-14", "status": "fixed",   "note": "Explicit widths." },
       { "issue": "m-5",  "status": "partial", "note": "Phone list still truncates." }
     ],
     "issues": [ { "id": "d-40", "title": "Found while fixing: sort arrow misaligned", "platform": "desktop", "severity": "P2" } ]
   }
   ```

3. The orchestrator runs `review-kit apply-pending`. The files are merged in natural order (`fix2` before `fix10`) and each one is renamed to `*.applied.json`. Merge order decides the fix numbers, so start agents in the order you want them numbered, or set `"number"` explicitly. A file that fails validation, including a wrongly shaped hand-off (for example `invalid hand-off: issues: expected a list`), stops the merge and stays in `pending/` so it can be fixed.

## 6. Build, serve, summarise, clean up

```bash
review-kit build                     # .review/site/index.html (also fine to open directly)
nohup review-kit serve --port 8787 --watch > /tmp/review-kit.log 2>&1 & disown   # survives the shell / tool call
cat /tmp/review-kit.log              # localhost URL; local access only by default
review-kit summary                   # Markdown summary for a status update or PR description
```

With a single review the site is `site/` next to its `review.json`. When `.review/` holds several reviews (`ui/` and `backend/`), `build` and `serve` with no argument build **one site for all of them** in `.review/site/`, with a UI/UX / Backend switch in the header and an overview of both. `build ui` (or a path) still builds one review on its own, and `--out` picks another folder. `--watch` then rebuilds when any of the reviews changes.

For a phone preview, explicitly enable network sharing with `--host 0.0.0.0`, then use the LAN or Tailscale URL from the log. Anyone who can reach that port can read the review; use an authenticated host for private remote reviews.

`--watch` rebuilds the site when `review.json` or `screenshots/` change. Browsers pick up changes on reload because `index.html` and `data.js` are served with `Cache-Control: no-cache` and every asset carries a content hash. Publish only the generated site folder after checking review text, screenshots and attachments for private information. If the builder finds unexpected files or symlinks in the output, use a fresh `--out` folder; it leaves the existing files untouched. Keep Playwright `--storage` session files outside published output and out of Git.

When a round is finished, `review-kit clean` removes the built `site/` and the merged `pending/*.applied.json` files (with several reviews: each review's and the combined `.review/site/`). `review-kit clean --orphans` also deletes screenshots that `review.json` no longer references, for example retakes or files from a fix you dropped. Screenshots that unmerged `pending/*.json` files reference are kept. If a pending file can't be read, `--orphans` stops without deleting anything. Add `--dry-run` to see the list first. `clean` only removes a site folder that review-kit built, and it never edits `review.json`.

[`examples/basic-app/run.sh`](../examples/basic-app/run.sh) runs every step of this guide on a small app.

## Backend reviews

A review with `project.kind: "backend"` covers code practices instead of screens. Set it up with `review-kit init .review/backend --kind backend`, or with `review-kit attach --kind backend`. The agent playbook is [`skill/review-kit/backend-review.md`](../skill/review-kit/backend-review.md). It has the checklist (security, correctness, errors, interface design, data, architecture, performance, tests, operability) and the severity table.

- **Areas** are modules or layers. Give every issue `--where path:line`.
- **Fixes** have no screenshot pairs. Put the proof in the summary: what was wrong, what changed, and a test that fails before and passes after, or a command with its output, in a fenced code block.

```bash
review-kit add-issue backend --area serve --severity P1 --where "app/serve.py:88" \
  --title "Request body read without a size limit" --details "A 2 GB POST exhausts memory."
review-kit add-fix backend --title "Cap request bodies at 10 MB" --files app/serve.py,tests/test_serve.py \
  --summary $'**Proof.** `test_upload_limit` fails before, passes after:\n\n```\n$ python3 -m unittest tests.test_serve\nOK\n```' \
  --resolves issue-1
```

Optional companion skills back each kind's checklist with rules to cite: ui-ux-pro-max for UI, and three wshobson/agents skills for backend. They ship with the kit: `review-kit companions` shows where they are, and `review-kit companions install` links them into `~/.claude/skills`.

## Ideas, designs and adopting

Two more kinds cover the work before a review: `ideas` decides what is worth building, and `design` decides which way to build it. Set them up with `review-kit attach --kind ideas,design`. The agent playbooks are [`ideas-review.md`](../skill/review-kit/ideas-review.md) and [`design-review.md`](../skill/review-kit/design-review.md).

The flow is ideas → design → adopt → UI/backend review. Each step ends with a report, and the next one starts only when the user says so.

### 1. Ideas: research, then reason

1. Write the question, goal, users, constraints and what success looks like in the review description.
2. Research first: the codebase, the project's docs and issues, official docs and standards, credible studies, and comparable products. Record each finding with at least one source a reader can open, an accessed date for web sources, a short quote or number, and a confidence. Keep facts apart from inference, record counter-evidence, and never invent a source.
3. Generate widely, then record the strongest few ideas. Each has the problem, the proposal, the reasoning tied to research ids, the alternatives considered (including doing nothing), risks, effort, impact and confidence.
4. Report a ranked shortlist and stop. Record the user's call per idea.

```bash
review-kit add-research ideas --title "Empty states should teach the next step" --confidence medium \
  --summary "**Fact:** ... **Inference:** ..." --source "NN/g: Empty states=https://www.nngroup.com/articles/empty-state-interface-design/"
review-kit add-idea ideas --title "Teach in the empty list" --evidence r-1,r-2 --effort S --impact L --confidence high \
  --problem "..." --proposal "..." --reasoning "..." --alternatives "..." --risks "..."
review-kit decide ideas i-1 go --note "Cheapest way to test the question"
```

### 2. Design: agree criteria, build options on branches, compare

1. Write a brief for a `go` idea and agree weighted criteria with the user before building anything.
2. For each of 2-3 genuinely different options, `option new` creates the branch `design/<proposal>/<option>` and a worktree outside the repo (`<repo>.designs/<proposal>--<option>`). Build there, minimally, and commit on that branch. The user's branch is never touched.
3. Capture the same evidence for every option: the same screens, viewports, data and steps for UI, or the same test and benchmark commands for backend.
4. `option record` stores the write-up, a score and note per criterion, screenshots, and a snapshot of the branch's diff in `diffs/<proposal>--<option>.patch` (capped at 400 KB).
5. `recommend` one option, with why it wins and when another would be better. Report and stop.

```bash
review-kit add-proposal design --id first-run --title "First-run experience" --idea i-1 --brief "..." \
  --criterion "clarity=First task without help:3" --criterion "cost=Small to build and keep:2"
review-kit option new design first-run empty-state --title "Teaching empty state"
# ... build and commit in the printed worktree, run the tests, take screenshots ...
review-kit option record design first-run empty-state --summary "..." --reasoning "..." \
  --score "clarity=4:One sentence and a visible field." --score "cost=5:Two files." \
  --shot mobile /tmp/shots/empty-state-mobile.png "First run"
review-kit recommend design first-run empty-state --reasoning "..."
```

The site shows each proposal as a comparison matrix (criteria by options, with notes and weighted totals out of 100), the recommendation, and the options side by side with a platform switch, their diffs, and copy buttons for `git switch` and `review-kit adopt`.

### 3. Adopt, then review

When the user picks an option:

```bash
review-kit adopt design first-run empty-state      # squash-merge into the current branch and commit
review-kit discard design first-run --dry-run       # then without --dry-run, if the user agrees
```

- `adopt` runs only in the main checkout, not on a `design/*` branch, and refuses when there are uncommitted changes outside the review folders. `--no-commit` leaves the result staged; it never pushes.
- If the branch is gone, it applies the saved diff instead. On a conflict it stops and leaves git's state; resolve it, or undo with `git reset --merge`. After resolving by hand, `adopt --record-only` records the choice.
- `discard` removes worktrees and branches; `git worktree remove` refuses dirty worktrees unless you pass `--force`. Diffs and screenshots stay, so the site still shows every option.
- `clean` never touches worktrees, branches or diffs.

Then run a UI or backend review of the adopted change, so it gets the usual issues, fixes and before/after evidence.

## Pull request dashboard

```sh
review-kit init .review/prs --kind prs --name "My PRs"
review-kit pr add --mine --repo acme/web --repo acme/api
review-kit pr add --requested
review-kit pr add acme/web#150 --reviewing
review-kit pr sync
review-kit pr set acme-web-150 --next "Read the coupon diff" --priority 1
review-kit build prs
review-kit serve prs --sync-prs 5
```

Mine PRs show CI, conflicts, review decisions, unresolved threads and dependencies. The board filters by role, repo and text; terminal `pr list` and `summary prs` use the same derived status. Merged/closed PRs stay visible but normally stop syncing (`pr sync --all` refreshes them).

For reviewing, draft with `pr finding <id> --title ... --body ... --path src/a.ts --line 42`, suggest `pr verdict <id> --event REQUEST_CHANGES --body ...`, then let the user choose `pr flag <id> f-1,f-3`. `pr ship <id> --dry-run` prints the exact JSON; `pr ship <id>` posts one review and records which findings were sent. No finding is sent merely because it exists. Off-diff and stale findings are retained with a location note. Own-PR approval/change requests are refused.

Live actions are available only when a PR review is served on loopback. They use a per-start token, same-origin checks, a JSON body limit and serialized execution. Merge/close/rerun/update-branch confirm the exact command; ship previews all comments and the verdict. `--sync-prs` refreshes in the background, and the page offers reload when another action or sync changes the build. File pages never fetch; LAN binding disables actions and shows copyable standalone `gh` commands. `--allow-remote-actions` overrides the binding gate with a warning; API Host checks still require loopback. Offline finding edits and flags are temporary until reload; use the CLI for persistent drafts.

Agents may sync, add and diagnose freely. Outward actions, selecting ship flags, PR code changes and pushes follow the explicit approval rules in [prs-review.md](../skill/review-kit/prs-review.md). Code fixes belong in a separate worktree.
