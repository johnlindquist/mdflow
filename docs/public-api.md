# mdflow public API reference

This document defines the stable user-facing API for `mdflow` CLI usage.

## CLI command contract

Run `mdflow` or `md` with one of these forms:

```bash
md                                # interactive Flow Workbench
md <agent.md> [flags...]
md <subcommand> [options...]
md.<command> "prompt" [flags...]   # ad-hoc, no file required
```

Supported subcommands:

| Command | Description |
| --- | --- |
| `md` | Open the interactive Flow Workbench, including the zero-flow state. Browse/filter with a Markdown and lifecycle preview; run, dry-run, edit, create, record feedback, or enter the proposal-first evolution path. Every action shows its shell equivalent and `FREE`, `ENGINE`, or `LOCAL WRITE` effect before execution. Apply and rollback require a second `Enter`/`c` confirmation on a dedicated local-write screen. |
| `md init [--guided] [--engine <e>] [--yes]` | Safely scaffold a starter flow roster with zero engine invocations. Plain init is a no-op when `flows/` already has a roster. `--guided` launches an installed agent CLI with the bundled setup guide for a repo-tailored session; an explicit `--engine` preserves that guided behavior unless `--yes` is also present. |
| `md create "<intent>"` | Create a stable-identity project flow at `flows/<slug>.md` from plain-language intent. Pass `--global` to create a personal, user-scoped flow at `~/.mdflow/<slug>.md` that is available from any project. Uses create-only writes and never overwrites an existing flow. With no intent in a TTY, asks one question. |
| `md explain <agent.md> [--json]` | Print resolved config and prompt without execution (free — no engine call). `--json` emits the Flow UX Protocol v1 explanation object (see "Machine-facing Flow UX protocol"). |
| `md eval <flow.md> [--plan] [--yes] [--filter <text>] [--json]` | Preview or run the flow's executable colocated eval suite (`<flow>.eval.ts`). Cost includes repetitions and is printed before consent. |
| `md feedback <flow.md> "<message>"` | Record durable, private evidence with a stable ID (free). `list`, `show`, `distill`, `dismiss`, `reopen`, and explicit permanent `forget <id> --yes` manage its lifecycle/privacy. |
| `md complain ...` | Compatibility alias for `md feedback`. |
| `md evolve plan\|status\|propose <flow.md> [--yes] [--engine <e>] [--json\|--events]` | Plan for free or create a private, capability-checked, off-path proposal. Source remains unchanged. |
| `md evolve show\|review\|apply\|reject\|retry\|rollback <run-id>` | Inspect the receipt/diff, make an explicit decision, retry, or perform hash-guarded apply/rollback. |
| `md evolve history [flow.md]` | List durable evolution runs. |
| `md evolve prune [--days <n>] [--yes]` | Delete eligible old private proposal/job data while retaining applied lineage. |
| `md install <url\|gh:org/repo/path@ref>` | Install a flow from a URL or GitHub shorthand into the registry (project scope by default; `--global` for user scope). Writes `.mdflow/mdflow.lock.json`. |
| `md remove <name>` | Remove an installed registry flow. |
| `md list [--project\|--global]` | List installed registry flows. |
| `md roster --json` | Machine-readable enumeration of project (`<projectRoot>/flows/`), global (`~/.mdflow/`), and registry (`.mdflow/registry/`) flows as a single Flow UX Protocol v1 JSON object. Documents (no frontmatter, no engine marker) are excluded. Always exits 0; soft failures land in `warnings`. |
| `md --version` | Print the bare mdflow version string (capability handshake for machine callers). |
| `md setup` | Configure shell integration. |
| `md logs` | Show log directory and per-agent logs. |
| `md help` | Print CLI help. |

Flows can set `evolve.mode` to `off`, `observe`, `suggest`, `propose`, or the reserved `apply` tier. `propose` prints a content-current plan and queues private background work after explicit actionable feedback; it never applies source. Legacy `evolve: auto` maps to `propose`. Quick reruns are low-confidence observations only. See [`evolve.md`](evolve.md) for the full policy, evidence state machine, receipts, and security boundary.

Eval suites export a statically resolvable default array (directly or through a
top-level `const`). This lets `--plan` derive names, evidence links,
repetitions, quorum, and cost without importing executable suite code. After
consent, runtime shape must match the announced static plan before any flow
invocation starts.

## mdflow-reserved flags

These flags are consumed by mdflow and are not passed to underlying LLM CLIs.

| Flag | Description |
| --- | --- |
| `--engine` | Select the engine explicitly (top rung of the resolution ladder). Deprecated aliases: `--_command`, `-_c`, `--tool`. |
| `--_dry-run` | Print the command plan and prompt without running the engine, inline `!command` imports, or executable code fences. File/URL/context imports are still resolved. |
| `--_edit` | Open resolved prompt in `$EDITOR` before execution. |
| `--_trust` | Skip TOFU trust prompt for remote URLs. |
| `--_no-cache` | Bypass remote URL cache. |
| `--_context` | Print context tree and exit. |
| `--_quiet` | Skip preflight context dashboard. |
| `--_no-menu` | Disable post-run action menu. |
| `--no-evolve`, `--_no-evolve` | Disable post-run evolution observation/proposal handling for this invocation. `MDFLOW_EVOLVE=off` is the environment equivalent. |
| `--raw` | Emit raw markdown output (no terminal renderer). |
| `--json` | Emit a single JSON result object (`{exitCode, command, args, stdout, stderr}`) and disable interactive UI. |
| `--events` | Stream NDJSON run events on stdout (Flow UX Protocol v1). Implies non-interactive; human rendering is suppressed. See "Machine-facing Flow UX protocol". |

Interactive mode controls are also supported:

| Flag | Description |
| --- | --- |
| `--_interactive`, `-_i` | Force interactive mode for supported adapters. |

## Engine resolution

The engine that runs a flow is resolved by a ladder, most explicit first:

1. `--engine` CLI flag (deprecated aliases: `--_command`/`-_c`, `--tool`).
2. `MDFLOW_ENGINE` environment variable.
3. Filename suffix (`task.claude.md`). The segment only wins when it names a
   registered adapter or a binary on `PATH`; otherwise it falls through with a
   `Warning [ENGINE_NOT_FOUND]`.
4. Frontmatter `engine:` (deprecated aliases: `tool:`, `_tool:` — they still
   work but warn).
5. Config `engine:` (project config beats `~/.mdflow/config.yaml`).
6. Built-in default: `pi`.

Resolution never fails for a missing engine — the default always applies. A
file with no frontmatter and no explicit engine is a document, not a flow:
`md README.md` prints it instead of executing it.

Bundled engine adapters: `claude`, `codex`, `copilot`, `gemini`*, `droid`,
`opencode`, `pi` (default), `cursor-agent`, `agy` (Google Antigravity).

\* Google sunset the gemini CLI for individual accounts in June 2026; the
gemini adapter remains only for Gemini Code Assist Standard/Enterprise orgs.
Use `agy` otherwise.

## Frontmatter contract

### Core behavior

- All non-system frontmatter keys are forwarded as CLI flags.
- Values map as:
  - `key: "value"` -> `--key value`
  - `key: true` -> `--key`
  - `key: false` -> omitted
  - `key: [a, b]` -> `--key a --key b`

### System keys

| Key | Type | Behavior |
| --- | --- | --- |
| `description` | Flow metadata: human/roster-facing summary; never passed as a CLI flag. |
| `route` | Reserved for keyword routing; never passed as a CLI flag. |
| `engine` | string | Names the engine that runs the flow (deprecated aliases: `tool`, `_tool`). |
| `_inputs` | `string[]` or typed object | Declares template variables and prompt UI. |
| `_env` | `Record<string, string \| number \| boolean>` | Sets environment variables for command execution. Values are coerced to strings. |
| `_interactive`, `_i` | boolean-ish | Enables interactive mode transforms. |
| `_cwd` | string | Overrides execution working directory for inlines/commands. |
| `_subcommand` | string or string[] | Prepends subcommand tokens to generated args. |
| `$1`, `$2`, ... | string | Maps positional prompt body to named flag(s). |
| `context_window` | number | Overrides context token-window estimation. |
| `_mdflow_version` | string | mdflow version the flow was created with. Stamped automatically by `md create`/`md init`; never a CLI flag. |
| `_compat` | string | Newest mdflow version verified to run the flow successfully. Stamped/upgraded automatically after clean local runs; never a CLI flag. |
| `_flow_id` | string | Stable identity used by feedback and proposal receipts across rename/clone; stamped by `md create`/`md init`, never passed as a CLI flag. |
| `evolve` | string or policy object | Proposal-first evolution policy. Valid modes: `off`, `observe`, `suggest`, `propose`, `apply`; legacy `auto` maps to `propose`. Never passed as a CLI flag. |

### Compatibility stamps

Flows track which mdflow they work with, fully automatically:

- `md create` and `md init` stamp `_mdflow_version` at creation time.
- After any successful local run, mdflow records the running version in
  `_compat` (added if missing; upgraded when the recorded version is behind
  on major or minor — patch/prerelease skew never rewrites files). Remote
  flows and eval workspaces are never stamped; failed stamps never affect
  the run.
- On a major-version mismatch between the recorded version and the running
  mdflow, a dim one-line notice is printed to stderr; execution is never
  blocked, and the next clean run re-verifies the flow.
- A file whose frontmatter contains only these stamps still counts as a
  document for the document-vs-flow decision.

### `_inputs` typed object format

Each `_inputs` key must start with `_`, and each value must be one of:

- `text`: optional `default` (string)
- `select`: required `options` (non-empty string array), optional `default`
- `number`: optional `default`, `min`, `max`
- `confirm`: optional `default` (boolean)
- `password`: optional `default` (string)

## Configuration files and precedence

Configuration merge order (lowest -> highest precedence):

1. Built-in command defaults.
2. Global config: `~/.mdflow/config.yaml`.
3. Project config at git root:
   - `mdflow.config.yaml`
   - `.mdflow.yaml`
   - `.mdflow.json`
4. Project config at current working directory (same file names).
5. Agent frontmatter.
6. CLI passthrough flags.

Within a single directory, lookup order is:

1. `mdflow.config.yaml`
2. `.mdflow.yaml`
3. `.mdflow.json`

## Machine-facing Flow UX protocol (`protocolVersion: 1`)

Three contracts let GUIs and agents drive mdflow without scraping terminal
output. All three are versioned together under `protocolVersion: 1`; callers
should verify it (via `md --version` + `md roster --json`) before relying on
the shapes below.

### `md roster --json`

One-shot. Prints a single JSON object to stdout and exits 0 even when
directories are missing or unreadable (soft failures go to `warnings`):

| Field | Description |
| --- | --- |
| `protocolVersion` | Always `1`. |
| `cwd` | Absolute process cwd at invocation. |
| `projectRoot` | Resolved project root (config > `flows/` dir > git root > cwd), or `null`. |
| `flows[]` | Project flows first (alphabetical), then global, then registry. |
| `warnings[]` | Human-readable soft failures. |

Each flow: `id` (stable `<source>:<slug>`, slug = filename stem), `path`,
`source` (`project`\|`global`\|`registry`), `name`, `description` (or `null`),
`engine` + `engineSource` (resolved via the normal engine ladder,
config-aware), `inputs[]` (from `_inputs`: `{name, type, message, options?,
default}`; `options` only for `select`), `isWorkflow` (has `_steps`),
`interactive` (`_interactive`/`_i` or `.i.` filename marker), and `mtimeMs`.
Documents — markdown files with no frontmatter and no engine marker — are
excluded.

### `md explain <flow> --json`

Free (no engine call). Prints one JSON object: `protocolVersion`, `flowId`,
`path`, `engine`, `command` (executable), `args` (full argv including the
prompt positional; `promptIncluded` says whether the prompt rides in argv),
`cwd` (effective run cwd with `_cwd`/`--_cwd` applied), `prompt` (fully
resolved, untruncated), `promptTokensEstimate` (~chars/4), `inputs` (same
shape as roster), `warnings`, and `configFingerprint` (`sha256:<hex>` over the
resolved config + flow content + mdflow version — cache explanations keyed on
`(path, mtimeMs, cwd, mdflowVersion, configFingerprint)`). `--_<name>` value
overrides are applied to the prompt exactly as a run would.

### `md <flow> --events`

NDJSON run event stream on stdout; stdout is protocol-pure (every line is one
JSON object). Engine output is carried inside `output.delta` events,
JSON-escaped, never interleaved raw. Diagnostics may appear on stderr as free
text. Common envelope on every event:

```json
{ "protocolVersion": 1, "seq": 0, "runId": "r-<uuid>", "ts": 1752000000000, "event": "..." }
```

`seq` starts at 0 and increments by 1 with no gaps. Order contract:
`protocol` first, `run.started` second, exactly one terminal event
(`run.completed` \| `run.error` \| `run.cancelled`) last.

| Event | Payload |
| --- | --- |
| `protocol` | `{mdflowVersion}` |
| `run.started` | `{flowId, path, engine, command, args, cwd, pid}` |
| `output.delta` | `{channel: "stdout"\|"stderr", text}` |
| `step.started` | `{stepId, needs}` (workflow `_steps` only) |
| `step.completed` | `{stepId, exitCode, cached}` |
| `run.completed` | `{exitCode, durationMs}` |
| `run.error` | `{exitCode\|null, message, durationMs}` (nonzero exit, spawn failure, or pre-run error) |
| `run.cancelled` | `{signal, durationMs}` |

`--events` implies non-interactive: `_inputs` values must arrive as
`--_<name> <value>` overrides, and a TTY-only interactive flow emits
`run.error` with message `interactive flow requires a terminal`. On SIGTERM,
mdflow forwards the signal to the engine child, emits `run.cancelled`, and
exits cleanly.

## URL import policy API

URL imports (`@https://...`) support only `http://` and `https://`.

Policy environment variables:

| Variable | Purpose |
| --- | --- |
| `MDFLOW_IMPORT_URL_ALLOWLIST` | Allowlist rules (comma/newline-separated). |
| `MDFLOW_IMPORT_URL_BLOCKLIST` | Blocklist rules (comma/newline-separated). |
| `MDFLOW_URL_ALLOWLIST` | Legacy alias for allowlist. |
| `MDFLOW_URL_BLOCKLIST` | Legacy alias for blocklist. |

Rule formats:

- Hostname: `example.com`
- Host+port: `example.com:8443`
- Wildcard domain: `*.example.com`
- URL prefix: `https://example.com/v1/`
- Match-all: `*`

Blocklist is evaluated before allowlist.

## Timeout environment variables

| Variable | Default (ms) | Applies to |
| --- | --- | --- |
| `MDFLOW_FETCH_TIMEOUT` | `10000` | HTTP fetch operations. |
| `MDFLOW_COMMAND_TIMEOUT` | `30000` | Inline command execution. |
| `MDFLOW_AGENT_TIMEOUT` | `0` | Agent process execution (`0` means disabled). |

## Error codes

Structured failures expose stable error codes, shown as:

```text
[ERROR_CODE] message
```

Known error codes:

| Code | Meaning |
| --- | --- |
| `MDFLOW_UNKNOWN` | Unknown/untyped failure. |
| `CONFIG_FILE_READ_FAILED` | Config file could not be read. |
| `CONFIG_FILE_PARSE_FAILED` | Config file parse error (YAML/JSON). |
| `CONFIG_FILE_VALIDATION_FAILED` | Config failed schema validation. |
| `CONFIG_FILE_DISCOVERY_FAILED` | Config discovery or git-root lookup failed. |
| `ENV_FILE_READ_FAILED` | `.env` file could not be read. |
| `IMPORT_FILE_NOT_FOUND` | Local import path missing. |
| `IMPORT_FILE_READ_FAILED` | Local import path exists but could not be read. |
| `IMPORT_BINARY_FILE` | Binary import rejected. |
| `IMPORT_CIRCULAR_DEPENDENCY` | Circular import detected. |
| `IMPORT_COMMAND_FAILED` | Inline command import failed. |
| `IMPORT_URL_FETCH_FAILED` | URL import fetch or policy check failed. |
| `COMMAND_MISSING` | Legacy (v2) — no longer raised; engine resolution falls back to the default engine. |
| `COMMAND_INVALID` | Invalid command token format. |
| `COMMAND_NOT_FOUND` | Command binary not available on `PATH`. |
| `COMMAND_EXECUTION_FAILED` | Spawned command failed at runtime. |
| `TEMPLATE_MISSING_VARIABLE` | Required template variable missing. |
| `TEMPLATE_PROCESSING_FAILED` | Liquid/template processing failed. |
| `SECURITY_TRUST_FAILED` | Trust or security policy validation failed. |
| `INPUT_LIMIT_EXCEEDED` | Input/context limit exceeded. |
| `PROMPT_TOKEN_LIMIT` | Resolved prompt exceeded `_max_prompt_tokens`. |
| `NETWORK_REQUEST_FAILED` | Generic network request failure. |
| `HOOK_EXECUTION_FAILED` | Hook execution failed. |
| `VALIDATION_FAILED` | Generic validation failure. |
| `USER_CANCELLED` | User cancelled interactive operation. |
| `EARLY_EXIT` | Non-error early termination path. |
