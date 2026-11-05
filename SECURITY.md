# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through this repository's
[GitHub Security Advisories](https://github.com/johnlindquist/mdflow/security/advisories/new).
Do not open a public issue with exploit details. Include the affected version,
reproduction steps, impact, and any suggested mitigation. You should receive an
acknowledgement within seven days.

Security fixes target the current major release. Older majors may receive a
fix when the change is practical, but they are not guaranteed support.

## Execution model

mdflow intentionally launches local agent CLIs and can evaluate inline shell
commands, executable code fences, executable `.hooks.ts` and `.eval.ts`
sidecars, file imports, URL imports, and context providers declared by a
flow. Treat a flow like code:

- Review untrusted flow files before running them.
- Eval and hook sidecars are executable local TypeScript; review them before
  running the flow. Registry install downloads one flow, never its sidecars,
  and registry provenance is re-verified at run time.
- Direct remote runs require trust-on-first-use approval before imports are expanded, unless the caller explicitly supplies `--_trust`. Remembering an origin trusts **all paths** on its scheme, host and port; a legacy bare-host entry applies to HTTPS on the default port only. A multi-tenant host is not an author identity. Executable downloads refuse cross-origin HTTP redirects; review the destination URL separately.
- Registry locks bind the installed Markdown bytes used for execution. Missing or mismatched pins and symlinked managed paths are refused. A lock does not authenticate its publisher or protect against a writer who can replace both the flow and the lock.
- Stdin, input arguments and imported context cannot create inline commands or executable fences. Shell interpolation *inside a command written by the flow author* remains shell programming. Use a standalone `| q`-filtered argument with a POSIX shell; do not use untrusted strings as scripts, options, interpreters or command names.
- `--_dry-run` does not launch the engine, inline `!command` imports, or
  executable code fences. It still resolves file, URL, and context-provider
  imports, so it is an inspection aid rather than a security sandbox.
- Engine context isolation strips supported ambient agent configuration. It
  does not isolate the host filesystem, network, environment, credentials, or
  child processes.
- Use `--_trust` only in automation where the remote source is already
  authenticated and pinned by your own controls.
- Consent boundaries are separate and non-transferable: a flow run, an eval
  run, an evolution proposal, and a source-mutating apply each require their
  own consent. Evolution never rewrites a flow without an explicit
  `md evolve apply <run-id>`; `evolve: auto` queues proposal-only work.
- Local output validators are executable modules. Direct remote and installed flows cannot select a local `_output.schema` sidecar. An explicitly authored output save/patch or shell command still has the rights of its process.
- Evolution checks the hashes of both stored snapshots before apply or rollback. Receipts, locks, workflow caches, and eval evidence are local state, **not signatures or a hostile-user boundary**. Treat prompts, captured output, logs and project snapshots as potentially sensitive.
- Use `md doctor --json` for static readiness. From a source checkout, `bun run test:trust` exercises the refusal paths without paying for an engine invocation.

When running third-party flows in CI, prefer a disposable runner with
least-privilege credentials and restricted network access.
