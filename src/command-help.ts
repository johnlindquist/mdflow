/**
 * Shared usage text for management subcommands that do not own a richer help
 * renderer. The central --help gate in cli-runner prints these before any
 * handler runs, so `md <cmd> --help` can never touch the filesystem, network,
 * registry, or an interactive prompt.
 *
 * Commands with their own safe --help handling (create, init, eval, evolve,
 * feedback, complain) are deliberately absent: their help lives next to their
 * implementation and the table-driven test in cli-runner.test.ts holds every
 * command to the same contract.
 */

import { MANAGEMENT_COMMANDS as AGENT_MANAGEMENT_COMMANDS } from "./agent-contract";

/** Every management subcommand dispatched by cli-runner. */
export const MANAGEMENT_COMMANDS = AGENT_MANAGEMENT_COMMANDS.map(
	(command) => command.name,
);

/** Canonical one-line command list for usage errors. */
export const COMMAND_LIST_LINE = `Commands: ${MANAGEMENT_COMMANDS.join(", ")}`;

const HELP: Record<string, string> = {
	doctor: `Usage: md doctor [--json]

Inspect project readiness, installed engines, flow capabilities, static hook
and eval state, compatibility, and effect-labelled next actions. FREE and
read-only: it never executes engines, eval suites, hook programs, inline
commands, executable fences, URLs, or context providers, and never writes.

Examples:
  md doctor
  md doctor --json | jq '.diagnostics[] | {code, action}'`,

	explain: `Usage: md explain <flow.md> [flags] [--json]

Show the fully resolved configuration for a flow without executing it
(FREE — no engine call). Flags after the file behave exactly like a real
run, so you can preview how they change the command.

Examples:
  md explain task.claude.md
  md explain task.claude.md --model opus
  md explain flows/review.md --json     # machine-readable (Flow UX Protocol)`,

	render: `Usage: md render <flow.md> [flags] [--json] [--out <path>] [--open]

Render a flow's resolved prompt and complete configuration — engine, argv,
mode, isolation, system prompt, lifecycle hooks, inputs, config layers,
token usage, warnings — as one self-contained HTML page ready to publish
or open locally. FREE — no engine call. Env-like values are always
redacted, and the page embeds its machine-readable model as JSON
(#mdflow-render-model).

Flags after the file behave exactly like a real run (e.g. --model opus),
so the page shows what that invocation would do.

Examples:
  md render flows/review.claude.md > review.html
  md render flows/review.claude.md --open      # write to tmp + open browser
  md render flows/review.claude.md --out docs/review.html
  md render flows/review.claude.md --json      # render model only

Related: md explain (terminal view of the same analysis)`,

	hooks: `Usage: md hooks <add|list|remove> <flow.md> [event…]

Manage a flow's lifecycle hooks file: an executable, self-contained Bun
TypeScript program named after the flow (review.codex.md →
review.codex.hooks.ts) and discovered automatically on every run. LOCAL
WRITE only — never calls an engine. Runtime hook integration is currently
verified for Codex CLI and Claude Code; unsupported engines fail rather than
silently dropping hooks.

Events: sessionStart, userPromptSubmit, preToolUse, postToolUse,
permissionRequest, preCompact, postCompact, subagentStart, subagentStop,
stop, sessionEnd

Examples:
  md hooks add review.codex.md stop userPromptSubmit
  md hooks add review.codex.md            # interactive event picker (TTY)
  md hooks list review.codex.md
  md hooks remove review.codex.md stop
  md hooks remove review.codex.md --yes   # delete the hooks file

Related: _hooks frontmatter key (false disables; a path overrides), --_hooks CLI flag`,

	roster: `Usage: md roster --json
       md roster sync [--check] [--agents] [--json]

Print every runnable flow as one Flow UX Protocol JSON object. Sync updates
only mdflow's marked operator-card block in flows/README.md and preserves all
user-authored text. sync is LOCAL WRITE; sync --check is FREE and never writes.

--agents opts the project into flows-first agent guidance: it creates or
refreshes one managed mdflow block in AGENTS.md and CLAUDE.md at the project
root so coding agents hand matching tasks off to flows. EVERY guidance write
requires --agents (a marker already in the repo is data, not the current
user's authorization); plain sync is README-only and reports guidance drift.

Examples:
  md roster --json | jq -r '.flows[].id'
  md roster sync
  md roster sync --agents
  md roster sync --check --json`,

	install: `Usage: md install <url|gh:org/repo/path/to/flow.md[@ref]> [--global]

Install a flow into the registry. Project scope is the default; --global
installs for the current user. Remote domains are trusted on first use
(stored in ~/.mdflow/known_hosts).

Examples:
  md install https://example.com/review.claude.md
  md install gh:acme/flows/review.claude.md@main
  md install gh:acme/flows/review.claude.md --global

Related: md list, md remove <name>`,

	remove: `Usage: md remove <name> [--global]

Remove an installed registry flow by name.

Examples:
  md remove review.claude
  md remove review.claude --global

Related: md list`,

	list: `Usage: md list [--global|--project]

List installed registry flows (name, scope, source, hash, path).
For every runnable flow across all rosters, use: md roster --json

Examples:
  md list
  md list --global`,

	setup: `Usage: md setup

Interactively configure your shell for mdflow (PATH entries and aliases).
Requires a TTY: it previews every change and confirms before writing to
your shell config. In non-interactive sessions it exits with an error
instead of prompting.`,

	logs: `Usage: md logs

Print the flow log directory and list per-flow log folders. FREE.`,
};

/**
 * Usage text for subcommands covered by the central --help gate.
 * Returns undefined for commands that render their own help (or for flow
 * files, which pass --help through to the engine).
 */
export function subcommandHelpText(subcommand: string): string | undefined {
	return HELP[subcommand];
}
