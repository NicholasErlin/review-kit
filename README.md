# review-kit

Track what a round of review and fixing changed: **issues found, fixes shipped with before/after screenshots, and what is left**. Keep it all in one `review.json`, then publish it as a fast, offline, mobile-first static site.

- **One data file.** `review.json` holds issues, fixes and the plan. It follows a versioned format with a [JSON Schema](schema/review.schema.json) ([format reference](docs/format.md)).
- **Zero dependencies.** It needs only Python 3.8+ (standard library). The site is vanilla HTML, CSS and JS: no CDN, no build step, and it works from `file://`.
- **Built for reviewing on a phone.** Bottom tabs, dark mode, a compare view (slider, tap to flip, or side by side), and a lightbox with pinch, wheel and double-tap zoom plus swipe. Issues can be filtered by platform, severity, status, area and text. Progress is broken down by severity and by platform.
- **Agent-friendly.** Fix agents write small hand-off JSON files. The orchestrator merges them with `review-kit apply-pending`. See [docs/workflow.md](docs/workflow.md). An agent skill drives the whole loop for any coding agent (see [Agent skill](#agent-skill) below).

<p><img src="docs/img/fixes-mobile.png" alt="Fixes view on a phone: before/after slider" width="300"> <img src="docs/img/overview-desktop.png" alt="Overview on desktop" width="520"></p>

## Quick start

**1. Install once per machine.** This clones the kit to `~/review-kit`, links `review-kit` into `~/.local/bin`, and links the agent skill into `~/.claude/skills/` if that folder exists:

```bash
curl -fsSL https://raw.githubusercontent.com/NicholasErlin/review-kit/main/install.sh | bash
```

Run it again any time to update. If you already have a clone, run `./install.sh` from it instead. Use `--skills-dir DIR` to link the skill into other agents' skills folders (repeatable), `--dir` to install somewhere else, and `--no-skill` to skip the skill. Without network access to the repo, `git clone` it however you can and run `install.sh` from the clone.

**2. Attach it to a repo once per project:**

```bash
cd your-project
review-kit attach --name "Your App" --platforms mobile,desktop
```

This creates `.review/` (`review.json`, `screenshots/`, `pending/` and a `.gitignore` for the built site). It also adds a short pointer to the repo's `AGENTS.md`, and to `CLAUDE.md` if there is one, so any coding agent in the repo knows to use the skill. Commit those files to share the setup with your team. Re-running `attach` is safe: it reuses the review and updates the pointer in place. `--no-agents-file` skips the pointer, and `--agents-file FILE` picks other files.

**3. Use it.** Ask your agent for fixes with a review ("fix the mobile layout issues and record before/after screenshots"), or drive it yourself:

```bash
review-kit add-issue --title "Save is hidden behind the bottom nav" --platform mobile --severity P0 --area Editor
review-kit add-fix --title "Sticky Save bar" --files src/Form.tsx \
  --pair mobile before.png after.png --resolves m-1
review-kit serve --watch                       # builds .review/site and previews on localhost
```

Commands with no review path look for `review.json`, `.review/review.json`, `docs/review/review.json` or `review/review.json`. You can also run the kit as `python3 -m reviewkit` from the repo root.

## Commands

| Command | What it does |
| --- | --- |
| `attach [REPO]` | Sets a repo up in one step: creates `.review/` if the repo has no review yet (same options as `init`, with `--dir` for the folder), and adds or updates a review-kit pointer in `AGENTS.md`, plus `CLAUDE.md` if present. `--agents-file FILE` (repeatable) and `--no-agents-file` change which files get the pointer. |
| `init [DIR]` | Scaffolds `DIR/review.json`, `screenshots/`, `pending/` and a `.gitignore`. DIR defaults to `.review`. Options: `--name`, `--title`, `--platforms a,b`, `--accent "#hex"`, `--ignore-screenshots`. |
| `validate [REVIEW]` | Checks the file against the schema and its cross-references: unknown platforms, severities, issue or fix ids, duplicate ids and missing images. |
| `build [REVIEW] [--out DIR]` | Validates, copies the referenced images, and writes `index.html`, `app.css`, `app.js` and `data.js`. The output goes to `site/` next to `review.json` by default. `--max-width N` downscales PNG/JPEG with `sips` or ImageMagick when available. Without them, images are copied unchanged. |
| `serve [REVIEW\|SITE] [--port 8787] [--host 127.0.0.1] [--watch]` | Builds, then previews locally. Add `--host 0.0.0.0` to share on your network without a login. `--watch` rebuilds when `review.json` or `screenshots/` change. |
| `add-issue` | Adds issues from flags (`--title --platform --severity --area --status --details --note --where --screenshot --top`) or from `--json`/`--file`, which take one object or a list. `--update` merges into an existing id. |
| `add-fix` | Adds a fix from flags (`--title --summary --files --pair PLATFORM BEFORE AFTER --resolves ids --partial ids --commit --link Label=URL`) or from `--json`/`--file`. The JSON can be a bare fix or a hand-off envelope. It assigns the next number and today's date. |
| `add-plan` | Adds a roadmap item: `--group --title --phase --status --effort --files --severity`. |
| `mark STATUS ID...` | Sets the status of issues (`open partial fixed notabug wontfix`) or plan items (`todo doing partial done dropped`). `--note` adds a note and `--fix` links the item to a fix. |
| `apply-pending [REVIEW]` | Merges every `pending/*.json` in natural order and renames each one to `*.applied.json`. It stops at the first file that would not validate. |
| `clean [REVIEW] [--orphans] [--dry-run]` | Removes the built `site/` (only a folder review-kit built), and the `pending/*.applied.json` files that have been merged. `--orphans` also deletes screenshots that `review.json` no longer references. `--keep-site` and `--keep-applied` skip a part, and `--dry-run` only lists what would go. |
| `home` | Prints the folder the kit is installed in, for the docs, the skill and `capture/shot.mjs`. |
| `summary [REVIEW]` | Prints a Markdown progress summary: totals, counts by severity and platform, latest fixes, and the most severe open issues. |

Image paths given on the command line or in hand-off files can be absolute. They are then copied into `screenshots/<fix-id>/` (or `screenshots/issues/`) and stored as relative paths.

## Example

[`examples/basic-app/`](examples/basic-app/README.md) is a full walkthrough on a small task-list app. `run.sh` audits the app, applies three fixes with before/after screenshots (one of them through a hand-off file), triages what is left and builds the site. Its output is committed, so `review-kit serve examples/basic-app/review` shows the result straight away.

## Keeping the server running

`serve` is a normal foreground process. To keep it alive after the terminal or an agent's tool call ends, detach it:

```bash
nohup review-kit serve .review/review.json --port 8787 --watch > /tmp/review-kit.log 2>&1 &
disown
```

You can also build once and serve `site/` with any static server, or open `site/index.html` directly.

## Privacy and publishing

Previews bind to localhost by default. To view one on a phone, explicitly share it with `review-kit serve --host 0.0.0.0`; anyone who can reach that port can read the review. Use hosting with authentication for private reviews.

Publish only the generated site folder. Everything in `data.js`, screenshots and linked attachments is public to anyone with access, including resolved issues and notes hidden by filters. Check screenshots for names and account details, and remove sensitive image metadata before adding them. Review files should contain public repository URLs rather than local checkout paths.

Build references must stay inside the review folder after resolving symlinks. Use `add-issue` or `add-fix` to explicitly import screenshots from elsewhere. Screenshots must be PNG, JPEG, GIF, WebP or AVIF; local attachments may also be PDF, text, Markdown, CSV, TSV, JSON, patch or diff files. Hidden files and common credential/session filenames are blocked. Review ordinary attachments for sensitive contents before adding them.

The builder refuses unexpected files and symlinks in an output directory, even with `--force`, so existing private files are left untouched. Choose a fresh `--out` directory when this happens. The preview server blocks hidden paths, external symlinks and directory listings; for generated sites it serves only files recorded in the build manifest. Rebuild older sites before serving them.

Both Markdown and HTML modes keep basic formatting and tables while stripping active tags, event handlers, styles and inline images. Add images through screenshot fields. Links allow HTTP, HTTPS, mailto and relative destinations; executable schemes and URLs containing credentials are blocked. Generated pages also restrict scripts and network connections with a Content Security Policy.

The repository and newly initialized reviews ignore common environment, private-key and browser-session files, including the `state.json` used below. Ignore rules do not remove previously committed secrets. Use a GitHub no-reply commit identity when you want to keep your email private.

## Screenshots

`capture/shot.mjs` takes one Playwright screenshot. Playwright is resolved from the project you run it in, or from `PLAYWRIGHT_PATH`:

```bash
node "$(review-kit home)/capture/shot.mjs" --url http://localhost:3000/settings \
  --out .review/screenshots/fix-3/settings-before-mobile.png --viewport mobile [--full] [--dark] \
  [--storage state.json] [--steps steps.mjs] [--wait-for "main"] [--selector ".dialog"]
```

Take the **before** shot before you edit any code. Then take the **after** shot from the same URL, viewport and steps. [docs/workflow.md](docs/workflow.md) has more.

## Layout

```
install.sh                 installer and updater (kit, PATH link, agent skill)
bin/review-kit             launcher (symlink-safe)
reviewkit/                 Python package: cli, build, validate, markdown, images, edit, attach, clean, serve, summary
reviewkit/site/            the site template (index.html, app.css, app.js)
schema/review.schema.json  the format (version 1)
capture/shot.mjs           Playwright screenshot helper
docs/                      format reference, workflow and hand-off contract
skill/review-kit/SKILL.md  agent skill: instructions any coding agent can follow
examples/demo/             small synthetic review (committed, self-contained)
examples/basic-app/        a tiny real web app reviewed end to end by run.sh (committed output in review/)
tests/                     unittest suites + Playwright smoke test
```

## Tests

```bash
python3 -m unittest discover -s tests                     # unit tests (stdlib)
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node tests/smoke.mjs   # browser smoke test: demo at 412x915, 1440x900 and dark mode
```

## Agent skill

`skill/review-kit/SKILL.md` teaches a coding agent to use this kit in any repository. It isn't tied to one agent: it only assumes the agent can run shell commands and open image files. With it, an agent can set up `.review/`, capture before/after screenshots, record issues and fixes as it works (including parallel fix agents through `pending/`), build and serve the site, and summarise progress.

The file uses the `SKILL.md` format: a short YAML header (`name`, `description`) followed by Markdown instructions. There are three ways to give it to an agent:

- **Agents that load `SKILL.md` skills:** `install.sh` symlinks the skill folder into `~/.claude/skills/` (Claude Code) when it exists. For other agents, pass their skills folder: `./install.sh --skills-dir <folder>`. Check the agent's docs for where user-level skills live. Because it is a symlink, updating the kit updates the skill.
- **Agents that read a project instructions file such as `AGENTS.md`:** `review-kit attach` writes a pointer that tells the agent to read the skill (found with `review-kit home`) and how to install the kit if it's missing. Point `--agents-file` at a rules or custom-instructions file if your agent uses a different name.
- **Any other agent:** paste the body of `SKILL.md` into its prompt or task, or tell it to read `$(review-kit home)/skill/review-kit/SKILL.md` first.

The skill finds the kit through `review-kit` on PATH and `review-kit home`, so the kit can live anywhere.

## License

MIT, see [LICENSE](LICENSE).
