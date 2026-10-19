# review.json format (version 1)

The authoritative definition is [`schema/review.schema.json`](../schema/review.schema.json). `review-kit validate` checks a file against it locally. It also checks cross-references, duplicate ids and that every image exists. Newly created reviews use the public schema URL for editor autocompletion, so they do not store your local installation path.

## Conventions

- **Paths.** Image `src` and local link `href` values are relative to the folder that contains `review.json` and must resolve inside it, including symlink targets. The builder copies them under `img/` and `files/` and adds a content hash. Hidden files, common credential/session filenames and active file types such as HTML and SVG are rejected. Screenshots support PNG, JPEG, GIF, WebP and AVIF; attachments also support PDF, text, Markdown, CSV, TSV, JSON, patch and diff files. The CLI can explicitly import absolute screenshot paths before building.
- **Rich text.** Fields marked *rich* are Markdown by default. The renderer supports paragraphs, `#` headings, `-` and `1.` lists, `>` quotes, fenced code, `**bold**`, `*em*`, `~~strike~~`, `` `code` ``, `[links](url)` and basic inline HTML. Set `project.textFormat` to `"html"` to import HTML reports. Both modes sanitize tags and attributes: formatting and tables survive; scripts, embedded images, styles and event handlers do not. Add images through screenshot fields. Links allow HTTP, HTTPS, mailto and relative destinations; executable schemes and credential-bearing URLs are rejected.
- **Ids.** Ids start with a letter or digit and may then contain letters, digits, `.`, `_`, `:` and `-`. Issue, fix, area, plan item, research and idea ids must be unique. Proposal and option ids are stricter, because they become branch names: lower-case letters, digits and `-`.
- **Versioning.** `version` is `1`. Additive, optional fields keep the version. A breaking change bumps it, and the builder will refuse versions it does not know.

## Top level

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `1` | Required. |
| `project` | object | Required. See below. |
| `platforms` | array | The variants the review covers, such as `mobile` and `desktop`. The list can have one entry or be omitted, which gives a single `default` platform. When there is only one platform, the site hides the platform switches. |
| `severities` | array | Ordered from most to least severe. The default is `P0`, `P1`, `P2`. Each entry has an `id`, plus an optional `label`, `color` (hex) and `description`. Any number of levels works, for example `critical`, `major`, `minor`, `nit`. |
| `areas` | array | Pages, screens or report sections. Each has `id`, `title`, optional `num`, `platform`, `description` (rich) and `screenshots`. |
| `issues` | array | See below. |
| `fixes` | array | See below. |
| `plan` | array | Roadmap groups: `{id?, title, platform?, intro (rich), items: [...]}`. |
| `appendix` | array | Free sections shown at the end of the Plan tab: `{title, platform?, body (rich)}`. |
| `research` | array | Research findings with sources. See below. Any kind of review may have them; ideas reviews use them most. |
| `ideas` | array | Ideas with their reasoning. See below. |
| `proposals` | array | Design proposals with their options. See below. |

### project

`name` is required. The other fields are optional: `title` (shown after the name, default "Review"), `kind` (`ui`, `backend`, `ideas` or `design`, default `ui`: what is reviewed, which tells agents which playbook to follow and which tabs the site shows first; when several reviews are built into one site, it also gives each its label and place in the switch: Ideas, Designs, UI/UX, then Backend), `description` (rich), `date`, `repo` (a public HTTP(S) URL), and `links`. Each link is `[{label, href, kind?}]`. When `href` is a local file such as a PDF, it is copied into the site. `textFormat` is `markdown` or `html`. `theme` takes `{accent, accentDark, logoText}`. `accent` colours the header and the primary buttons. `accentDark` sets the link colour in dark mode and is derived automatically when it is omitted. `logoText` holds up to 3 characters for the badge.

### issues

| Field | Notes |
| --- | --- |
| `id`, `title` | Required. The title is plain text. |
| `platform` | A platform id. It defaults to the first platform. |
| `area` | An area id. When it does not match an area, it is shown as free text. |
| `severity` | A severity id, or `null` for unranked items such as root causes. |
| `status` | `open` (the default), `partial`, `fixed`, `notabug` (investigated, works as intended) or `wontfix`. The last three count as *resolved* in progress figures. |
| `details`, `note`, `where` | Rich text. `note` is the resolution note, shown in the status colour. `where` gives the code location. |
| `screenshots` | Images that belong to this issue. The issue also shows its area's screenshots. |
| `top`, `rank` | Lists the issue under the Overview's "top issues", sorted by `rank`. |
| `counted` | `false` marks a summary row that repeats other findings. It appears in top issues but is left out of totals, and the Issues tab shows it only under the "Summary rows" source filter. |
| `tags` | Free-form strings. `root-cause` is shown as a badge. |
| `date` | Optional. |

### fixes

| Field | Notes |
| --- | --- |
| `id`, `title` | Required. `add-fix` uses `fix-<number>` as the id. |
| `number` | Display number, shown as a badge. `add-fix` assigns the next free number. |
| `date` | ISO dates sort newest first. |
| `summary` | Rich text describing what changed, shown under "What changed". |
| `files`, `commits` (`{sha, url?, message?}`), `links` | Optional. |
| `issues` | Ids of the issues this fix addresses. They appear as chips on the fix, and each issue links back to the fix. |
| `platforms` | An object keyed by platform id. Each value is `{description?, pairs?, images?}`. A pair is `{before?, after?, caption?}` and needs at least one side. A pair with both sides gets the slider, tap and side-by-side views. A pair with one side is shown as a single figure. `images` holds extra screenshots that are not before/after. |

An image is a path string, or `{src, caption? (rich), alt?}`.

### plan items

`title` is required and is inline rich text. The optional fields are `id`, `phase`, `severity`, `details`, `files` (a string or a list), `effort`, `status` (`todo` by default, or `doing`, `partial`, `done`, `dropped`), `note`, `issues` and `fixes`. The two id lists render as chips.

### research

| Field | Notes |
| --- | --- |
| `id`, `title` | Required. The title is plain text. `add-research` uses `r-<number>`. |
| `summary` | Rich text: what was found. Keep facts apart from inference. |
| `sources` | `[{label, href, accessed?, quote?, kind?}]`. `href` is a URL or a path relative to `review.json`. `accessed` is an ISO date; `quote` a short plain excerpt; `kind` a free word such as `standard`, `docs`, `study`, `article` or `code`. |
| `confidence` | `low`, `medium` or `high`. |
| `tags`, `date` | Optional. |

### ideas

| Field | Notes |
| --- | --- |
| `id`, `title` | Required. `add-idea` uses `i-<number>`. |
| `status` | `proposed` (the default), `go`, `maybe`, `no` or `done`. Set by the user's call (`decide`). |
| `problem`, `proposal`, `reasoning`, `alternatives`, `risks`, `decision` | Rich text. `reasoning` says why this and why now, tied to research ids. `decision` holds the user's call and why. |
| `evidence` | Ids of research entries that support the idea. |
| `pros`, `cons` | Lists of inline rich text. |
| `effort`, `impact` | `S`, `M` or `L`. |
| `confidence` | `low`, `medium` or `high`. |
| `proposals` | Ids of design proposals for this idea; they may be in the design review. |
| `tags`, `date`, `rank` | Optional. `rank` orders the shortlist. |

### proposals

| Field | Notes |
| --- | --- |
| `id`, `title` | Required. The id uses lower-case letters, digits and `-` (up to 41 characters), because it becomes part of branch names. |
| `status` | `open` (the default), `adopted` or `closed`. |
| `brief` | Rich text: what is being decided, and the constraints. |
| `idea` | The idea this comes from; it may be in the ideas review. |
| `criteria` | `[{id, label, weight?, description?}]`. `weight` is 1 to 5 (default 1). |
| `recommendation` | `{option, reasoning (rich)}`: the recommended option and why, including when another would be better. |
| `decision`, `adopted` | `decision` is rich text. `adopted` is `{option, commit?, date?}`, set by `adopt`. |
| `options` | See below. |
| `date` | Optional. |

Each option:

| Field | Notes |
| --- | --- |
| `id`, `title` | Required. Same id rules as the proposal. The branch is `design/<proposal>/<option>`. |
| `status` | `proposed` (the default), `adopted` or `rejected`. |
| `summary`, `reasoning`, `evidence` | Rich text. `evidence` holds test output or measurements. |
| `pros`, `cons` | Lists of inline rich text. |
| `scores` | `{<criterion id>: {score, note?}}`. `score` is an integer from 1 to 5; `note` (rich) explains it. The site shows a weighted total out of 100; a missing score counts as 0. |
| `branch`, `base`, `head` | The branch name and the commits it starts from and ends at. |
| `worktree` | The worktree path, relative to the repository root. Never absolute, and never shown on the site. |
| `gone` | `true` once `discard` removed the branch and worktree. The snapshot stays. |
| `diff` | `{path, files: [{path, add, del}], insertions, deletions, truncated?}`. `path` points at the saved patch, relative to `review.json` (`diffs/<proposal>--<option>.patch`). The site embeds the patch text and shows it as plain text. |
| `platforms` | `{<platform id>: {description?, images: [image]}}`: screenshots of the option, taken the same way for every option. |

`validate` reports errors for unknown research, criterion or option ids, scores outside 1 to 5, duplicate ids, bad proposal or option ids, an absolute `worktree`, and a missing diff file. It warns about weak reasoning: research with no sources; ideas with no reasoning, evidence, alternatives or risks; a `go` idea with no decision note; proposals with fewer than 2 options or no criteria; options with no reasoning or a missing score; and an open proposal with 2 or more options and no recommendation.

## Hand-off envelope (pending/*.json)

`add-fix --file` and `apply-pending` accept either a bare fix object or an envelope:

```json
{
  "fix":    { "title": "...", "summary": "...", "files": [], "platforms": { "mobile": { "pairs": [ { "before": "...", "after": "..." } ] } } },
  "issues": [ { "id": "m-12", "title": "Found while fixing", "platform": "mobile", "severity": "P2" } ],
  "marks":  [ { "issue": "m-3", "status": "fixed", "note": "..." }, { "plan": "p-footer", "status": "done" } ],
  "plan":   [ { "group": "Roadmap", "title": "Follow-up: ...", "status": "todo" } ]
}
```

- Each issue in `issues` is added, or merged into the existing issue when the id is already taken.
- Each mark sets a status and appends its note. When the envelope also contains a fix, every marked issue is linked to that fix.
- New plan items are added to the named group. The group is created if it does not exist.
- Image paths can be absolute. They are copied into `screenshots/<fix-id>/`.
- The merged result must validate. If it does not, `review.json` is left unchanged and the file is not renamed.

[workflow.md](workflow.md) describes how to use the envelope with parallel agents.
