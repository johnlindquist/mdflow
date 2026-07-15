export const AGENT_CONTRACT_VERSION = 1 as const;

export type OperationEffect = "FREE" | "LOCAL_WRITE" | "ENGINE";
export type ConsentRule =
	| "none"
	| "caller-invoked"
	| "interactive-only"
	| "interactive-or-yes"
	| "explicit-local-effect";

export interface ManagementCommandContract {
	name: string;
	usage: string;
	summary: string;
	json: boolean;
}

export interface OperationContract {
	id: string;
	command: string;
	summary: string;
	effect: OperationEffect;
	consent: ConsentRule;
	network?: boolean;
	executesLocalCode?: boolean;
	sourceMayChange?: boolean;
	localProcess?: boolean;
}

export interface SafetyRule {
	code: string;
	text: string;
}

export const MANAGEMENT_COMMANDS = [
	{
		name: "doctor",
		usage: "doctor [--json]",
		summary:
			"Inspect project readiness and safe next actions without execution",
		json: true,
	},
	{
		name: "init",
		usage: "init [--guided] [--engine <e>] [--yes] [--agents] [--print-guide]",
		summary: "Initialize a project flow roster",
		json: false,
	},
	{
		name: "create",
		usage: "create [intent] [--global] [--dry-run]",
		summary: "Create a flow and a fail-closed draft eval suite",
		json: false,
	},
	{
		name: "explain",
		usage: "explain <flow.md> [--json]",
		summary: "Resolve one flow without launching its engine",
		json: true,
	},
	{
		name: "render",
		usage: "render <flow.md> [--json|--out <path>|--open]",
		summary: "Inspect, write, or open a rendered flow explanation",
		json: true,
	},
	{
		name: "hooks",
		usage: "hooks add|list|remove <flow.md> [event...]",
		summary: "Manage executable lifecycle hook sidecars",
		json: false,
	},
	{
		name: "eval",
		usage: "eval <flow.md> [--plan] [--yes] [--json]",
		summary: "Plan or run a flow's behavioral eval suite",
		json: true,
	},
	{
		name: "feedback",
		usage:
			"feedback <flow.md> <message> | list|show|distill|dismiss|reopen|forget",
		summary: "Manage durable evolution evidence",
		json: true,
	},
	{
		name: "complain",
		usage: "complain <flow.md> <message>",
		summary: "Compatibility alias for feedback",
		json: true,
	},
	{
		name: "evolve",
		usage:
			"evolve plan|status|propose|show|apply|reject|retry|rollback|history|prune",
		summary: "Manage proposal-first flow evolution",
		json: true,
	},
	{
		name: "install",
		usage: "install <url|gh:org/repo/path@ref> [--global]",
		summary: "Install one flow into the registry",
		json: false,
	},
	{
		name: "remove",
		usage: "remove <name>",
		summary: "Remove an installed registry flow",
		json: false,
	},
	{
		name: "list",
		usage: "list [--project|--global]",
		summary: "List installed registry flows",
		json: false,
	},
	{
		name: "roster",
		usage: "roster --json | roster sync [--check] [--agents] [--json]",
		summary: "Inspect flows or synchronize the managed operator card",
		json: true,
	},
	{
		name: "setup",
		usage: "setup",
		summary: "Configure shell integration",
		json: false,
	},
	{
		name: "logs",
		usage: "logs",
		summary: "Show flow log locations",
		json: false,
	},
	{
		name: "help",
		usage: "help [command]",
		summary: "Show CLI or command help",
		json: false,
	},
] as const satisfies readonly ManagementCommandContract[];

export const OPERATIONS = [
	{
		id: "project.inspect",
		command: "md doctor --json",
		summary:
			"Inspect engines, flows, proof, hooks, compatibility, and next actions",
		effect: "FREE",
		consent: "none",
	},
	{
		id: "project.init",
		command: "md init --yes",
		summary: "Create a deterministic starter roster",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		sourceMayChange: true,
	},
	{
		id: "project.init-guided",
		command: "md init --guided",
		summary:
			"Launch an engine-guided setup session that may write an approved roster",
		effect: "ENGINE",
		consent: "interactive-only",
		sourceMayChange: true,
	},
	{
		id: "project.init-handoff",
		command: "md init --print-guide",
		summary:
			"Print the guided-setup prompt for pasting into any agent harness",
		effect: "FREE",
		consent: "none",
	},
	{
		id: "flow.create-preview",
		command: "md create <intent> --dry-run",
		summary: "Preview flow creation without writing",
		effect: "FREE",
		consent: "none",
	},
	{
		id: "flow.create",
		command: "md create <intent>",
		summary: "Create a flow and fail-closed draft eval suite",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		sourceMayChange: true,
	},
	{
		id: "flow.explain",
		command: "md explain <flow.md> --json",
		summary:
			"Resolve one invocation without launching its engine; URL imports and context providers may resolve",
		effect: "FREE",
		consent: "none",
		network: true,
		executesLocalCode: true,
	},
	{
		id: "render.inspect",
		command: "md render <flow.md> --json",
		summary:
			"Build the render model; imports and context providers may resolve",
		effect: "FREE",
		consent: "none",
		network: true,
		executesLocalCode: true,
	},
	{
		id: "render.write",
		command: "md render <flow.md> --out <path>",
		summary: "Resolve a flow and write rendered HTML",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		network: true,
		executesLocalCode: true,
	},
	{
		id: "render.open",
		command: "md render <flow.md> --open",
		summary:
			"Resolve a flow, write temporary HTML, and launch the local opener",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		network: true,
		executesLocalCode: true,
		localProcess: true,
	},
	{
		id: "flow.dry-run",
		command: "md <flow.md> --_dry-run",
		summary:
			"Resolve imports and print a command plan without launching the engine",
		effect: "FREE",
		consent: "none",
		network: true,
	},
	{
		id: "flow.run",
		command: "md <flow.md>",
		summary: "Execute one real flow invocation",
		effect: "ENGINE",
		consent: "caller-invoked",
	},
	{
		id: "hooks.list",
		command: "md hooks list <flow.md>",
		summary: "Inspect hook events statically",
		effect: "FREE",
		consent: "none",
		executesLocalCode: false,
	},
	{
		id: "hooks.write",
		command: "md hooks add <flow.md> <event>",
		summary: "Create or edit an executable hook sidecar",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		sourceMayChange: true,
	},
	{
		id: "eval.plan",
		command: "md eval <flow.md> --plan",
		summary: "Inspect cases and exact planned invocation count",
		effect: "FREE",
		consent: "none",
		executesLocalCode: false,
	},
	{
		id: "eval.run",
		command: "md eval <flow.md> --yes",
		summary: "Load the consented executable suite and run its cases",
		effect: "ENGINE",
		consent: "interactive-or-yes",
		executesLocalCode: true,
	},
	{
		id: "feedback.record",
		command: "md feedback <flow.md> <message>",
		summary: "Record private evolution evidence",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
	},
	{
		id: "evolve.plan",
		command: "md evolve plan <flow.md>",
		summary: "Inspect evolution readiness, cost, capabilities, and writes",
		effect: "FREE",
		consent: "none",
	},
	{
		id: "evolve.propose",
		command: "md evolve propose <flow.md> --yes",
		summary: "Draft and verify a private off-path proposal",
		effect: "ENGINE",
		consent: "interactive-or-yes",
		executesLocalCode: true,
	},
	{
		id: "evolve.apply",
		command: "md evolve apply <run-id>",
		summary: "Atomically apply a reviewed proposal",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		sourceMayChange: true,
	},
	{
		id: "roster.inspect",
		command: "md roster --json",
		summary: "Enumerate discoverable flows",
		effect: "FREE",
		consent: "none",
	},
	{
		id: "roster.check",
		command: "md roster sync --check",
		summary: "Check whether the managed operator card is current",
		effect: "FREE",
		consent: "none",
	},
	{
		id: "roster.sync",
		command: "md roster sync",
		summary:
			"Synchronize the managed operator card and any opted-in agent guidance blocks",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		sourceMayChange: true,
	},
	{
		id: "roster.sync-agents",
		command: "md roster sync --agents",
		summary:
			"Opt the project into flows-first agent guidance blocks in AGENTS.md and CLAUDE.md",
		effect: "LOCAL_WRITE",
		consent: "explicit-local-effect",
		sourceMayChange: true,
	},
] as const satisfies readonly OperationContract[];

export const SAFETY_RULES = [
	{
		code: "SEPARATE_RUN_CONSENT",
		text: "A real flow run, eval run, proposal run, and source mutation require separate consent.",
	},
	{
		code: "EVALS_ARE_EXECUTABLE",
		text: "Eval sidecars are executable local TypeScript; static plans do not import them, but real eval runs do.",
	},
	{
		code: "HOOKS_ARE_EXECUTABLE",
		text: "Hook sidecars are executable local TypeScript and must be reviewed before use.",
	},
	{
		code: "PROPOSAL_IS_NOT_APPLY",
		text: "Evolution creates a private proposal; applying it is a separate explicit source mutation.",
	},
	{
		code: "ISOLATION_IS_NOT_HOST_SANDBOX",
		text: "Engine context isolation is not a filesystem, network, process, environment, or credential sandbox.",
	},
	{
		code: "DRY_RUN_MAY_RESOLVE_IMPORTS",
		text: "Dry-run skips engines, inline commands, and executable fences, but file, URL, and context-provider imports may still resolve.",
	},
	{
		code: "REGISTRY_SIDECARS_NOT_INSTALLED",
		text: "Registry install adds one flow, not trusted eval or hook sidecars.",
	},
	{
		code: "VERIFIED_REQUIRES_CURRENT_FULL_RECEIPT",
		text: "A suite's presence is not verification; Verified requires a current fingerprint-bound full-run receipt.",
	},
	{
		code: "COMPAT_STAMPS_ARE_RUNTIME_MANAGED",
		text: "Compatibility stamps are managed by successful local runs, not by diagnostics.",
	},
] as const satisfies readonly SafetyRule[];

export function agentContractFacts() {
	return {
		contractVersion: AGENT_CONTRACT_VERSION,
		commands: MANAGEMENT_COMMANDS,
		operations: OPERATIONS,
		safetyRules: SAFETY_RULES,
	};
}

export function renderAgentContractMarkdown(): string {
	const operations = OPERATIONS.map(
		({ command, effect, summary }) =>
			`- **${effect}** \`${command}\` — ${summary}.`,
	).join("\n");
	const safety = SAFETY_RULES.map(
		({ code, text }) => `- \`${code}\`: ${text}`,
	).join("\n");
	return [
		"## Agent operations contract",
		"",
		"Start every maintenance task with `md doctor --json`. Branch on stable diagnostic codes and effect-labelled next actions rather than scraping prose.",
		"",
		"### Operations",
		operations,
		"",
		"### Safety invariants",
		safety,
	].join("\n");
}
