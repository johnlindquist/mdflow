---
description: write a PR description for the current branch
---

Write a pull-request description for this branch: what changed, why, and how
to verify it. Lead with the outcome. Keep it under 200 words.

Branch commits:

!`git log --oneline main..HEAD 2>/dev/null || git log --oneline -10`

Diff summary:

!`git diff --stat main...HEAD 2>/dev/null || git diff --stat HEAD~5`
