# Ideas and research playbook

Use this for a review with `project.kind: "ideas"`. The output is research findings with sources, and ideas with the reasoning behind them. The steps for recording things are in `SKILL.md`; this file covers how to research, how to reason, and when to stop.

Ideation only researches and proposes. It never builds anything: no edits to the project's code, config or dependencies, no branches, no commits. Building comes later, in a design review, and only for ideas the user says go to.

## 1. Frame the question

Before any research, write down what you are trying to decide. Put it in the review description (`project.description`):

- **Question.** One sentence, for example "How should a new user learn the app?"
- **Goal.** What should be better, and for whom.
- **Users.** Who is affected and in what situation.
- **Constraints.** Budget, stack, platforms, rules from the user or the repo.
- **Success looks like.** Something you could observe or measure.

If the user's request leaves any of these open and the answer would change the ideas, ask before researching.

## 2. Research before ideas

Look in this order, and record each finding with `rk add-research` as you go:

1. **The codebase.** What exists today, what data is available, what the code makes easy or hard. Cite files as `path/file.js:42`.
2. **The project's own material.** README, docs, issues, past reviews in `.review/`, analytics or support notes the user can share.
3. **Primary sources.** Official docs, standards and specs (WCAG, MDN, platform guidelines, RFCs).
4. **Credible data and studies.** Research groups, peer-reviewed work, published measurements. Say how big and how recent the evidence is.
5. **Comparable products.** How others solve the same problem, and what that shows. Describe what you saw; don't guess at their results.

Use web search and fetch when you have them. If you don't, say so plainly in the review description and in your report, and say what that limits (for example "no external sources checked; findings come from the codebase only").

```bash
rk add-research ideas --title "Users skip tutorial carousels" \
  --summary "**Fact:** ... **Inference:** ..." \
  --source "NN/g: Mobile-app onboarding=https://www.nngroup.com/articles/mobile-app-onboarding/" \
  --quote "Deck-of-cards tutorials are often quickly swiped through and forgotten." \
  --kind article --confidence high --tags onboarding
```

Every research entry needs:

- **A source a reader can open.** A URL, or a repo path for code. Web sources get an accessed date (`--accessed`, today by default).
- **A short quote or number where possible.** Copy it exactly; keep it short.
- **Fact apart from inference.** In the summary, mark what the source says and what you conclude from it.
- **A confidence.** `high`: a primary source or several agreeing ones. `medium`: one credible secondary source, or indirect evidence. `low`: a single weak source or your own reading.

Rules:

- Never invent a source, URL, quote or number. If you can't find support for something, record it as `low` confidence and say it is unsupported, or leave it out.
- Prefer primary sources over articles about them.
- When sources disagree, record both and say which you trust more and why.
- Record counter-evidence too: findings that argue against the idea you like.

## 3. Ideas: breadth, then depth

First list many possible answers, including plain ones and "do nothing". Then cut to the strongest few (usually 3 to 6). Don't pad the list; a weak idea recorded only to look thorough makes the real ones harder to judge.

Each idea you record must have:

- **Problem.** What is wrong today, for whom, with the research id that shows it.
- **Proposal.** What you would do, concretely enough that someone could design it.
- **Reasoning.** Why this, why now, and how the evidence supports it. Name the research ids (`r-1`, `r-3`) and say what each one shows. Link them with `--evidence`.
- **Alternatives.** At least one other approach, including "do nothing", and why it lost.
- **Risks.** What could go wrong and how to reduce it.
- **Effort, impact and confidence.** `S`, `M` or `L`, and `low`, `medium` or `high`. Justify each in one line in the reasoning, for example "Effort S: two files, no new state."
- **What would change the call.** The evidence that would make you drop or promote it. Put it at the end of the reasoning.

```bash
rk add-idea ideas --title "Teach through the empty list" \
  --problem "New users see a blank list (r-3)." \
  --proposal "Show one sentence and a **Create your first task** button when the list is empty." \
  --reasoning "Tours get skipped (r-1); empty states are where users look (r-2). Effort S: one component. Impact M: affects every new user. Would change: usage data showing new users already add tasks." \
  --evidence r-1,r-2,r-3 --alternatives "**Carousel tour:** skipped (r-1). **Do nothing:** the blank list stays confusing." \
  --risks "The text could be ignored too. Keep it to one line and one button." \
  --pro "Small change" --con "Only helps on first run" --effort S --impact M --confidence high
```

`rk validate` warns about weak entries: research with no sources, and ideas with no reasoning, evidence, alternatives or risks. Fix every warning before you report, or explain in the reasoning why the part doesn't apply. The site shows missing parts as "Not given".

## 4. Report and stop

- Rank the ideas (`--rank 1`, `2`, ...) by what you would do first. Put a plan item per idea you would take forward only if the user wants a plan.
- Build the site and give the user a short ranked shortlist: each idea in one line, with its impact, effort, confidence and the strongest piece of evidence.
- Ask which to take forward. A good ending is: "4 ideas, ranked. I suggest go on i-1 and i-2. Which should go to design?"
- Record the user's call with `rk decide ideas i-1 go --note "<the user's reason>"` (also `maybe`, `no`, `done`). Only the user decides; never set `go` yourself.
- A `go` idea moves to a design review (`design-review.md`). Don't start building in this review.
