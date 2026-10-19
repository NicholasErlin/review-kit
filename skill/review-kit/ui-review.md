# UI/UX review playbook

Use this for a review with `project.kind: "ui"` (or no kind). Evidence is a before/after screenshot pair at every viewport you verified. The steps for recording things are in `SKILL.md`; this file covers what to look for and how to rank it.

Audit and report first. Fix only the issues the user approves (see "Report first, fix only when told" in `SKILL.md`).

## Companion skill: ui-ux-pro-max

It ships with review-kit. `review-kit companions --kind ui` shows where it is. Read its `SKILL.md` before auditing, then use its search tool to back each finding with a rule:

```bash
UIPRO="$(review-kit companions --path ui-ux-pro-max)"
python3 "$UIPRO/scripts/search.py" "touch target size spacing" --domain ux
python3 "$UIPRO/scripts/search.py" "focus ring keyboard navigation" --domain ux
python3 "$UIPRO/scripts/search.py" "<component or bug>" --stack <stack>   # only if the project's stack is listed
```

- Search for one observable problem at a time, in 2 to 5 words. Retry once with narrower wording if the result is off-topic. Don't cite results that don't match.
- Use its priority table (accessibility, then touch, performance, layout, type and colour, and so on) to set severity. The mapping is below.
- Cite the rule in the issue details, for example `Rule (ui-ux-pro-max, ux): touch targets at least 44x44px.`
- Its `references/pro-rules.md` has a pre-delivery checklist. Run through it before you call the round done.
- Search results are recommendations. They never override the user, the repo's own design rules, or the existing design system.

If its search tool won't run (it needs Python 3), use the checklist below on its own.

## What to check

Check each area at every platform the review covers. Usually that's 412x915 for mobile and 1440x900 for desktop.

1. **Accessibility.** Text contrast at least 4.5:1 (3:1 for large text and UI parts). Visible focus states. Everything reachable with Tab, in a sensible order. Labels on icon-only buttons and form fields. Alt text. Colour never the only signal.
2. **Touch and interaction.** Targets at least 44x44px with gaps between them. Feedback on press. Loading and disabled states. Nothing that only works on hover.
3. **Layout and responsive.** No horizontal scroll, clipped controls or overlapping text. Sensible line lengths on wide screens. Safe areas on phones. Zoom not disabled.
4. **Typography and colour.** Body text at least 16px on mobile, with readable line height. One clear hierarchy. Colours come from the theme, not one-off values.
5. **Forms and feedback.** Visible labels, not placeholder-only. Errors next to the field. Empty, loading, error and success states all exist.
6. **Navigation.** Predictable back behaviour. The current location is shown. Deep links work. Destructive actions are confirmed or can be undone.
7. **Performance you can see.** Layout shift, slow first paint, oversized images, janky animation. Respect `prefers-reduced-motion`.
8. **Consistency.** The same thing looks and behaves the same everywhere: spacing, radii, icon style, button hierarchy, dark mode.

## Severity

| Severity | Use for |
| --- | --- |
| P0 | Blocks a task or excludes users: content or controls unreachable, unreadable or broken. Accessibility failures on a core flow. |
| P1 | A clear usability or accessibility problem with a workaround. Touch targets, contrast, missing states, confusing navigation. |
| P2 | Polish and consistency. |

## Evidence

- Use the same URL, viewport, data and steps before and after. If the bug needs a dialog open or a scroll position, script it with `--steps`.
- Open both images and look at them before recording the fix.
- For accessibility fixes that a screenshot can't show (focus order, labels), add a sentence on how you checked it to the fix summary, for example "Tabbed through the form: focus now goes name, email, submit."
