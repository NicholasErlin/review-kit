<!-- review-kit:begin -->
## Review tracking (review-kit)

When reviewing or fixing this repo across several steps, record the work with review-kit: issues found, fixes
shipped with their evidence (before/after screenshots for UI, code and test output for backend), and what is
left. A review run only reports problems; apply fixes only for the issues the user approves. The reviews live in:

- UI/UX: `.review/ui/review.json`
- Backend practices: `.review/backend/review.json`

Before starting, read the review-kit skill: run `review-kit home` and open `skill/review-kit/SKILL.md` in the
folder it prints. It points to a playbook per review kind. If `review-kit` is not installed, install it with:

    curl -fsSL https://raw.githubusercontent.com/NicholasErlin/review-kit/main/install.sh | bash
<!-- review-kit:end -->
