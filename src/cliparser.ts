/** The review-kit command-line parser (mirrors parser() in the Python reviewkit/cli.py). */
import { ArgumentParser, SUPPRESS } from './argparse.js';
import { VERSION } from './version.js';

const KINDS = ['ui', 'backend', 'ideas', 'design'];
const IDEA_STATUSES = ['proposed', 'go', 'maybe', 'no', 'done'];
const LEVELS = ['low', 'medium', 'high'];
const SIZES = ['S', 'M', 'L'];
const ISSUE_STATUSES = ['open', 'partial', 'fixed', 'notabug', 'wontfix'];
const PLAN_STATUSES = ['todo', 'doing', 'partial', 'done', 'dropped'];

function reviewArg(p: ArgumentParser, several = false): void {
  p.addArgument(['review'], several ? {
    nargs: '*',
    help: 'review.json, its folder or a kind (ui, backend, ideas, design); several, or a parent folder such as .review, give one '
      + 'combined site (default: auto-discover, combining every .review/<kind>/ when there are several)',
  } : {
    nargs: '?',
    help: 'path to review.json or its folder, or a kind (ui, backend, ideas, design) for .review/<kind>/ (default: auto-discover)',
  });
  p.addArgument(['-r', '--review-path'], { dest: 'review_opt', help: SUPPRESS });
}

/** Commands whose positionals may start with an optional review: `cmd [review] <args...>` (resolved in cli.ts). */
function wordsArg(p: ArgumentParser, help: string): void {
  p.addArgument(['words'], { nargs: '+', metavar: 'ARG', help });
  p.addArgument(['-r', '--review'], {
    dest: 'review_opt',
    metavar: 'REVIEW',
    help: 'path to review.json or its folder, or a kind (ideas, design) for .review/<kind>/ (default: auto-discover)',
  });
}

function jsonArgs(p: ArgumentParser): void {
  p.addArgument(['--json'], { help: 'the object as a JSON string' });
  p.addArgument(['--file'], { help: 'read the object from a JSON file ("-" for stdin)' });
}

export function parser(): ArgumentParser {
  const p = new ArgumentParser({
    prog: 'review-kit',
    description: 'Track issues and fixes (with before/after screenshots) in review.json and publish an offline review site.',
  });
  p.addArgument(['--version'], { action: 'version', version: `review-kit ${VERSION}` });
  const sub = p.addSubparsers({ dest: 'cmd', metavar: '<command>' });
  sub.required = true;

  let s = sub.addParser('init', { help: 'scaffold review.json, screenshots/ and pending/' });
  s.addArgument(['dir'], { nargs: '?', default: '.review', help: 'directory to create (default .review)' });
  s.addArgument(['--name'], { help: 'project name (default: current folder name)' });
  s.addArgument(['--kind'], { choices: KINDS, help: 'ui (UI/UX), backend, ideas or design; sets the title and platform defaults' });
  s.addArgument(['--title'], { help: 'shown after the name, e.g. "UI/UX audit" (default from --kind, else "Review")' });
  s.addArgument(['--platforms'], {
    help: 'comma list, e.g. "mobile,desktop" or "web" (default mobile,desktop; none for backend)',
  });
  s.addArgument(['--accent'], { help: 'header colour, e.g. "#12454f"' });
  s.addArgument(['--ignore-screenshots'], { action: 'store_true', help: 'gitignore screenshots/ (keeps the repo small)' });

  s = sub.addParser('attach', {
    help: 'set a repo up: create (or reuse) .review/<kind>/ and point AGENTS.md at the review-kit skill',
  });
  s.addArgument(['repo'], { nargs: '?', default: '.', help: 'repository folder (default: current folder)' });
  s.addArgument(['--kind'], { default: 'ui', help: 'comma list of review kinds: ui, backend, ideas, design (default ui)' });
  s.addArgument(['--dir'], {
    default: '.review',
    help: 'parent folder for the reviews (default .review, giving .review/ui/ ...)',
  });
  s.addArgument(['--name'], { help: 'project name (default: repo folder name)' });
  s.addArgument(['--title'], { help: 'header title (default per kind: "UI/UX review", "Backend review")' });
  s.addArgument(['--platforms'], { help: 'UI and design review platforms (default mobile,desktop)' });
  s.addArgument(['--accent']);
  s.addArgument(['--ignore-screenshots'], { action: 'store_true' });
  s.addArgument(['--agents-file'], {
    action: 'append',
    metavar: 'FILE',
    help: 'instructions file to add the pointer to (repeatable; default AGENTS.md, plus CLAUDE.md if present)',
  });
  s.addArgument(['--no-agents-file'], { action: 'store_true', help: 'only create the review folder' });

  s = sub.addParser('validate', { help: 'check review.json against the schema and cross-references' });
  reviewArg(s);
  s.addArgument(['--no-files'], { action: 'store_true', help: 'skip checking that images exist' });

  s = sub.addParser('build', { help: 'validate and write the static site (one combined site for several reviews)' });
  reviewArg(s, true);
  s.addArgument(['--out'], {
    help: 'output folder (default: site/ next to review.json; for several reviews, site/ in their parent, e.g. .review/site)',
  });
  s.addArgument(['--max-width'], {
    type: 'int',
    help: 'downscale wider PNG/JPEG images (needs sips or ImageMagick; copied as-is otherwise)',
  });
  s.addArgument(['--clean'], { action: 'store_true', help: 're-copy all images (e.g. after changing --max-width)' });
  s.addArgument(['--force'], { action: 'store_true', help: 'build into an existing folder not created by review-kit' });

  s = sub.addParser('serve', {
    help: 'build (unless --no-build) and serve locally; --host 0.0.0.0 enables network sharing',
  });
  s.addArgument(['target'], {
    nargs: '*',
    help: 'review.json, its folder, a kind, several of these (or a parent such as .review) for one combined site, '
      + 'or a built site folder (default: auto-discover)',
  });
  s.addArgument(['-r'], { dest: 'review_opt', help: SUPPRESS });
  s.addArgument(['--port'], { type: 'int', default: 8787, help: 'default 8787 (0 = pick a free port)' });
  s.addArgument(['--host'], {
    default: '127.0.0.1',
    help: 'default 127.0.0.1 (local only); use 0.0.0.0 to share on your network',
  });
  s.addArgument(['--out'], { help: 'site folder (default: site/ next to review.json, or .review/site for several)' });
  s.addArgument(['--watch'], { action: 'store_true', help: 'rebuild when a review.json or its screenshots/ change' });
  s.addArgument(['--no-build'], { action: 'store_true' });
  s.addArgument(['--max-width'], { type: 'int' });
  s.addArgument(['--force'], { action: 'store_true' });

  s = sub.addParser('add-issue', { help: 'add (or --update) issues from flags or JSON' });
  reviewArg(s);
  jsonArgs(s);
  for (const f of ['id', 'platform', 'area', 'severity', 'title', 'details', 'note', 'where', 'tags']) {
    s.addArgument(['--' + f]);
  }
  s.addArgument(['--status'], { choices: ISSUE_STATUSES });
  s.addArgument(['--top'], { action: 'store_true', help: 'list in Overview top issues' });
  s.addArgument(['--screenshot'], {
    action: 'append',
    help: 'image path (repeatable; absolute paths are copied in)',
  });
  s.addArgument(['--update'], { action: 'store_true', help: 'merge into an existing issue with the same id' });

  s = sub.addParser('add-fix', { help: 'add a fix (bare fix JSON or a hand-off envelope) and mark issues' });
  reviewArg(s);
  jsonArgs(s);
  s.addArgument(['--id']);
  s.addArgument(['--title']);
  s.addArgument(['--number'], { type: 'int' });
  s.addArgument(['--date'], { help: 'default today (ISO)' });
  s.addArgument(['--summary']);
  s.addArgument(['--files'], { help: 'comma list of changed files' });
  s.addArgument(['--commit'], { action: 'append', help: 'commit sha (repeatable)' });
  s.addArgument(['--link'], { action: 'append', help: '"Label=URL" (repeatable)' });
  s.addArgument(['--pair'], {
    nargs: 3,
    action: 'append',
    metavar: ['PLATFORM', 'BEFORE', 'AFTER'],
    help: 'before/after screenshot pair; "-" for a missing side (repeatable)',
  });
  s.addArgument(['--resolves'], { help: 'comma list of issue ids to mark fixed and link' });
  s.addArgument(['--partial'], { help: 'comma list of issue ids to mark partly fixed and link' });
  s.addArgument(['--update'], { action: 'store_true', help: 'replace an existing fix with the same id' });

  s = sub.addParser('add-plan', { help: 'add a plan/roadmap item' });
  reviewArg(s);
  jsonArgs(s);
  s.addArgument(['--group'], { help: 'plan group title or id (created if missing; default "Plan")' });
  for (const f of ['id', 'title', 'phase', 'effort', 'severity', 'note', 'details', 'files']) {
    s.addArgument(['--' + f]);
  }
  s.addArgument(['--status'], { choices: PLAN_STATUSES });

  s = sub.addParser('mark', {
    help: 'set the status of issues or plan items',
    usage: 'review-kit mark [review] <status> <ids...> [--note NOTE] [--fix FIX]',
  });
  s.addArgument(['-r', '--review'], {
    dest: 'review_opt',
    help: 'path to review.json or its folder, or a kind (ui, backend) for .review/<kind>/ (default: auto-discover)',
  });
  s.addArgument(['status'], {
    help: 'issue: ' + ISSUE_STATUSES.join('|') + '; plan: ' + PLAN_STATUSES.join('|'),
  });
  s.addArgument(['ids'], { nargs: '+', help: 'issue or plan item ids' });
  s.addArgument(['--note']);
  s.addArgument(['--fix'], { help: 'fix id to link (adds the issue to that fix)' });

  s = sub.addParser('apply-pending', {
    help: 'merge hand-off JSON files from pending/ (renamed to *.applied.json)',
  });
  reviewArg(s);
  s.addArgument(['--dir'], { help: 'pending folder (default: pending/ next to review.json)' });

  s = sub.addParser('summary', { help: 'print a Markdown progress summary' });
  reviewArg(s);
  s.addArgument(['--open'], { type: 'int', default: 8, help: 'how many open issues to list (default 8)' });
  s.addArgument(['--text'], { action: 'store_true', help: 'plain text instead of Markdown' });

  s = sub.addParser('clean', {
    help: 'remove the built site, merged pending/*.applied.json and (--orphans) unused screenshots',
  });
  reviewArg(s, true);
  s.addArgument(['--out'], {
    help: 'site folder (default: site/ next to review.json, plus .review/site for several); only removed if review-kit built it',
  });
  s.addArgument(['--orphans'], {
    action: 'store_true',
    help: 'also delete files in screenshots/ that review.json does not reference',
  });
  s.addArgument(['--keep-site'], { action: 'store_true', help: 'leave the built site in place' });
  s.addArgument(['--keep-applied'], { action: 'store_true', help: 'leave pending/*.applied.json in place' });
  s.addArgument(['-n', '--dry-run'], {
    action: 'store_true',
    help: 'list what would be removed without deleting anything',
  });

  s = sub.addParser('add-research', { help: 'add (or --update) a research finding with its sources' });
  reviewArg(s);
  jsonArgs(s);
  s.addArgument(['--id'], { help: 'default r-<n>' });
  s.addArgument(['--title'], { help: 'the finding, one plain line' });
  s.addArgument(['--summary'], { help: 'what was found; keep facts apart from inference (Markdown)' });
  s.addArgument(['--source'], { action: 'append', metavar: 'LABEL=URL', help: 'a source a reader can open (repeatable)' });
  s.addArgument(['--quote'], { action: 'append', help: 'short verbatim excerpt; the n-th --quote goes with the n-th --source' });
  s.addArgument(['--accessed'], { metavar: 'DATE', help: 'when the web sources were read (default today for http(s) sources)' });
  s.addArgument(['--kind'], { dest: 'source_kind', metavar: 'KIND', help: 'source kind for every --source: standard, docs, study, article, code, ...' });
  s.addArgument(['--confidence'], { choices: LEVELS });
  s.addArgument(['--tags'], { help: 'comma list' });
  s.addArgument(['--update'], { action: 'store_true', help: 'merge into the entry with --id (sources are added)' });

  s = sub.addParser('add-idea', { help: 'add (or --update) an idea with its reasoning, evidence, alternatives and risks' });
  reviewArg(s);
  jsonArgs(s);
  s.addArgument(['--id'], { help: 'default i-<n>' });
  s.addArgument(['--title']);
  for (const f of ['problem', 'proposal', 'reasoning', 'alternatives', 'risks']) s.addArgument(['--' + f], { help: 'Markdown' });
  s.addArgument(['--evidence'], { metavar: 'IDS', help: 'comma list of research ids, e.g. r-1,r-2' });
  s.addArgument(['--pro'], { action: 'append', help: 'repeatable' });
  s.addArgument(['--con'], { action: 'append', help: 'repeatable' });
  s.addArgument(['--effort'], { choices: SIZES });
  s.addArgument(['--impact'], { choices: SIZES });
  s.addArgument(['--confidence'], { choices: LEVELS });
  s.addArgument(['--status'], { choices: IDEA_STATUSES });
  s.addArgument(['--rank'], { type: 'int' });
  s.addArgument(['--tags'], { help: 'comma list' });
  s.addArgument(['--update'], { action: 'store_true', help: 'merge into the idea with --id' });

  s = sub.addParser('decide', {
    help: "record the user's call on an idea",
    usage: 'review-kit decide [review] <idea> proposed|go|maybe|no|done [--note TEXT]',
  });
  wordsArg(s, '[review] <idea> <status>');
  s.addArgument(['--note'], { help: 'the decision and why (appended to the idea\'s decision)' });

  s = sub.addParser('add-proposal', { help: 'add (or --update) a design proposal: the brief and the criteria options are scored on' });
  reviewArg(s);
  jsonArgs(s);
  s.addArgument(['--id'], { help: 'lower-case letters, digits and "-"; becomes part of the branch names' });
  s.addArgument(['--title']);
  s.addArgument(['--brief'], { help: 'what is being decided, and the constraints (Markdown)' });
  s.addArgument(['--idea'], { help: 'the idea this comes from (may live in the ideas review)' });
  s.addArgument(['--criterion'], { action: 'append', metavar: 'ID=LABEL:WEIGHT', help: 'scoring criterion, weight 1-5 (repeatable)' });
  s.addArgument(['--status'], { choices: ['open', 'adopted', 'closed'] });
  s.addArgument(['--update'], { action: 'store_true', help: 'merge into the proposal with --id (criteria merged by id)' });

  s = sub.addParser('option', {
    help: 'start a design option on its own branch and worktree (new), or record its write-up, scores and diff (record)',
    usage: 'review-kit option new [review] <proposal> <option> --title TEXT [--base REF] [--worktree-root DIR]\n'
      + '       review-kit option record [review] <proposal> <option> [--summary] [--reasoning] [--pro X]... [--con X]... '
      + '[--score CRIT=N[:NOTE]]... [--evidence] [--shot PLATFORM PATH [CAPTION]]...',
  });
  wordsArg(s, 'new|record [review] <proposal> <option>');
  s.addArgument(['--title']);
  s.addArgument(['--base'], { metavar: 'REF', default: 'HEAD', help: 'new: commit the branch starts from (default HEAD)' });
  s.addArgument(['--worktree-root'], {
    metavar: 'DIR',
    help: 'new: parent folder for the worktree (default <repo>.designs/ next to the repository)',
  });
  for (const f of ['summary', 'reasoning', 'evidence']) s.addArgument(['--' + f], { help: 'record: Markdown' });
  s.addArgument(['--pro'], { action: 'append', help: 'record: repeatable (replaces the list)' });
  s.addArgument(['--con'], { action: 'append', help: 'record: repeatable (replaces the list)' });
  s.addArgument(['--score'], { action: 'append', metavar: 'CRIT=N[:NOTE]', help: 'record: score 1-5 on a criterion (repeatable)' });
  s.addArgument(['--shot'], {
    action: 'append',
    nargs: '+',
    metavar: 'ARG',
    help: 'record: PLATFORM PATH [CAPTION], a screenshot for a platform (repeatable; copied into screenshots/<proposal>--<option>/)',
  });

  s = sub.addParser('recommend', {
    help: 'recommend one option of a proposal, with the reasoning',
    usage: 'review-kit recommend [review] <proposal> <option> --reasoning TEXT',
  });
  wordsArg(s, '[review] <proposal> <option>');
  s.addArgument(['--reasoning'], { required: true, help: 'why it wins, and when another option would be the better choice' });

  s = sub.addParser('adopt', {
    help: "merge the option the user picked into the current branch (squashed; only on the user's word)",
    usage: 'review-kit adopt [review] <proposal> <option> [--no-commit] [--message TEXT] [--record-only]',
  });
  wordsArg(s, '[review] <proposal> <option>');
  s.addArgument(['--no-commit'], { action: 'store_true', help: 'leave the changes staged' });
  s.addArgument(['-m', '--message'], { help: 'commit message (default "Adopt design <proposal>: <option title>")' });
  s.addArgument(['--record-only'], {
    action: 'store_true',
    help: 'only record the adoption at HEAD (after merging by hand, e.g. once a conflict is resolved)',
  });

  s = sub.addParser('discard', {
    help: 'remove the branches and worktrees of design options (snapshots and screenshots stay)',
    usage: 'review-kit discard [review] <proposal> [--option ID]... [--force] [--dry-run]',
  });
  wordsArg(s, '[review] <proposal>');
  s.addArgument(['--option'], { action: 'append', help: 'only this option (repeatable; default: every option not adopted, '
    + 'plus the adopted one once merged)' });
  s.addArgument(['--force'], { action: 'store_true', help: 'also remove worktrees with uncommitted changes' });
  s.addArgument(['-n', '--dry-run'], { action: 'store_true', help: 'list what would be removed' });

  s = sub.addParser('companions', {
    help: 'show, install or update the bundled agent skills that UI/UX, backend and design reviews use',
  });
  s.addArgument(['action'], {
    nargs: '?',
    choices: ['list', 'install', 'update'],
    default: 'list',
    help: 'list (default), install (link the bundled skills), update (maintainers: refresh the bundle)',
  });
  s.addArgument(['--kind'], { help: 'comma list: ui, backend, ideas, design (default ui,backend, which covers every companion)' });
  s.addArgument(['--skills-dir'], {
    action: 'append',
    metavar: 'DIR',
    help: 'install: link into this skills folder (repeatable; default ~/.claude/skills if ~/.claude exists)',
  });
  s.addArgument(['--json'], { action: 'store_true', help: 'list as JSON' });
  s.addArgument(['--path'], {
    metavar: 'NAME',
    help: 'print the folder of one installed companion skill (exit 1 if missing)',
  });

  sub.addParser('home', { help: 'print the folder review-kit is installed in (docs, skill, site template)' });

  sub.addParser('schema', { help: 'print the path of review.schema.json' });

  s = sub.addParser('setup', {
    help: 'link the review-kit agent skill (and optionally its companion skills) into agent skills folders',
  });
  s.addArgument(['--skills-dir'], {
    action: 'append',
    metavar: 'DIR',
    dest: 'skills_dir',
    help: 'link the skill into this agent skills folder (repeatable; default ~/.claude/skills if ~/.claude exists)',
  });
  s.addArgument(['--no-skill'], { action: 'store_true', help: "don't link the skill anywhere" });
  s.addArgument(['--with-companions'], {
    action: 'store_true',
    help: 'also link the bundled companion skills that UI/UX and backend reviews use',
  });

  s = sub.addParser('shot', {
    help: 'take one Playwright screenshot (before/after evidence); Playwright is resolved from the current project or PLAYWRIGHT_PATH',
  });
  s.addArgument(['--url'], { metavar: 'URL', required: true, help: 'page to open' });
  s.addArgument(['--out'], { metavar: 'FILE', required: true, help: '.png or .jpg (folders are created)' });
  s.addArgument(['--viewport'], {
    metavar: 'V',
    default: 'desktop',
    help: 'mobile (412x915, scale 2, touch) | tablet (820x1180) | desktop (1440x900) | WxH (default desktop)',
  });
  s.addArgument(['--full'], { action: 'store_true', help: 'full-page screenshot' });
  s.addArgument(['--dark'], { action: 'store_true', help: 'prefers-color-scheme: dark' });
  s.addArgument(['--wait-for'], {
    metavar: 'SELECTOR',
    dest: 'wait_for',
    help: 'wait for this selector before shooting',
  });
  s.addArgument(['--wait'], {
    metavar: 'MS',
    type: 'int',
    default: 300,
    help: 'extra settle time after load (default 300)',
  });
  s.addArgument(['--selector'], { metavar: 'SELECTOR', help: 'screenshot only this element' });
  s.addArgument(['--storage'], { metavar: 'FILE', help: 'Playwright storageState JSON (a logged-in session)' });
  s.addArgument(['--steps'], {
    metavar: 'FILE',
    help: 'ES module whose default export is async (page) => {} run before the shot',
  });
  s.addArgument(['--quality'], { metavar: 'N', type: 'int', default: 80, help: 'JPEG quality (default 80)' });
  return p;
}
