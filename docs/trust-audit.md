# mdflow trust audit

**Decision:** keep the CLI and Markdown format; enforce policy where text becomes an action, a file becomes an installed flow, or a proposal replaces source. This addresses failures that a rewrite of the UI or a larger test count would not, by itself, fix.

The starting point was `e3777512bf92d7ab82b6e515430c3b1cfb0cc286`. Its 2,376 tests passed in a temporary home. Nevertheless, running the actual CLI with harmless local fixtures established the following failures:

| Boundary | Counterexample on the starting revision | Enforced behavior and observable check |
| --- | --- | --- |
| Prompt → shell | Piping a literal `` !`touch injected-by-stdin` `` into a flow containing only `{{ _stdin }}` created the file. | Parse the **authored flow** for actions. Bind those actions within Liquid's scope; don't parse the rendered prompt for shell syntax. A subprocess receives the literal bytes, the marker stays absent, and intentionally authored commands still work in loops with quoted inputs. |
| Preview → execution | `--events --_dry-run` ran a fixture engine and emitted `run.completed`. | Reject incompatible modes before processing hooks or imports. Stdout must contain `protocol`, then `run.error`; neither engine nor inline marker may exist. |
| Prompt → engine | A prompt over `_max_prompt_tokens: 1` failed in the CLI but succeeded with `--events`. | Check at dispatch, on the final prompt for each engine attempt, including workflow steps and retries. A failing `_output` validator also prevents a successful terminal event. |
| File import → filesystem | A symlink inside the invocation directory exposed the bytes of a file outside it. | Resolve the physical target against the import root. Tests distinguish a working in-root link from a refused escaping link, including range and symbol reads. |
| Registry record → filesystem | `md remove` deleted a fixture outside the registry because a project lockfile named it as `installedPath`. | Resolve only registry-relative members; check path components; verify the actual bytes before use/removal. Subprocess tests move the project, run both concurrent installs, change the installed bytes, and try an alias and a forged removal target. |

## Other findings and checks

- **Network:** a host check on only the initial URL does not govern redirects. Flow downloads now refuse cross-origin redirects; context imports re-check the caller's policy at every hop. A second HTTP server counts forbidden requests: the passing count is **zero**, not merely an error after fetching. A streaming fixture sends headers and then stalls to test the body deadline. Cached remote bytes must match their recorded digest, including when reusing an expired response after a 304.
- **Child processes:** inline commands and executable fences share pipe draining, output limits, a deadline through exit, and cleanup. The timeout regression closes both output descriptors *before* sleeping and checks for an absent late write. Tests of process groups are POSIX evidence, not Windows qualification.
- **Proposal evidence:** a successful eval does not prove that tomorrow's `proposal.md` contains the tested bytes. Apply and rollback check both stored snapshots against the run hashes; altering either artifact is a refusal, not a new verdict. Tests also cover a changed suite, an edited live flow, a persistence failure after replacement, and refusal to add frontmatter to a body-only proposal. Local fixture runners supply the eval outputs in these tests. They establish the transaction rules, not the quality of a model's revisions.
- **Private state:** workflow cache keys include the flow/step, rendered inputs, explicit environment and positional mapping. The records need not retain a second plaintext copy of the prompt, flags or environment. A cache hit is a replay, not fresh execution evidence: arbitrary tool versions, network responses, ambient environment and external files are not sealed by this cache. Private state may still contain sensitive **output**.
- **Supply chain:** the starting production lock included a critical LiquidJS advisory and high-severity parser advisories. The CLI and site lockfiles were refreshed, and the unused `pino-pretty` runtime dependency removed. The full CLI development graph still reports [glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) and [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249) in release tooling, both moderate at audit time. They are not production dependencies. Keep release inputs trusted and update the upstream tooling rather than forcing incompatible major versions into npm's dependency tree.

## Reproduce

From the repository root, with Bun 1.3.14 and Node/npm:

```sh
bun install --frozen-lockfile
(cd site && bun install --frozen-lockfile)
bun run test:trust           # focused boundaries, hooks, evals, evolution
bun run verify               # types, full CLI suite, generated contracts, packed consumer
(cd site && bun run verify)  # site tests, types, production build and prerender
bun run security:check       # current registry advisories; needs network
```

The test preload assigns private home/state paths before module discovery. Behavioral probes use temp projects, real `md` subprocesses, local fixture executables and loopback HTTP; they require no provider credentials. The package check uses `npm pack`, installs that tarball outside the checkout, and runs the **installed binaries** for scaffold, static eval planning, dispatch and refusal. A checkout-only success cannot satisfy that check. PR and release verification use the same read-only GitHub workflow; publish permissions belong only to the separate release job.

## Scope and limits

These checks cover host-side mdflow behavior. They do not certify arbitrary flow authors, third-party engines, model output, a production deployment, or a hostile process running as the same OS user. Local hashes detect drift, not forgery of an entire store. Atomic replacement and cooperative locks do not make a transaction across arbitrary filesystem writers. A URL hostname policy is not DNS/IP egress control. A shell command deliberately assembled by a flow author can still execute its arguments unsafely. Use `md doctor --json` for static inspection and an OS sandbox for untrusted execution. See [SECURITY.md](../SECURITY.md).

The design borrows [one capability, every surface](https://ratstack.sh/lore/one-capability-every-surface), [the fence](https://ratstack.sh/lore/the-fence), and [tests with an independent observable answer](https://ratstack.sh/skills/test-behaviour) from Ratstack. Here the shared capability is engine dispatch, the fence is the required verification workflow, and the evidence is what the child process, filesystem or HTTP server actually observed. No cloud service or new runtime framework is needed.
