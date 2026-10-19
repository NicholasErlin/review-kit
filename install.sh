#!/usr/bin/env bash
# Install or update review-kit, put `review-kit` on PATH and add its skill to your coding agents.
#
#   curl -fsSL https://raw.githubusercontent.com/NicholasErlin/review-kit/main/install.sh | bash
#   ~/review-kit/install.sh                   # from a clone: uses that clone instead of cloning again
#
# Options (after `bash -s --` when piped):
#   --dir DIR          where the kit lives (default ~/review-kit, or the clone this script is in)
#   --bin DIR          where to link the `review-kit` command (default ~/.local/bin)
#   --skills-dir DIR   also link the skill into this agent skills folder (repeatable)
#   --no-skill         don't link the skill anywhere
#   --with-companions  also link the bundled skills UI/UX and backend reviews use (ui-ux-pro-max, and
#                      api-design-principles, architecture-patterns, error-handling-patterns from wshobson/agents)
#
# The skill is symlinked, not copied, so `git pull` in the kit (or re-running this script) keeps it current.
# By default it is linked into ~/.claude/skills when ~/.claude exists. Pass --skills-dir for other agents.
# Environment: REVIEW_KIT_REPO overrides the git URL to clone.
set -euo pipefail

# Everything runs from main(), called on the last line: if `curl | bash` is cut off mid-download, bash only
# sees an unfinished function definition and runs nothing.
main() {
REPO="${REVIEW_KIT_REPO:-https://github.com/NicholasErlin/review-kit.git}"
DIR=""
BIN="$HOME/.local/bin"
SKILLS=()
NO_SKILL=0
COMPANIONS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    --skills-dir) SKILLS+=("$2"); shift 2 ;;
    --no-skill) NO_SKILL=1; shift ;;
    --with-companions) COMPANIONS=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "install.sh: $1 is required" >&2; exit 1; }; }
need python3
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || { echo "install.sh: Python 3.8+ is required" >&2; exit 1; }

# ---------------------------------------------------------------- 1. get or update the kit
HERE=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -z "$DIR" ] && [ -n "$HERE" ] && [ -x "$HERE/bin/review-kit" ]; then
  DIR="$HERE"
  say "using the clone at $DIR"
else
  DIR="${DIR:-$HOME/review-kit}"
  if [ -d "$DIR/.git" ]; then
    say "updating $DIR"
    git -C "$DIR" pull --ff-only --quiet || say "warning: could not update $DIR (local changes?); using it as it is"
  elif [ -e "$DIR" ]; then
    echo "install.sh: $DIR exists but is not a git clone; move it or pass --dir" >&2
    exit 1
  else
    need git
    say "cloning $REPO into $DIR"
    git clone --quiet "$REPO" "$DIR"
  fi
fi
DIR="$(cd "$DIR" && pwd)"

# ---------------------------------------------------------------- 2. the command
mkdir -p "$BIN"
ln -sfn "$DIR/bin/review-kit" "$BIN/review-kit"
say "linked $BIN/review-kit"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "note: $BIN is not on your PATH. Add this to your shell profile: export PATH=\"$BIN:\$PATH\"" ;;
esac

# ---------------------------------------------------------------- 3. the skill
link_skill() {
  local target="$1/review-kit"
  mkdir -p "$1"
  if [ -L "$target" ]; then
    rm "$target"
  elif [ -e "$target" ]; then
    # Outside the skills folder, so the agent doesn't load the old copy as a second skill.
    local agent; agent="$(basename "$(dirname "$1")")"
    local backup="$HOME/.review-kit-backups/${agent#.}-skill-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$HOME/.review-kit-backups"
    mv "$target" "$backup"
    say "moved the old copy of the skill to $backup"
  fi
  ln -s "$DIR/skill/review-kit" "$target"
  say "linked the skill into $1"
}
if [ "$NO_SKILL" = 0 ]; then
  if [ ${#SKILLS[@]} -eq 0 ] && [ -d "$HOME/.claude" ]; then
    SKILLS=("$HOME/.claude/skills")
  fi
  for d in ${SKILLS[@]+"${SKILLS[@]}"}; do
    link_skill "$d"
  done
  if [ ${#SKILLS[@]} -eq 0 ]; then
    say "no agent skills folder found; pass --skills-dir DIR, or run \`review-kit attach\` in a repo to point its AGENTS.md at the skill"
  fi
fi

# ---------------------------------------------------------------- 4. companion skills (optional)
if [ "$COMPANIONS" = 1 ]; then
  args=()
  for d in ${SKILLS[@]+"${SKILLS[@]}"}; do args+=(--skills-dir "$d"); done
  python3 "$DIR/bin/review-kit" companions install ${args[@]+"${args[@]}"}
fi

say ""
say "review-kit $(python3 "$DIR/bin/review-kit" --version | awk '{print $2}') is ready. In a repo, run:"
say "  review-kit attach --name \"My App\" --kind ui,backend"
[ "$COMPANIONS" = 1 ] || say "Optional companion skills for UI/UX and backend reviews: review-kit companions"
}

main "$@"
