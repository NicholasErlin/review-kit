---
name: review-kit
description: "Use when reviewing or fixing a repo in several steps and the user wants a reviewable overview of what changed (issues found, fixes shipped with evidence, what is left): UI/UX reviews with before/after screenshots, and backend practice reviews (security, correctness, errors, API design, architecture, tests) with code and test evidence. Also use when the user asks to set up a review site, audit tracker, before/after comparison, fix log or progress overview. Also use when coordinating several fix agents whose results should be merged into one report. Records everything in a review.json and publishes an offline, phone-friendly site with review-kit. Do not use for a single small change nobody asked to document."
---

# review-kit: issues, fixes and the evidence for each

These instructions work with any coding agent that can run shell commands and look at image files.

Run the CLI as `review-kit <command>` (written `rk` below). It needs Python 3.8+ and has no other dependencies.

- If `review-kit` is not on PATH, try `~/review-kit/bin/review-kit`. If the kit isn't installed at all, ask the user before installing it with `curl -fsSL https://raw.githubusercontent.com/NicholasErlin/review-kit/main/install.sh | bash`.
- `rk home` prints the kit folder, written `$KIT` below. Longer docs are in `$KIT/docs/workflow.md` (process) and `$KIT/docs/format.md` (fields).

## Report first, fix only when told

A review run has two phases. Never merge them on your own.

1. **Report.** Audit, record every problem with `rk add-issue` (plus plan items), build the site, and give the user the `rk summary` and the site URL. Change nothing else: no edits to the project's code, config or dependencies, and no commits. For UI reviews, the screenshots you take while auditing are the "before" evidence.
2. **Apply, only when the user says so.** Fix exactly the issues the user approved, by id, severity or area, for example "fix m-1 and m-3" or "do the P0s". Record each fix with its evidence. Leave everything else open.

- "Review", "audit", "check" or "run review-kit" means phase 1 only.
- A request that already asks for fixes, such as "fix the mobile layout and show me before/after", counts as approval for those fixes only. Report anything else you notice; don't fix it.
- If you're unsure whether a fix was approved, ask.
- After phase 1, stop and wait. A good ending is: "N issues recorded (x P0, y P1). Which should I fix?"

## 0. Pick the review kind and read its playbook

Each review has a kind, set as `project.kind`. Missing means `ui`.

| Kind | What it reviews | Evidence | Playbook | Companion skills |
| --- | --- | --- | --- | --- |
| `ui` | UI/UX: accessibility, touch, layout, type, forms, navigation | before/after screenshots | `ui-review.md` | ui-ux-pro-max |
| `backend` | Backend practices: security, correctness, errors, API design, data, architecture, tests | code, test and command output | `backend-review.md` | api-design-principles, architecture-patterns, error-handling-patterns |

- Both playbooks are next to this file, in `$KIT/skill/review-kit/`. Read the one for your kind before auditing.
- The user may want both kinds. Keep one review per kind; don't mix UI and backend issues in one review.
- The companion skills ship with the kit in `$KIT/skill/companions/`. `rk companions` shows the copy to use: an installed one if the agent already has it, otherwise the bundled one. Read them from there even if your agent hasn't loaded them as skills.
- Only review what the user asked for. A UI fix doesn't need a backend audit.

## 1. Set up once per project

- Look for an existing review first: `.review/<kind>/review.json`, then `.review/review.json`, `docs/review/review.json`, or `review.json`. Reuse one if it exists.
- If there is none, run `rk init .review/ui --kind ui --name "<App>" --platforms mobile,desktop` or `rk init .review/backend --kind backend --name "<App>"`. Use `--platforms web` for a single UI platform.
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
  `node "$(rk home)/capture/shot.mjs" --url <url> --viewport mobile|desktop|WxH --out .review/ui/screenshots/<fix>/<page>-<platform>-before.png`
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

- Build: `rk build ui` (or `backend`), which writes `.review/ui/site/index.html`. The page also works when opened directly from disk.
- Serve, detached so it keeps running after your command returns:
  `nohup review-kit serve .review/ui/review.json --port 8787 --watch > /tmp/review-kit.log 2>&1 & disown`
  - Then read the log and give the user the localhost URL. For a phone preview, explicitly add `--host 0.0.0.0` and give the LAN or Tailscale URL; tell the user anyone who can reach that port can read the review.
  - Choose another port if 8787 is taken, and serve a second review on its own port (8788). Never kill servers you did not start.
  - `--watch` rebuilds automatically after later `add-*` and `mark` calls.
- Tidy up when a round is done: `rk clean` removes `site/` and merged `pending/*.applied.json`. `rk clean --orphans --dry-run` lists screenshots nothing references anymore; drop `--dry-run` to delete them. Screenshots that unmerged `pending/*.json` files reference are kept, and `--orphans` stops without deleting anything if a pending file can't be read.
- Report: `rk summary` prints Markdown with totals, counts by severity and platform, the latest fixes, and the most severe open items. Use it for progress updates and PR descriptions, and end with the site URL.

## Reference

- Issue statuses: `open`, `partial`, `fixed`, `notabug`, `wontfix`. Plan statuses: `todo`, `doing`, `partial`, `done`, `dropped`.
- Default severities are P0 (blocker), P1 (major) and P2 (polish). You can set custom ones under `severities`.
- Rich-text fields are Markdown. Set `project.textFormat: "html"` for HTML. Both modes sanitize active content; use screenshot fields for images.
- Build references must resolve inside the review folder. The CLI explicitly imports absolute raster screenshot paths. Hidden files, credentials/session filenames and active attachments such as HTML/SVG are blocked.
- Before sharing, check text, screenshots and attachments for personal details and secrets. Keep browser storage state out of Git and the published folder. Publish only generated output; use a fresh output folder if a build detects unexpected files.
- Theme: `project.theme.accent`, `project.theme.logoText`.
- `rk validate` checks the schema, references and images. `rk schema` prints the schema path.
- When you edit `review.json` by hand, run `rk validate` afterwards. Prefer the CLI, which validates before saving.
