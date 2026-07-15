import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	chmodSync,
	realpathSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	applyAgentGuidance,
	buildFirstRunChoices,
	buildGuidePrompt,
	buildInitReceipt,
	detectInstalledEngines,
	hasFlowRoster,
	loadCatalog,
	postFlightReport,
	scaffoldStarterFlows,
} from "./init";
import { getRegisteredAdapters } from "./adapters";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdflow-init-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("loadCatalog", () => {
	it("returns starter flows with descriptions", () => {
		const catalog = loadCatalog();
		expect(catalog.length).toBeGreaterThanOrEqual(3);
		for (const entry of catalog) {
			expect(entry.name).toEndWith(".md");
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.content).toContain("description:");
		}
		expect(catalog.map((e) => e.name)).toContain("review.md");
	});
});

describe("buildGuidePrompt", () => {
	it("fills every placeholder and embeds the catalog", () => {
		const prompt = buildGuidePrompt(
			"claude",
			["claude", "codex"],
			loadCatalog(),
		);
		expect(prompt).not.toContain("__ENGINE__");
		expect(prompt).not.toContain("__ENGINES_DETECTED__");
		expect(prompt).not.toContain("__CATALOG__");
		expect(prompt).not.toContain("__MDFLOW_VERSION__");
		expect(prompt).toContain("claude");
		expect(prompt).toContain("codex");
		expect(prompt).toContain("review.md");
		// The guide must teach dry-run verification and forbid real runs.
		expect(prompt).toContain("--_dry-run");
		expect(prompt).toContain("Never execute a real engine or eval run");
		expect(prompt).toContain("md feedback");
		expect(prompt).toContain("md evolve plan");
		expect(prompt).toContain("evolve.mode: suggest");
		expect(prompt).toContain("md eval flows/<name>.md --plan");
		expect(prompt).toContain("Interactive wait contract");
		expect(prompt).toContain("_system-prompt");
		expect(prompt).toContain("_append-system-prompt");
		expect(prompt).toContain('_task: ""');
		expect(prompt).toContain("make the entire body exactly `{{ _task }}`");
		expect(prompt).toContain("no empty or placeholder positional prompt");
	});

	it("keeps template/import examples verbatim (no expansion)", () => {
		const prompt = buildGuidePrompt("claude", ["claude"], loadCatalog());
		expect(prompt).toContain("{{ _stdin }}");
		expect(prompt).toContain("{{ _task }}");
		expect(prompt).toContain("!`git diff --cached`");
	});
});

describe("scaffoldStarterFlows", () => {
	it("creates flows/, roster README, and .mdflow.yaml", () => {
		const lines = scaffoldStarterFlows(dir, "claude");

		expect(existsSync(join(dir, "flows", "review.md"))).toBe(true);
		expect(existsSync(join(dir, "flows", "review.eval.ts"))).toBe(true);
		expect(existsSync(join(dir, "flows", "README.md"))).toBe(true);
		expect(existsSync(join(dir, ".mdflow.yaml"))).toBe(true);

		const config = readFileSync(join(dir, ".mdflow.yaml"), "utf-8");
		expect(config).toContain("engine: claude");
		expect(config).toContain("mode: suggest");

		const flow = readFileSync(join(dir, "flows", "review.md"), "utf-8");
		expect(flow).toContain("_flow_id:");

		// Catalog flows ship REAL behavioral suites, not the old length-check stub.
		const suite = readFileSync(join(dir, "flows", "review.eval.ts"), "utf-8");
		expect(suite).toContain("finds an out-of-bounds loop in a staged diff");
		expect(suite).not.toContain("returns a substantive answer");
		expect(suite).not.toContain("MDFLOW_DRAFT_CASE");

		const readme = readFileSync(join(dir, "flows", "README.md"), "utf-8");
		expect(readme).toContain("review.md");
		expect(readme).toContain("--_dry-run");
		expect(readme).toContain("Flow Workbench");
		expect(readme).toContain('md create "describe what it should do"');

		expect(lines.some((l) => l.includes("created flows/review.md"))).toBe(true);
	});

	it("never overwrites existing files", () => {
		mkdirSync(join(dir, "flows"), { recursive: true });
		writeFileSync(join(dir, "flows", "review.md"), "MINE");
		writeFileSync(join(dir, ".mdflow.yaml"), "engine: codex\n");

		const lines = scaffoldStarterFlows(dir, "claude");

		expect(readFileSync(join(dir, "flows", "review.md"), "utf-8")).toBe("MINE");
		expect(readFileSync(join(dir, ".mdflow.yaml"), "utf-8")).toBe(
			"engine: codex\n",
		);
		expect(lines.some((l) => l.includes("skipped flows/review.md"))).toBe(true);
		expect(lines.some((l) => l.includes("skipped .mdflow.yaml"))).toBe(true);
	});
});

describe("headline init experience", () => {
	it("recognizes an existing canonical roster so plain init can be a no-op", () => {
		expect(hasFlowRoster(dir)).toBe(false);

		mkdirSync(join(dir, "flows"), { recursive: true });
		writeFileSync(join(dir, "flows", "README.md"), "# Mine\n");
		writeFileSync(join(dir, "flows", "notes.md"), "Plain notes only.\n");
		expect(hasFlowRoster(dir)).toBe(false);

		writeFileSync(
			join(dir, "flows", "deploy.md"),
			"---\ndescription: deploy\n---\n",
		);
		expect(hasFlowRoster(dir)).toBe(true);
	});

	it("hands a new project directly to bare md and natural-language create", () => {
		const receipt = buildInitReceipt([
			"  created flows/review.md — review changes",
			"  created flows/README.md (roster index)",
			"  skipped .mdflow.yaml (already exists)",
		]);

		expect(receipt).toEqual([
			"mdflow is ready — 2 files created for this project.",
			"1 existing file was preserved.",
			"Next: md",
			"Inspect: md doctor --json",
			"Agent guide: flows/README.md",
			'New flow: md create "describe what it should do"',
		]);
	});

	it("makes repeat init explicitly non-destructive", () => {
		expect(buildInitReceipt([], { alreadyInitialized: true })).toEqual([
			"mdflow is ready — found an existing flows/ roster; nothing changed.",
			"Next: md",
			"Inspect: md doctor --json",
			"Agent guide: flows/README.md",
			'New flow: md create "describe what it should do"',
		]);
	});

	it("makes plain init instant and idempotent end to end", () => {
		const helper = join(dir, "run-init.ts");
		writeFileSync(
			helper,
			`import { runInit } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
process.exit(await runInit([]));`,
		);

		const first = Bun.spawnSync(["bun", "run", helper], { cwd: dir });
		expect(first.exitCode).toBe(0);
		expect(first.stdout.toString()).toContain("Next: md");
		expect(first.stdout.toString()).toContain(
			'md create "describe what it should do"',
		);
		expect(existsSync(join(dir, "flows", "review.md"))).toBe(true);
		expect(readFileSync(join(dir, ".mdflow.yaml"), "utf-8")).toContain(
			"engine: pi",
		);

		writeFileSync(join(dir, "flows", "review.md"), "MINE");
		const second = Bun.spawnSync(["bun", "run", helper], { cwd: dir });
		expect(second.exitCode).toBe(0);
		expect(second.stdout.toString()).toContain("nothing changed");
		expect(readFileSync(join(dir, "flows", "review.md"), "utf-8")).toBe("MINE");
	});

	it("refuses guided init without a TTY instead of changing operation class", () => {
		const helper = join(dir, "run-guided-init.ts");
		writeFileSync(
			helper,
			`import { runInit } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};\nprocess.exit(await runInit(process.argv.slice(2)));`,
		);
		const result = Bun.spawnSync(["bun", "run", helper, "--guided"], {
			cwd: dir,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("TTY_REQUIRED_GUIDED");
		expect(existsSync(join(dir, "flows"))).toBe(false);
	});

	it("prints the guided-setup prompt headlessly with --print-guide and writes nothing", () => {
		const helper = join(dir, "run-print-guide.ts");
		writeFileSync(
			helper,
			`import { runInit } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
process.exit(await runInit(process.argv.slice(2)));`,
		);
		const result = Bun.spawnSync(["bun", "run", helper, "--print-guide"], {
			cwd: dir,
		});
		expect(result.exitCode).toBe(0);
		const stdout = result.stdout.toString();
		expect(stdout).toContain("You are the mdflow setup guide");
		expect(stdout).toContain("Agent operations contract");
		expect(stdout).toContain("# Catalog — inspiration, adapt or ignore");
		expect(existsSync(join(dir, "flows"))).toBe(false);
		expect(existsSync(join(dir, ".mdflow.yaml"))).toBe(false);
	});

	it("opts into flows-first agent guidance with --agents", () => {
		const helper = join(dir, "run-agents-init.ts");
		writeFileSync(
			helper,
			`import { runInit } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
process.exit(await runInit(process.argv.slice(2)));`,
		);
		const result = Bun.spawnSync(["bun", "run", helper, "--yes", "--agents"], {
			cwd: dir,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("mdflow is ready");
		expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toContain(
			"md doctor --json",
		);
		expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain(
			"mdflow flows",
		);
		expect(existsSync(join(dir, "flows", "review.md"))).toBe(true);
	});

	it("scaffolds at the nearest project root when invoked from a nested directory", () => {
		const projectRoot = join(dir, "project");
		const nested = join(projectRoot, "packages", "app", "src");
		mkdirSync(join(projectRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		const helper = join(dir, "run-nested-init.ts");
		writeFileSync(
			helper,
			`import { runInit } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
process.exit(await runInit([]));`,
		);

		const result = Bun.spawnSync(["bun", "run", helper], { cwd: nested });

		expect(result.exitCode).toBe(0);
		expect(existsSync(join(projectRoot, "flows", "review.md"))).toBe(true);
		expect(existsSync(join(projectRoot, ".mdflow.yaml"))).toBe(true);
		expect(existsSync(join(nested, "flows"))).toBe(false);
		expect(existsSync(join(nested, ".mdflow.yaml"))).toBe(false);
	});
});

describe("first-run setup", () => {
	it("leads with guided handoff per detected engine and always offers free exits", () => {
		const choices = buildFirstRunChoices(["claude", "codex"]);
		expect(choices.map((choice) => choice.value)).toEqual([
			{ type: "guided", engine: "claude" },
			{ type: "guided", engine: "codex" },
			{ type: "scaffold" },
			{ type: "print" },
			{ type: "skip" },
		]);
		expect(choices[0]?.name).toContain("claude session");
	});

	it("offers scaffold, print, and skip even with no engines installed", () => {
		expect(buildFirstRunChoices([]).map((choice) => choice.value.type)).toEqual(
			["scaffold", "print", "skip"],
		);
	});

	it("applyAgentGuidance reports created files then current on repeat", () => {
		const first = applyAgentGuidance(dir);
		expect(first).toEqual([
			"  created AGENTS.md (flows-first agent guidance)",
			"  created CLAUDE.md (flows-first agent guidance)",
		]);
		const second = applyAgentGuidance(dir);
		expect(second).toEqual([
			"  skipped AGENTS.md (agent guidance already current)",
			"  skipped CLAUDE.md (agent guidance already current)",
		]);
	});

	it("applyAgentGuidance appends to an existing CLAUDE.md without touching user text", () => {
		writeFileSync(join(dir, "CLAUDE.md"), "# House rules\n\nKeep me.\n");
		const lines = applyAgentGuidance(dir);
		expect(lines).toContain("  updated CLAUDE.md (flows-first agent guidance)");
		const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
		expect(content.startsWith("# House rules\n\nKeep me.\n")).toBe(true);
		expect(content).toContain("mdflow flows");
	});
});

describe("postFlightReport", () => {
	it("reports each flow with its resolved engine", async () => {
		scaffoldStarterFlows(dir, "claude");
		const lines = await postFlightReport(dir);

		const rosterLines = lines.filter((l) => l.trimStart().startsWith("flows/"));
		expect(rosterLines.length).toBeGreaterThanOrEqual(3);
		expect(lines.join("\n")).toContain("flows/review.md");
		expect(lines.join("\n")).toContain(
			"claude (engine via config; suite inspectable; no verification claim)",
		);
		expect(lines.join("\n")).not.toContain("eval ready");
	});

	it("is read-only for legacy flows without identity or version stamps", async () => {
		mkdirSync(join(dir, "flows"), { recursive: true });
		const path = join(dir, "flows", "legacy.md");
		const source = "---\ndescription: legacy flow\n---\nBody\n";
		writeFileSync(path, source);
		await postFlightReport(dir);
		expect(readFileSync(path, "utf8")).toBe(source);
	});

	it("reports when nothing was created", async () => {
		const lines = await postFlightReport(dir);
		expect(lines.join("\n")).toContain("No flows/ directory");
	});

	it("flags unparseable flows instead of throwing", async () => {
		mkdirSync(join(dir, "flows"), { recursive: true });
		writeFileSync(
			join(dir, "flows", "broken.md"),
			"---\n: [ not yaml\n---\nbody",
		);
		const lines = await postFlightReport(dir);
		expect(lines.join("\n")).toContain("broken.md");
	});
});

describe("detectInstalledEngines", () => {
	it("only returns registered adapters", () => {
		const registered = new Set(getRegisteredAdapters());
		for (const engine of detectInstalledEngines()) {
			expect(registered.has(engine)).toBe(true);
		}
	});
});

describe("launchGuidedSession", () => {
	it("passes the guide prompt to the engine as the positional arg", async () => {
		// Stub engine: writes its argv to a file so we can inspect the invocation.
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const argsFile = join(dir, "args.txt");
		const stub = join(binDir, "mdflow-test-engine");
		writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`);
		chmodSync(stub, 0o755);

		// Bun.which snapshots PATH at process startup, so the stub must be on
		// PATH before the mdflow code runs — launch in a subprocess.
		const helper = join(dir, "helper.ts");
		writeFileSync(
			helper,
			`import { launchGuidedSession } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
const code = await launchGuidedSession("mdflow-test-engine", "GUIDE PROMPT CONTENT");
process.exit(code);`,
		);
		const proc = Bun.spawnSync(["bun", "run", helper], {
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		});

		expect(proc.exitCode).toBe(0);
		const argv = readFileSync(argsFile, "utf-8");
		expect(argv).toContain("GUIDE PROMPT CONTENT");
	});

	it("runs the guide from the supplied project root when invoked from a nested directory", () => {
		const projectRoot = join(dir, "project");
		const nested = join(projectRoot, "packages", "app");
		mkdirSync(join(projectRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		const cwdFile = join(dir, "guided-cwd.txt");
		const stub = join(binDir, "mdflow-test-engine");
		writeFileSync(stub, `#!/bin/sh\npwd > "${cwdFile}"\n`);
		chmodSync(stub, 0o755);

		const helper = join(dir, "run-guided.ts");
		writeFileSync(
			helper,
			`import { launchGuidedSession } from ${JSON.stringify(join(import.meta.dir, "init.ts"))};
const code = await launchGuidedSession("mdflow-test-engine", "GUIDE", ${JSON.stringify(projectRoot)});
process.exit(code);`,
		);

		const result = Bun.spawnSync(["bun", "run", helper], {
			cwd: nested,
			env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		});

		expect(result.exitCode).toBe(0);
		expect(readFileSync(cwdFile, "utf-8").trim()).toBe(
			realpathSync(projectRoot),
		);
	});
});
