---
name: review-kit
description: "Use when reviewing or fixing a repo in several steps and the user wants a reviewable overview of what changed (issues found, fixes shipped with evidence, what is left): UI/UX reviews with before/after screenshots, and backend practice reviews (security, correctness, errors, API design, architecture, tests) with code and test evidence. Also use when the user asks to set up a review site, audit tracker, before/after comparison, fix log or progress overview. Also use for researched ideation (ideas with cited sources and reasoning) and design proposals (2-3 options built on their own branches, scored against agreed criteria, one adopted on the user's word). Also use when coordinating several fix agents whose results should be merged into one report. Records everything in a review.json and publishes an offline, phone-friendly site with review-kit. Do not use for a single small change nobody asked to document."
---

# review-kit: issues, fixes and the evidence for each

These instructions work with any coding agent that can run shell commands and look at image files.

Run the CLI as `review-kit <command>` (written `rk` below). It needs Node.js 18+ and has no other dependencies.

- If `review-kit` is not on PATH, run it one-off with `npx @horus52/review-kit <command>`. If the user wants it installed, ask before running `npm i -g @horus52/review-kit && review-kit setup` (`setup` links this skill into `~/.claude/skills`).
- `rk home` prints the kit folder, written `$KIT` below. Longer docs are in `$KIT/docs/workflow.md` (process) and `$KIT/docs/format.md` (fields).

## Report first, fix only when told

A review run has two phases. Never merge them on your own.

1. **Report.** Audit, record every problem with `rk add-issue` (plus plan items), build the site, and give the user the `rk summary` and the site URL. Change nothing else: no edits to the project's code, config or dependencies, and no commits. For UI reviews, the screenshots you take while auditing are the "before" evidence.
2. **Apply, only when the user says so.** Fix exactly the issues the user approved, by id, severity or area, for example "fix m-1 and m-3" or "do the P0s". Record each fix with its evidence. Leave everything else open.

- "Review", "audit", "check" or "run review-kit" means phase 1 only.
- A request that already asks for fixes, such as "fix the mobile layout and show me before/after", counts as approval for those fixes only. Report anything else you notice; don't fix it.
- If you're unsure whether a fix was approved, ask.
- After phase 1, stop and wait. A good ending is: "N issues recorded (x P0, y P1). Which should I fix?"
- The same rule holds for ideas and designs: ideation only researches and proposes, design options are built only on their own branches, and `rk adopt` and `rk discard` run only on the user's word (see section 7).

## 0. Pick the review kind and read its playbook

Each review has a kind, set as `project.kind`. Missing means `ui`.

| Kind | What it reviews | Evidence | Playbook | Companion skills |
| --- | --- | --- | --- | --- |
| `prs` | Pull requests across repos: mine and reviewing | GitHub snapshots, diffs, draft findings and one selected review | `prs-review.md` | none required |
| `ui` | UI/UX: accessibility, touch, layout, type, forms, navigation | before/after screenshots | `ui-review.md` | ui-ux-pro-max |
| `backend` | Backend practices: security, correctness, errors, API design, data, architecture, tests | code, test and command output | `backend-review.md` | api-design-principles, architecture-patterns, error-handling-patterns |
| `ideas` | Research and ideas: what to build and why | cited sources, reasoning, alternatives, risks | `ideas-review.md` | none required |
| `design` | 2-3 options for one decision, built on their own branches and compared | criteria scores, screenshots, diffs, test output | `design-review.md` | ui-ux-pro-max for UI options; the three backend skills for API or architecture options |

- All playbooks are next to this file, in `$KIT/skill/review-kit/`. Read the one for your kind before auditing.
- The user may want several kinds. Keep one review per kind; don't mix UI and backend issues in one review.
- The companion skills ship with the kit in `$KIT/skill/companions/`. `rk companions` shows the copy to use: an installed one if the agent already has it, otherwise the bundled one. Read them from there even if your agent hasn't loaded them as skills.
- Only review what the user asked for. A UI fix doesn't need a backend audit.

## 1. Set up once per project

- Look for an existing review first: `.review/<kind>/review.json`, then `.review/review.json`, `docs/review/review.json`, or `review.json`. Reuse one if it exists.
- If there is none, run `rk init .review/ui --kind ui --name "<App>" --platforms mobile,desktop` or `rk init .review/backend --kind backend --name "<App>"` (likewise `--kind ideas` or `--kind design`). Use `--platforms web` for a single UI platform.
  - If the user wants the repo set up for future sessions and other agents, run `rk attach --name "<App>" --kind ui,backend` instead (pass only the kinds they want). It also adds a short review-kit pointer to the repo's `AGENTS.md`, and to `CLAUDE.md` if one exists.
  - With several reviews, pass the kind as the review argument: `rk add-issue backend ...`, `rk build ui`.
  - Use `docs/review` instead of `.review` if the user wants the reviews visible in the repo (`--dir docs/review` for attach).
  - Add `--ignore-screenshots` if the repo is public, or if many large screenshots are expected. Mention this choice to the user.
  - `site/` is always gitignored.
- Don't commit `.review/` unless the user asks. Treat it as work-in-progress evidence.

## 2. Record issues as you find them

`rk add-issue --platform mobile --area <page> --severity P0|P1|P2|none --title "<one line>" [--details "<markdown>"] [--where "file:line"] [--screenshot path] [--top]`

- Write one issue per problem. Titles are plain text.
- Use `--severity none --tags root-cause` for a shared underlying cause.
- To change an existing issue later, pass `--update --id <id>`.

## 3. Evidence for every fix

This section and the next apply only to fixes the user approved (see "Report first, fix only when told").

For a backend review, follow the Recording section of `backend-review.md`: a regression test or a command with its output, quoted in the fix summary. The rest of this section is for UI reviews.

1. Take the BEFORE screenshot before you edit any code, at every viewport you will verify. Mobile is usually 412x915 and desktop 1440x900.
2. Make the fix.
3. Take the AFTER screenshot with the same URL, viewport, data and steps.
4. Open both images and look at them (with whatever file or image viewer your environment gives you). Never record a fix you haven't looked at. If you can't view images, say so to the user instead of recording the fix as verified.

How to capture:

- **The project has Playwright** (check `node_modules/playwright` or `@playwright/test`): run this from the project root:
  `rk shot --url <url> --viewport mobile|desktop|WxH --out .review/ui/screenshots/<fix>/<page>-<platform>-before.png`
  - Optional flags: `--full`, `--dark`, `--storage state.json` (logged in), `--steps steps.mjs` (`export default async (page) => {...}` to open dialogs or scroll), `--selector`.
  - If Playwright is elsewhere, set `PLAYWRIGHT_PATH=/abs/node_modules/playwright`.
- **No Playwright:** try `npx playwright` (may need `npx playwright install chromium`), the project's e2e tooling, `xcrun simctl io booted screenshot`, or `adb exec-out screencap -p > x.png`. If none of these work, ask the user for screenshots.
- Never start servers or databases that the project rules forbid. Use the instance you were told about.

## 4. Record each fix

`rk add-fix --title "<what changed>" --summary "<markdown: what and why>" --files a.tsx,b.ts --pair mobile <before> <after> --pair desktop <before> <after> --resolves <ids> [--partial <ids>] [--commit <sha>] [--link "PR #12=<url>"]`

- Use `-` for a missing side, for example `--pair desktop - after.png`.
- Absolute image paths are copied into `screenshots/<fix-id>/`.
- If an issue turns out to be fine: `rk mark [review] notabug <id> --note "<why>"`, for example `rk mark backend notabug issue-3 --note ...`. For deferred work: `rk mark wontfix <id>` or `rk add-plan --group Roadmap --title ... --status todo`.

## 5. Parallel fix agents (hand-off pattern)

This applies whenever several workers fix things at once: sub-agents, parallel sessions, separate worktrees or other people. Only hand out issues the user approved for fixing. Fix agents running in parallel must never edit `review.json` themselves. If you work alone, skip this section and use `rk add-fix` directly. Otherwise:

- Give each agent a fix key (`fix7`), the issue ids it owns, and these instructions:
  1. Capture BEFORE shots into `.review/ui/screenshots/fix7/` (backend: skip the shots and put the evidence in `summary`).
  2. Fix the issue.
  3. Capture AFTER shots.
  4. Write `.review/<kind>/pending/fix7.json` as `{"fix": {title, summary, files, platforms: {mobile: {description, pairs: [{before: {src, caption}, after: {src, caption}}]}}}, "marks": [{"issue": "m-3", "status": "fixed|partial|notabug", "note": "..."}], "issues": [<new findings>]}`.
  5. Use `src` paths relative to the review folder, or absolute paths.
- When the agents finish, run `rk apply-pending` yourself. It merges the files in natural order, which sets the fix numbers, and renames each to `*.applied.json`.
  - If a file fails validation, fix that file and rerun.

## 6. Build, serve and report

- Build: `rk build`. When the repo has several reviews (`.review/ui/`, `.review/backend/`, `.review/ideas/`, `.review/design/`), this writes ONE combined site at `.review/site/index.html` with a switch (All, Ideas, Designs, UI/UX, Backend) and an overview of them all; with one review it writes `.review/<kind>/site/`. `rk build ui` (or another kind) builds only that review. The page also works when opened directly from disk.
- Serve, detached so it keeps running after your command returns (with both kinds it serves the combined site, and `--watch` follows both reviews):
  `nohup review-kit serve --port 8787 --watch > /tmp/review-kit.log 2>&1 & disown`
  - Then read the log and give the user the localhost URL. For a phone preview, explicitly add `--host 0.0.0.0` and give the LAN or Tailscale URL; tell the user anyone who can reach that port can read the review.
  - Choose another port if 8787 is taken. Never kill servers you did not start.
  - Deep links include the review: `http://127.0.0.1:8787/#/backend/issues/issue-3`, `#/ui/fixes/fix-2`.
  - `--watch` rebuilds automatically after later `add-*` and `mark` calls.
- Tidy up when a round is done: `rk clean` removes the built sites (each review's `site/` and the combined `.review/site/`) and merged `pending/*.applied.json`. `rk clean --orphans --dry-run` lists screenshots nothing references anymore; drop `--dry-run` to delete them. Screenshots that unmerged `pending/*.json` files reference are kept, and `--orphans` stops without deleting anything if a pending file can't be read.
- Report: `rk summary` prints Markdown with totals, counts by severity and platform, the latest fixes, and the most severe open items. Use it for progress updates and PR descriptions, and end with the site URL.

## 7. Ideas, then designs, then adopt

For "what should we build" and "which way should we build it", the flow is:

1. **Ideas** (`.review/ideas/`, `ideas-review.md`). Frame the question, research with real sources (`rk add-research`), then record a few strong ideas with their reasoning, evidence, alternatives and risks (`rk add-idea`). Report a ranked shortlist and stop. Nothing is built. The user decides each idea; record it with `rk decide <idea> go|maybe|no --note "<their reason>"`.
2. **Design** (`.review/design/`, `design-review.md`). For a `go` idea, write a brief and agree weighted criteria with the user (`rk add-proposal`). Build 2-3 different options, each on its own branch and worktree (`rk option new`), with the same screenshots or test runs for each, then record and score them (`rk option record`) and recommend one (`rk recommend`). Report and stop.
3. **Adopt**, only when the user names an option: `rk adopt design <proposal> <option>` squash-merges that option's branch into the current branch. Then suggest a UI or backend review of the result, and offer `rk discard design <proposal>` for the other branches; run it only if the user agrees.

- Never edit the user's branch while designing, and never run `adopt` or `discard` because an option looks clearly best.
- `rk validate` and `rk build` warn about weak reasoning: research without sources, ideas without reasoning, evidence, alternatives or risks, proposals without criteria or a recommendation, and unscored options. Fix the warnings before reporting.
- In a combined site, ideas link to their design proposals and back: `#/ideas/ideas/i-1`, `#/design/proposals/<id>/<option>`.

## Reference

- Issue statuses: `open`, `partial`, `fixed`, `notabug`, `wontfix`. Plan statuses: `todo`, `doing`, `partial`, `done`, `dropped`. Idea statuses: `proposed`, `go`, `maybe`, `no`, `done`. Proposal statuses: `open`, `adopted`, `closed`.
- Default severities are P0 (blocker), P1 (major) and P2 (polish). You can set custom ones under `severities`.
- Rich-text fields are Markdown. Set `project.textFormat: "html"` for HTML. Both modes sanitize active content; use screenshot fields for images.
- Build references must resolve inside the review folder. The CLI explicitly imports absolute raster screenshot paths. Hidden files, credentials/session filenames and active attachments such as HTML/SVG are blocked.
- Before sharing, check text, screenshots and attachments for personal details and secrets. Keep browser storage state out of Git and the published folder. Publish only generated output; use a fresh output folder if a build detects unexpected files.
- Theme: `project.theme.accent`, `project.theme.logoText`.
- `rk validate` checks the schema, references and images. `rk schema` prints the schema path.
- When you edit `review.json` by hand, run `rk validate` afterwards. Prefer the CLI, which validates before saving.

## 8. Pull requests across repositories

For a PR dashboard use `rk init .review/prs --kind prs`, then `rk pr add --mine` and/or `rk pr add --requested`. Read [prs-review.md](prs-review.md) before acting. Sync and diagnose freely; external GitHub actions require the user's explicit word for that PR. In reviewing mode, draft exact findings and a verdict; only the user selects which findings to ship, and shipping itself needs explicit approval. `rk serve prs --sync-prs 5` enables local action buttons; disk and LAN pages offer standalone `gh` commands.
