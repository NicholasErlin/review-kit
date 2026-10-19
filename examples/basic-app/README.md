# Basic app example: Pocket Tasks

This example runs the whole review-kit loop on a real, if tiny, web app. `app/` is a task list with a few deliberate UX bugs. `run.sh` audits it, fixes it one patch at a time with before/after screenshots, and builds the review site. The result is committed in `review/`, so you can look at it without running anything:

```bash
review-kit serve examples/basic-app/review       # or open review/site/index.html after `review-kit build`
```

## What is in here

```
app/                   Pocket Tasks: index.html, style.css, app.js (the original, buggy version)
fixes/                 one patch per fix, applied in order
  fix1-add-form-fits-phones.patch
  fix2-readable-done-tasks.patch
  fix3-centred-column.patch
run.sh                 the walkthrough: audit, fix, record, build (`./run.sh clean` tidies up)
review/                its output: review.json and screenshots/ (site/ is gitignored)
```

## Run it yourself

You need Node.js 18+, the kit built from this repository (`npm install && npm run build`), and Playwright with Chromium:

```bash
PLAYWRIGHT_PATH=/path/to/node_modules/playwright examples/basic-app/run.sh
```

If you don't have Playwright anywhere yet, `npm i playwright && npx playwright install chromium` in any folder gives you one.

The script deletes `review/` and rebuilds it from scratch, so the run is repeatable. It never changes `app/`. It copies the app to a temporary folder, serves that copy on a free local port, and patches it there. The `EXIT` trap stops the server and deletes the copy, even if a step fails.

## What the script does

Each step is an ordinary `review-kit` command, so the script doubles as a worked example of the [workflow](../../docs/workflow.md).

1. **Set up.** `review-kit init review --platforms mobile,desktop --accent "#2f5d50"`.
2. **Audit.** It screenshots the app at 412x915 (mobile) and 1440x900 (desktop), then records six issues with `add-issue`. Each issue has a severity, an area, Markdown details and a `file:line` location.
3. **Fix 1, recorded from the command line.** Before shot, then `patch`, then after shot, then `add-fix --pair mobile before after --resolves m-1`.
4. **Fix 2, recorded through a hand-off file.** This is how a parallel fix agent reports its work. The script writes `review/pending/fix2.json` (a fix plus `marks` for `m-2` and `d-1`), and `apply-pending` merges it.
5. **Fix 3.** The same steps as fix 1, for the desktop layout.
6. **Triage and build.** `mark notabug d-3` with a reason, `add-plan` for the remaining issue, `clean --keep-site` to drop the merged `fix2.applied.json`, then `build` and `summary`.

The result has 6 issues: 4 fixed, 1 not a bug and 1 left open with a plan item. There are 3 fixes and 4 before/after comparisons.

| Issue | Platform | Severity | Outcome |
| --- | --- | --- | --- |
| Add task button is cut off on phones | mobile | P0 | fixed by #1 |
| Completed tasks are almost invisible | mobile, desktop | P1 | fixed by #2 (hand-off) |
| Task list stretches across the whole screen | desktop | P2 | fixed by #3 |
| Delete is a tiny × with no confirmation | mobile | P2 | open, planned under "Next" |
| Tasks are gone after a reload | desktop | P2 | not a bug (in-memory by design) |

## Cleaning up

```bash
examples/basic-app/run.sh clean          # same as: review-kit clean examples/basic-app/review --orphans
```

This removes the built `review/site/`, any merged `pending/*.applied.json`, and any screenshot that `review.json` no longer references. It does not touch `review.json` or any screenshot still in use. Add `--dry-run` to the `review-kit clean` form to see the list first.

## Using it as a template

To try the loop on your own app, copy `run.sh` and change four things:

- `app/` and the `URL`: point at your dev server instead of the scratch copy.
- `shot`: set the viewports, and the `--steps` or `--storage` your pages need (see `review-kit shot -h`).
- `fix`: replace `patch` with your actual code changes. In practice you or an agent edit the code between the before and after shots.
- The `add-issue` and `add-fix` text.
