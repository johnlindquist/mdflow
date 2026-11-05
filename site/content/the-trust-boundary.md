---
title: A prompt is not a shell — mdflow field notes
description: Follow a line of text from stdin to the engine. Where can it become an action? Five boundaries, the tests that caught them, and what changes for your flows.
---

# A prompt is not a shell.

`FIELD NOTES / 01` &nbsp; `MDFLOW · EXECUTION`

Picture a reviewer reading a patch. The patch adds a line to a README: “Run this command to start the server.” You want the reviewer to *read* that instruction. You do not want the review tool to start the server.

That distinction got lost in mdflow. The CLI could take text from stdin, put it into a flow, then scan the result for inline shell commands. By then, the line the author wrote and the line that arrived in the patch looked identical. **All 2,376 tests passed. A file that should never have existed was sitting on disk.**

This field note describes the hardened source revision `46b14d5`. The npm 4.9.0 release predates these changes; do not rely on these protections in that version.

## Draw the line before the text comes in

Imagine this small review flow:

```markdown
---
description: review a patch
---

Read this patch. Flag changes that might break a caller.
{{ _stdin }}
```

The flow author wrote one instruction and left a slot for data. In the hardened renderer, mdflow identifies executable spans in the **flow source**, before it fills that slot. A shell marker arriving in a patch reaches the engine as text. So does a Liquid expression inside an imported style guide. Neither gets a second turn at the parser.

You can still ask the flow itself to run `git diff --cached`. Put that command in the reviewed flow, not in a file you import as context. And if you deliberately interpolate outside input into a POSIX shell command, pass it as a standalone `| q`-filtered argument. A shell you *choose* to invoke is still a shell.

## The same run gets the same rules

`--events` streams what a real run does. `--dry-run` asks for an inspection. Combining the two used to launch an engine. Now the CLI refuses the contradictory request before an engine or inline command starts. An event consumer sees `protocol` followed by `run.error`, not a reassuring progress stream for work nobody meant to run.

The prompt budget also gets checked at the point that matters: **the final prompt, just before each engine attempt**. A workflow step doesn't get an exemption. Neither does a retry. A structured-output validator that rejects the answer prevents a successful terminal event.

> Need strictly static inspection? Use `md doctor --json`. Dry-run skips the engine and inline commands, but it can still resolve file, URL, and context-provider imports.

## Follow the bytes, not the label

| When you… | What mdflow checks |
| --- | --- |
| Import a file | The resolved target stays inside the import root. A symlink is a route, not permission to read its destination. |
| Run an installed flow | The actual Markdown bytes match the SHA-256 in the registry lock. A familiar filename isn't enough. |
| Fetch a remote flow | A redirect cannot quietly move executable content to a different origin. Context URL policies apply before each request, not after following a link. |
| Apply or roll back a proposal | Both stored snapshots still match their recorded hashes before the live file is replaced. Yesterday's green eval isn't evidence for today's edited proposal. |

If you keep installed flows in Git, commit **both** the reviewed Markdown and its lock. To customize one, copy it outside the registry and edit the copy. A hash can tell you the bytes changed. It can't tell you the publisher is trustworthy, or protect you from someone who controls both files.

## Ask the filesystem

The regression test for the stdin bug has two witnesses. A real child process reports the exact text it received. The test then asks the filesystem whether the unwanted marker exists. The correct answer is **no**. The redirect test uses a second HTTP server as its witness: the number of forbidden requests it should receive is **zero**.

That's the useful idea behind Ratstack's [fence](https://ratstack.sh/lore/the-fence): give a rule a check that can actually fail. Its [one capability, every surface](https://ratstack.sh/lore/one-capability-every-surface) principle matters for the same reason. A human at a terminal and an agent reading NDJSON shouldn't get two versions of the rule.

```sh
# From a checkout, with dependencies installed. No model subscription needed.
bun run test:trust
bun run verify
```

At that revision, a clean checkout passed **2,395 CLI tests and 57 site tests**. Verification also packed the npm tarball, installed it outside the repository, and ran the installed binaries. That last step answers a different question from “does it work in the developer's checkout?”

This is evidence about mdflow, not a sandbox for third-party programs. A flow you authorize can still run commands with your account's permissions. Review flows like code; run unfamiliar ones in a disposable environment. The [security policy](https://mdflow.dev/SECURITY.md) explains the host permissions that still matter.
