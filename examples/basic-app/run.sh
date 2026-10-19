#!/usr/bin/env bash
# End-to-end review-kit walkthrough on a tiny real web app (Pocket Tasks, in app/).
#
#   ./run.sh           audit the app, fix it patch by patch with before/after screenshots, build review/site
#   ./run.sh clean     tidy review/: remove the built site, merged hand-offs and unreferenced screenshots
#
# Needs Node.js 18+ (run `npm install && npm run build` in the kit first) and Playwright with Chromium.
# Playwright is found through PLAYWRIGHT_PATH, e.g.
#   PLAYWRIGHT_PATH=/path/to/node_modules/playwright ./run.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KIT="$(cd "$HERE/../.." && pwd)"
CLI="$KIT/dist/cli.js"
rk() { node "$CLI" "$@"; }
REVIEW="$HERE/review"

if [ ! -f "$CLI" ]; then
  echo "$CLI not found. Build the kit first: (cd $KIT && npm install && npm run build)" >&2
  exit 2
fi

if [ "${1:-}" = "clean" ]; then
  rk clean "$REVIEW/review.json" --orphans
  exit 0
fi

if ! node -e "require(process.env.PLAYWRIGHT_PATH || 'playwright')" 2>/dev/null; then
  echo "Playwright not found. Set PLAYWRIGHT_PATH=/path/to/node_modules/playwright (and run 'npx playwright install chromium')." >&2
  exit 2
fi

# The app is copied to a scratch folder and patched there, so app/ always stays in its original, buggy state.
WORK="$(mktemp -d)"
cp -R "$HERE/app" "$WORK/app"
PORT="$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
node "$CLI" serve "$WORK/app" --port "$PORT" --host 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
cleanup() { kill "$SERVER" 2>/dev/null && wait "$SERVER" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT
URL="http://127.0.0.1:$PORT/"
until curl -sf "$URL" >/dev/null; do sleep 0.2; done

shot() { # shot <mobile|desktop> <out.png>
  (cd "$WORK" && rk shot --url "$URL" --viewport "$1" --out "$2" --wait-for ".task") >/dev/null
}
fix() { # fix <patch name>: apply one patch from fixes/ to the running copy
  patch -s -p1 -d "$WORK/app" < "$HERE/fixes/$1.patch"
}

# ---------------------------------------------------------------- 1. set up (start from scratch each run)
rm -rf "$REVIEW"
rk init "$REVIEW" --name "Pocket Tasks" --title "UX review" --platforms mobile,desktop --accent "#2f5d50"
R="$REVIEW/review.json"

# ---------------------------------------------------------------- 2. audit: record what is wrong
shot mobile "$WORK/audit-mobile.png"
shot desktop "$WORK/audit-desktop.png"

rk add-issue "$R" --id m-1 --platform mobile --area "Add task" --severity P0 --top \
  --title "Add task button is cut off on phones" \
  --details "The form is a fixed **560px** wide, so on a 412px phone the button runs off the right edge." \
  --where "app/style.css:10" --screenshot "$WORK/audit-mobile.png"
rk add-issue "$R" --id m-2 --platform mobile --area "Task list" --severity P1 \
  --title "Completed tasks are almost invisible" --details "Light grey on white, far below a 4.5:1 contrast ratio." \
  --where "app/style.css:19"
rk add-issue "$R" --id d-1 --platform desktop --area "Task list" --severity P1 \
  --title "Completed tasks are almost invisible" --details "Same colour as on mobile." \
  --where "app/style.css:19" --screenshot "$WORK/audit-desktop.png"
rk add-issue "$R" --id d-2 --platform desktop --area "Task list" --severity P2 \
  --title "Task list stretches across the whole screen" \
  --details "At 1440px each task sits far from its delete button, which makes rows hard to scan."
rk add-issue "$R" --id m-3 --platform mobile --area "Task list" --severity P2 \
  --title "Delete is a tiny × with no confirmation" \
  --details "The tap target is about 20px and one tap removes the task for good."
rk add-issue "$R" --id d-3 --platform desktop --area "Task list" --severity P2 \
  --title "Tasks are gone after a reload"

# ---------------------------------------------------------------- 3. fix 1: shot before, change code, shot after, record it
S="$REVIEW/screenshots"
shot mobile "$S/fix1/add-mobile-before.png"
fix fix1-add-form-fits-phones
shot mobile "$S/fix1/add-mobile-after.png"
rk add-fix "$R" --title "Add form fits on phones" \
  --summary "The form takes the available width (up to 560px) and the input shrinks, so **Add task** stays on screen." \
  --files app/style.css --pair mobile "$S/fix1/add-mobile-before.png" "$S/fix1/add-mobile-after.png" --resolves m-1

# ---------------------------------------------------------------- 4. fix 2 as a hand-off file, as a parallel fix agent would write it
shot mobile "$S/fix2/list-mobile-before.png"
shot desktop "$S/fix2/list-desktop-before.png"
fix fix2-readable-done-tasks
shot mobile "$S/fix2/list-mobile-after.png"
shot desktop "$S/fix2/list-desktop-after.png"
cat > "$REVIEW/pending/fix2.json" <<'JSON'
{
  "fix": {
    "title": "Completed tasks are readable",
    "summary": "Done tasks use `#6b7a80` (4.6:1 on white) and keep the strike-through, so they read as done without disappearing.",
    "files": ["app/style.css"],
    "platforms": {
      "mobile": { "description": "412x915", "pairs": [{
        "before": { "src": "screenshots/fix2/list-mobile-before.png", "caption": "Done tasks are barely visible." },
        "after": { "src": "screenshots/fix2/list-mobile-after.png", "caption": "Muted but readable." } }] },
      "desktop": { "description": "1440x900", "pairs": [{
        "before": { "src": "screenshots/fix2/list-desktop-before.png" },
        "after": { "src": "screenshots/fix2/list-desktop-after.png" } }] }
    }
  },
  "marks": [
    { "issue": "m-2", "status": "fixed", "note": "Contrast 4.6:1." },
    { "issue": "d-1", "status": "fixed", "note": "Contrast 4.6:1." }
  ]
}
JSON
rk apply-pending "$R"

# ---------------------------------------------------------------- 5. fix 3
shot desktop "$S/fix3/list-desktop-before.png"
fix fix3-centred-column
shot desktop "$S/fix3/list-desktop-after.png"
rk add-fix "$R" --title "Centred reading column on desktop" \
  --summary "The page is capped at 680px and centred, so each task stays close to its delete button." \
  --files app/style.css --pair desktop "$S/fix3/list-desktop-before.png" "$S/fix3/list-desktop-after.png" --resolves d-2

# ---------------------------------------------------------------- 6. triage what is left, then build
rk mark notabug d-3 -r "$R" --note "By design: Pocket Tasks keeps tasks in memory only."
rk add-plan "$R" --group "Next" --json '{"id": "next-delete", "title": "Bigger delete button with an undo toast", "severity": "P2", "effort": "S", "files": "app/app.js, app/style.css", "issues": ["m-3"]}'
rk clean "$R" --keep-site   # drops pending/fix2.applied.json now that it is merged
rk build "$R"
echo
rk summary "$R"
echo
echo "Open review/site/index.html, or run: review-kit serve $REVIEW"
