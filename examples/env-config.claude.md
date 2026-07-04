---
# Environment variables (object form) - sets process.env
# These are available to the command and any !`command` inlines
_env:
  BASE_URL: https://dev.build
  DEBUG: true
model: sonnet
print: true
---

How do you like my url? !`echo $BASE_URL`


