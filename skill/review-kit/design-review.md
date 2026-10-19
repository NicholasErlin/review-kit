# Design proposals playbook

Use this for a review with `project.kind: "design"`. A proposal is one decision, for example "how should first-run onboarding work". You build 2 or 3 genuinely different options, each on its own branch, score them against criteria agreed up front, and recommend one. The user picks. The steps for recording things are in `SKILL.md`.

Design options are built only on their own branches and worktrees. Never edit the user's branch. The user's branch changes only through `rk adopt`, which you run only when the user names the option to adopt.

## Companion skills

`review-kit companions --kind design` shows where they are.

- UI options: `ui-ux-pro-max`. Use its search tool to back scores with rules, as in `ui-review.md`.
- API, data or architecture options: `api-design-principles`, `architecture-patterns`, `error-handling-patterns`, as in `backend-review.md`.

Cite them in score notes when they back a claim, for example `Rule (ui-ux-pro-max, ux): touch targets at least 44x44px.`

## 1. Brief and criteria, before building

- Start from a `go` idea (`--idea i-1`, it may live in the ideas review) or from the user's own request.
- Write the brief: what is being decided, for whom, and the constraints (stack, size limits, what must not change).
- Pick 3 to 6 criteria and weight them 1 to 5. Good criteria are things you can judge from the built option: clarity for the user, accessibility, how much code and state it adds, performance, how easy it is to undo. Avoid criteria every option meets.
- Tell the user the criteria and weights before you build, and adjust them if they ask. Criteria chosen after seeing the options tend to favour the one you already like.

```bash
rk add-proposal design --id first-run --title "First-run experience" --idea i-1 \
  --brief "Decide what a new user sees on an empty list. Constraints: no backend, under 30 changed lines." \
  --criterion "clarity=First task without help:3" --criterion "a11y=Accessible:3" \
  --criterion "quiet=Stays out of the way:2" --criterion "cost=Small to build and keep:2"
```

Proposal and option ids use lower-case letters, digits and `-`; they become branch names.

## 2. Two or three genuinely different options

- Each option is a different approach, not a colour or copy variant of the same one. In each option's summary, say what makes it distinct from the others.
- Include the simplest credible option. It is often the right one, and it keeps the others honest.

## 3. Build each option on its own branch

```bash
rk option new design first-run empty-state --title "Teaching empty state"
```

This creates branch `design/first-run/empty-state` from `HEAD` (or `--base REF`) and a worktree outside the repo, in `<repo>.designs/first-run--empty-state`. It prints the path.

- Work only in that worktree. Keep the change minimal: enough to judge the option for real, not a finished feature.
- Commit on the option branch. Uncommitted changes are not in the diff snapshot, and `option record` warns about them.
- Run the project's tests and linters in the worktree and keep the output for the evidence.
- Use the same base commit for every option of a proposal.

## 4. Same evidence for every option

- **UI options:** take screenshots of the same screens, at the same viewports (usually 412x915 and 1440x900), with the same data and steps, for every option. Run each worktree's app (on its own port) or follow the user's instructions on how to run it, then `rk shot --url ... --viewport mobile --out /tmp/shots/<option>-mobile.png`. Never start servers or databases the project rules forbid.
- **Backend options:** run the same tests, benchmarks or commands against each option and record the output.
- Open and look at every screenshot before you score. If you can't view images, say so to the user.

## 5. Record, score and recommend

```bash
rk option record design first-run empty-state \
  --summary "A dashed panel explains the empty list and how to add a task." \
  --reasoning "Help sits where the user is already looking (r-1); no stored state." \
  --pro "Help where the user looks" --con "Teaches adding only" \
  --score "clarity=4:One sentence and a visible field; ticking is not explained." \
  --score "a11y=5:Real label, focus order unchanged, reflows at 320px." \
  --evidence $'```\n$ npm test\n12 passing\n```' \
  --shot mobile /tmp/shots/empty-state-mobile.png "First run, empty list"
```

`option record` also saves the diff of the branch (`diffs/<proposal>--<option>.patch`) so the site can show it even after the branch is gone. Run it again after each new commit.

- **Score every option on every criterion,** 1 to 5, with a note that explains the score from what you built and saw. A score without a note is an opinion.
- **Be honest about the option you prefer.** Record its weaknesses as cons and in its scores. If the comparison only works because the other options were built badly, build them better.
- **Recommend one** with `rk recommend design first-run empty-state --reasoning "..."`. Say why it wins, which criteria decided it, and when another option would be the better choice.

`rk validate` warns about weak proposals: fewer than 2 options, no criteria, options with no reasoning or missing scores, and an open proposal with no recommendation. Fix them before you report.

## 6. Report and stop

- Build the site and send the user the proposal link. Summarise in a few lines: the options, the weighted totals, your recommendation and its main weakness.
- Ask which option to adopt, or whether to change the criteria or try another option. A good ending is: "3 options built. I recommend empty-state (94/100); sample-tasks is better if ... Which should I adopt?"
- Don't adopt on your own, even if one option is clearly best.

## 7. Adopt and clean up, only on the user's word

- When the user names an option: `rk adopt design first-run empty-state`. It squash-merges the option branch into the current branch and commits (`--no-commit` leaves it staged). It refuses on a `design/*` branch or with uncommitted changes outside the review folders. It never pushes.
- On a conflict it stops and leaves git's state as it is. Tell the user, resolve it only if they ask, or undo with `git reset --merge`. After resolving by hand, `rk adopt ... --record-only` records the adoption.
- Then suggest a UI or backend review of the adopted result, so it gets the usual before/after evidence.
- Offer `rk discard design first-run` to remove the other options' branches and worktrees (`--dry-run` first). Run it only when the user agrees. The diffs and screenshots stay, so the site still shows every option.
