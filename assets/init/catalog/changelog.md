---
description: draft a changelog entry from recent commits
---

Draft a concise changelog entry for the unreleased changes below. Group by
feature/fix/chore, write for users (not committers), no commit hashes.

!`git log --oneline -30`

!`git diff --stat HEAD~10 2>/dev/null || true`
