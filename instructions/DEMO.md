---
before: 
 - ls -la
 - ls -la ~/dev
model: claude-haiku-4.5
silent: true
after: 
  - tee ./summary.md
  - code-insiders ./summary.md
---

Write a poem about these files
