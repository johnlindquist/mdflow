/**
 * Chaos-monkey regressions (2026-07-17): every case here reproduces a real
 * failure found by fuzzing the CLI surface with hostile-but-plausible input.
 * Keep each test tied to the concrete symptom it locks down.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	writeFileSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, parseRawFrontmatter } from "./parse";
import { unusedCliVarWarnings, CliRunner } from "./cli-runner";
import { parseCliArgs } from "./cli";
import { expandContentImports } from "./imports";
import { runCommand } from "./command";
import type { RunContext, RunResult } from "./command";
import { runHooksCli } from "./hooks-cli";
import { analyzeAgent } from "./explain";
import {
	createTestEnvironment,
	type InMemorySystemEnvironment,
} from "./system-environment";
import { clearConfigCache } from "./config";
import { substituteTemplateVars } from "./template";
import { stampCompatFile } from "./compat";
import { statSync, chmodSync } from "node:fs";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdflow-chaos-"));
	clearConfigCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	clearConfigCache();
});

describe("unclosed frontmatter (silent raw-file prompt)", () => {
	const unclosed = "---\nmodel: x\nbody never starts\n";

	it("parseRawFrontmatter stays lenient but flags the condition", () => {
		const raw = parseRawFrontmatter(unclosed);
		expect(raw.unclosedFrontmatter).toBe(true);
		expect(raw.body).toBe(unclosed);
	});

	it("parseFrontmatter refuses — the whole file would become the prompt", () => {
		expect(() => parseFrontmatter(unclosed)).toThrow(/closing '---' fence is missing/);
	});

	it("a closed frontmatter block does not trip the guard", () => {
		const parsed = parseFrontmatter("---\nmodel: x\n---\nbody\n");
		expect(parsed.frontmatter.model).toBe("x");
		expect(parsed.body).toBe("body");
	});
});

describe("unused CLI variable flags (typos silently ran flows)", () => {
	it("flags a typo'd system flag with a did-you-mean hint", () => {
		const warnings = unusedCliVarWarnings(["_dry_run"], [], []);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("--_dry_run");
		expect(warnings[0]).toContain("Did you mean --_dry-run?");
	});

	it("flags an unknown var without a hint when nothing is close", () => {
		const warnings = unusedCliVarWarnings(["_totally_bogus_thing"], [], []);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain("Did you mean");
	});

	it("stays silent for vars the body references or _inputs declare", () => {
		expect(unusedCliVarWarnings(["_name"], ["_name"], [])).toHaveLength(0);
		expect(unusedCliVarWarnings(["_topic"], [], ["_topic"])).toHaveLength(0);
	});
});

describe("CliRunner warning + positional behavior", () => {
	let env: InMemorySystemEnvironment;

	beforeEach(() => {
		env = createTestEnvironment();
	});

	const capture = () => {
		const state: { ctx?: RunContext } = {};
		const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
			state.ctx = ctx;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				output: "",
				process: null as unknown as ReturnType<typeof Bun.spawn>,
			};
		};
		return { state, runCommandFn };
	};

	it("warns on stderr when an ad-hoc --_var is never used", async () => {
		env.addFile("/test/plain.echo.md", "---\n---\nhello\n");
		const { runCommandFn } = capture();
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: true,
				cwd: "/test",
				runCommandFn,
			});
			const result = await runner.run([
				"node",
				"md",
				"/test/plain.echo.md",
				"--_dry_run",
			]);
			expect(result.exitCode).toBe(0);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toContain("UNUSED_VARIABLE_FLAG");
			expect(stderr).toContain("Did you mean --_dry-run?");
		} finally {
			errSpy.mockRestore();
		}
	});

	it("warns when positional args are provided but never referenced", async () => {
		env.addFile("/test/plain.echo.md", "---\n---\nhello\n");
		const { runCommandFn } = capture();
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: true,
				cwd: "/test",
				runCommandFn,
			});
			await runner.run(["node", "md", "/test/plain.echo.md", "one", "two"]);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toContain("UNUSED_POSITIONAL_ARGS");
		} finally {
			errSpy.mockRestore();
		}
	});

	it("does not warn when {{ _1 }} consumes the positional", async () => {
		env.addFile("/test/uses.echo.md", "---\n---\nUsing {{ _1 }}\n");
		const { state, runCommandFn } = capture();
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: true,
				cwd: "/test",
				runCommandFn,
			});
			await runner.run(["node", "md", "/test/uses.echo.md", "one"]);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).not.toContain("UNUSED_POSITIONAL_ARGS");
			expect(state.ctx?.positionals[0]).toBe("Using one");
		} finally {
			errSpy.mockRestore();
		}
	});

	it("legacy _inputs consumes positional args in declaration order", async () => {
		env.addFile(
			"/test/legacy.echo.md",
			"---\n_inputs: [_message]\n---\nMsg: {{ _message }}\n",
		);
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run([
			"node",
			"md",
			"/test/legacy.echo.md",
			"hello there",
		]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.positionals[0]).toBe("Msg: hello there");
	});

	it("a CLI flag beats the positional occupying the same legacy slot", async () => {
		env.addFile(
			"/test/legacy2.echo.md",
			"---\n_inputs: [_message]\n---\nMsg: {{ _message }}\n",
		);
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run([
			"node",
			"md",
			"/test/legacy2.echo.md",
			"positional-value",
			"--_message",
			"flag-value",
		]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.positionals[0]).toBe("Msg: flag-value");
	});
});

describe("line-range imports beyond EOF (silently empty context)", () => {
	it("errors when the start line is past the end of the file", async () => {
		writeFileSync(join(dir, "tiny.ts"), "line1\nline2\n");
		await expect(
			expandContentImports("@./tiny.ts:100-200", dir, new Set(), false, {
				invocationCwd: dir,
			}),
		).rejects.toThrow(/out of range.*3 lines/);
	});

	it("clamps a forgiving end line while the start is valid", async () => {
		writeFileSync(join(dir, "tiny.ts"), "line1\nline2\n");
		const result = await expandContentImports(
			"@./tiny.ts:1-999",
			dir,
			new Set(),
			false,
			{ invocationCwd: dir },
		);
		expect(result).toContain("line1");
		expect(result).toContain("line2");
	});
});

describe("oversized prompt (raw E2BIG from the OS)", () => {
	it("translates the spawn failure into an actionable PROMPT_TOO_LARGE error", async () => {
		const huge = "a".repeat(10_000_000);
		const ctx: RunContext = {
			command: "echo",
			args: [],
			positionals: [huge],
			positionalMappings: new Map(),
			captureOutput: "capture",
		};
		await expect(runCommand(ctx)).rejects.toThrow(/PROMPT_TOO_LARGE/);
	});
});

describe("hooks remove never leaves a run-blocking empty file", () => {
	let out: string[];
	let err: string[];
	const runtime = (over: Record<string, unknown> = {}) => ({
		cwd: dir,
		isTTY: false,
		log: (m: string) => out.push(m),
		error: (m: string) => err.push(m),
		...over,
	});

	beforeEach(() => {
		out = [];
		err = [];
	});

	it("refuses to remove the last handler without consent (non-TTY, no --yes)", async () => {
		writeFileSync(join(dir, "task.codex.md"), "---\n---\nhi\n");
		expect(await runHooksCli(["add", "task.codex.md", "stop"], runtime())).toBe(0);
		const hooksPath = join(dir, "task.codex.hooks.ts");
		const before = readFileSync(hooksPath, "utf8");

		expect(await runHooksCli(["remove", "task.codex.md", "stop"], runtime())).toBe(1);
		expect(err.join("\n")).toContain("blocks every run");
		// Nothing changed: the file still handles its event.
		expect(readFileSync(hooksPath, "utf8")).toBe(before);
	});

	it("deletes the file when the last handler is removed with --yes", async () => {
		writeFileSync(join(dir, "task.codex.md"), "---\n---\nhi\n");
		expect(await runHooksCli(["add", "task.codex.md", "stop"], runtime())).toBe(0);
		const hooksPath = join(dir, "task.codex.hooks.ts");

		expect(
			await runHooksCli(["remove", "task.codex.md", "stop", "--yes"], runtime()),
		).toBe(0);
		expect(existsSync(hooksPath)).toBe(false);
	});

	it("removing one of two handlers still edits in place", async () => {
		writeFileSync(join(dir, "task.codex.md"), "---\n---\nhi\n");
		expect(
			await runHooksCli(["add", "task.codex.md", "stop", "sessionStart"], runtime()),
		).toBe(0);
		const hooksPath = join(dir, "task.codex.hooks.ts");

		expect(await runHooksCli(["remove", "task.codex.md", "stop"], runtime())).toBe(0);
		expect(existsSync(hooksPath)).toBe(true);
		expect(readFileSync(hooksPath, "utf8")).toContain("sessionStart");
		expect(readFileSync(hooksPath, "utf8")).not.toContain("\n  stop: async");
	});
});

describe("TUI chaos round (2026-07-17): installed-flow findings", () => {
	let env: InMemorySystemEnvironment;

	beforeEach(() => {
		env = createTestEnvironment();
	});

	const capture = () => {
		const state: { ctx?: RunContext } = {};
		const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
			state.ctx = ctx;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				output: "",
				process: null as unknown as ReturnType<typeof Bun.spawn>,
			};
		};
		return { state, runCommandFn };
	};

	it("refuses to spawn a print-mode engine with an empty resolved prompt", async () => {
		// council.copilot.md (an empty file) reached copilot, which failed
		// with "No prompt provided" AFTER the engine launch.
		env.addFile("/test/empty.echo.md", "---\n---\n\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/empty.echo.md"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("EMPTY_PROMPT");
		expect(state.ctx).toBeUndefined();
	});

	it("still opens interactive mode with an empty body (no prompt submitted)", async () => {
		env.addFile("/test/empty-i.echo.md", "---\n---\n\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: true,
			isStdoutTTY: true,
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run([
			"node",
			"md",
			"/test/empty-i.echo.md",
			"--_interactive",
		]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.interactive).toBe(true);
	});

	it("warns when the body references a non-underscore Liquid global", async () => {
		// hi.echo.md printed "Hello !" — {{place}} rendered as empty with no
		// hint that mdflow variables need the underscore prefix.
		env.addFile("/test/legacyvar.echo.md", "---\n---\nHello {{place}}!\n");
		const { runCommandFn } = capture();
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: true,
				cwd: "/test",
				runCommandFn,
			});
			const result = await runner.run(["node", "md", "/test/legacyvar.echo.md"]);
			expect(result.exitCode).toBe(0);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).toContain("UNRESOLVED_TEMPLATE_VAR");
			expect(stderr).toContain("{{ _place }}");
		} finally {
			errSpy.mockRestore();
		}
	});

	it("does not warn for locally-defined capture variables", async () => {
		env.addFile(
			"/test/capturevar.echo.md",
			"---\n---\n{% capture poem %}hi{% endcapture %}Poem: {{poem}}\n",
		);
		const { runCommandFn } = capture();
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: true,
				cwd: "/test",
				runCommandFn,
			});
			await runner.run(["node", "md", "/test/capturevar.echo.md"]);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).not.toContain("UNRESOLVED_TEMPLATE_VAR");
		} finally {
			errSpy.mockRestore();
		}
	});
});

describe("battery K (2026-07-17): imports, TTY, frontmatter references", () => {
	let env: InMemorySystemEnvironment;

	beforeEach(() => {
		env = createTestEnvironment();
	});

	const capture = () => {
		const state: { ctx?: RunContext } = {};
		const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
			state.ctx = ctx;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				output: "",
				process: null as unknown as ReturnType<typeof Bun.spawn>,
			};
		};
		return { state, runCommandFn };
	};

	it("warns when an import glob matches nothing", async () => {
		writeFileSync(join(dir, "glob-none.echo.md"), "---\n---\nG: @./nope/**/*.zzz\n");
		const result = Bun.spawnSync(
			["bun", "run", join(import.meta.dir, "index.ts"), "glob-none.echo.md"],
			{ cwd: dir, env: { ...process.env, MDFLOW_NO_TTY_PROMPT: "1" } },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toContain("GLOB_NO_MATCHES");
	});

	it("refuses to spawn an interactive engine without a terminal", async () => {
		env.addFile("/test/chat.i.echo.md", "---\n---\nhello\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/chat.i.echo.md"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("INTERACTIVE_NEEDS_TTY");
		expect(state.ctx).toBeUndefined();
	});

	it("MDFLOW_ASSUME_TTY overrides the interactive terminal preflight", async () => {
		env.addFile("/test/chat2.i.echo.md", "---\n---\nhello\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			processEnv: { ...process.env, MDFLOW_ASSUME_TTY: "1" },
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/chat2.i.echo.md"]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.interactive).toBe(true);
	});

	it("a var referenced only in frontmatter values is not warned as unused", async () => {
		env.addFile(
			"/test/envref.echo.md",
			'---\n_env:\n  GREETING: "hi {{ _who }}"\n---\nbody text\n',
		);
		const { runCommandFn } = capture();
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: true,
				cwd: "/test",
				runCommandFn,
			});
			await runner.run(["node", "md", "/test/envref.echo.md", "--_who", "dude"]);
			const stderr = errSpy.mock.calls.flat().join("\n");
			expect(stderr).not.toContain("UNUSED_VARIABLE_FLAG");
		} finally {
			errSpy.mockRestore();
		}
	});

	it("a defaulted template var does not block a headless run", async () => {
		env.addFile(
			"/test/defaulted.echo.md",
			'---\n---\nHello {{ _name | default: "world" }}\n',
		);
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/defaulted.echo.md"]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.positionals[0]).toBe("Hello world");
	});
});

describe("explain on a missing file", () => {
	it("reports File not found instead of a raw ENOENT", async () => {
		await expect(analyzeAgent(join(dir, "nope.md"), [], dir)).rejects.toThrow(
			/File not found/,
		);
	});
});

describe("round 5 (2026-07-17): workflow step vars, document fences", () => {
	let env: InMemorySystemEnvironment;

	beforeEach(() => {
		env = createTestEnvironment();
	});

	it("a var referenced only in a _steps run template is still required", async () => {
		// Chaos round 5: `run: "greet {{ _who }}"` rendered as "greet " with
		// no prompt and no error — step templates bypassed the missing-var
		// machinery entirely.
		env.addFile(
			"/test/wf.echo.md",
			'---\n_steps:\n  - id: a\n    run: "greet {{ _who }}"\n---\n',
		);
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
		});
		const result = await runner.run(["node", "md", "/test/wf.echo.md"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("_who");
	});

	it("document mode prints the body without empty frontmatter fences", async () => {
		env.addFile("/test/doc.md", "---\n---\njust a document\n");
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		try {
			const runner = new CliRunner({
				env,
				isStdinTTY: false,
				stdinContent: "",
				cwd: "/test",
			});
			// No engine anywhere: filename has none, no frontmatter engine, no
			// config — resolution falls through to the default → document rule.
			const result = await runner.run(["node", "md", "/test/doc.md"]);
			expect(result.exitCode).toBe(0);
			const stdout = logSpy.mock.calls.flat().join("\n");
			expect(stdout).toContain("just a document");
			expect(stdout).not.toContain("---");
		} finally {
			logSpy.mockRestore();
		}
	});
});

describe("round 6 (2026-07-17): CLI flag parsing", () => {
	let env: InMemorySystemEnvironment;

	beforeEach(() => {
		env = createTestEnvironment();
	});

	const capture = () => {
		const state: { ctx?: RunContext } = {};
		const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
			state.ctx = ctx;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				output: "",
				process: null as unknown as ReturnType<typeof Bun.spawn>,
			};
		};
		return { state, runCommandFn };
	};

	it("parseCliArgs skips a value-taking flag's value when finding the file", () => {
		// `md --engine echo flow.md` used to treat "echo" as the flow.
		const parsed = parseCliArgs(["node", "md", "--engine", "echo", "flow.md"]);
		expect(parsed.filePath).toBe("flow.md");
		expect(parsed.passthroughArgs).toEqual(["--engine", "echo"]);
	});

	it("parseCliArgs still finds a subcommand after a boolean flag", () => {
		const parsed = parseCliArgs(["node", "md", "--json", "roster"]);
		expect(parsed.filePath).toBe("roster");
	});

	it("--engine with no value errors instead of leaking into engine argv", async () => {
		env.addFile("/test/f.echo.md", "---\n---\nhi\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/f.echo.md", "--engine"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("--engine requires a value");
		expect(state.ctx).toBeUndefined();
	});

	it("--engine with a flag-like value errors", async () => {
		env.addFile("/test/f.echo.md", "---\n---\nhi\n");
		const { runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run([
			"node",
			"md",
			"/test/f.echo.md",
			"--engine",
			"--json",
		]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("--engine requires a value");
	});

	it("a declared --_var does not swallow a following flag as its value", async () => {
		env.addFile("/test/f.echo.md", "---\n_name: def\n---\nHi {{ _name }}\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		// --_name has no value, --engine echo follows: name keeps its default,
		// engine selection is honored.
		const result = await runner.run([
			"node",
			"md",
			"/test/f.echo.md",
			"--_name",
			"--engine",
			"echo",
		]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.command).toBe("echo");
		expect(state.ctx?.positionals[0]).toBe("Hi def");
	});

	it("a bare declared --_var keeps its default, not boolean true", async () => {
		env.addFile("/test/f.echo.md", "---\n_name: def\n---\nHi {{ _name }}\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/f.echo.md", "--_name"]);
		expect(result.exitCode).toBe(0);
		expect(state.ctx?.positionals[0]).toBe("Hi def");
	});

	it("--_name=value and --_name value both set the variable", async () => {
		env.addFile("/test/f.echo.md", "---\n_name: def\n---\nHi {{ _name }}\n");
		for (const args of [["--_name", "dude"], ["--_name=dude"]]) {
			const { state, runCommandFn } = capture();
			const runner = new CliRunner({
				env,
				isStdinTTY: false,
				stdinContent: "",
				cwd: "/test",
				runCommandFn,
			});
			await runner.run(["node", "md", "/test/f.echo.md", ...args]);
			expect(state.ctx?.positionals[0]).toBe("Hi dude");
		}
	});

	it("a duplicate --json does not leak into engine argv", async () => {
		env.addFile("/test/f.echo.md", "---\n---\nhi\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		await runner.run(["node", "md", "/test/f.echo.md", "--json", "--json"]);
		expect(state.ctx?.args ?? []).not.toContain("--json");
	});

	it("--engine=value (eq form) selects the engine and does not leak", async () => {
		env.addFile("/test/f.echo.md", "---\n---\nhi\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		await runner.run(["node", "md", "/test/f.echo.md", "--engine=echo"]);
		expect(state.ctx?.command).toBe("echo");
		expect(state.ctx?.args ?? []).not.toContain("--engine=echo");
	});

	it("a repeated --engine does not leak the second occurrence", async () => {
		env.addFile("/test/f.echo.md", "---\n---\nhi\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		await runner.run([
			"node",
			"md",
			"/test/f.echo.md",
			"--engine",
			"echo",
			"--engine",
			"echo",
		]);
		expect(state.ctx?.command).toBe("echo");
		expect((state.ctx?.args ?? []).join(" ")).not.toContain("--engine");
	});

	it("a typo'd scope flag on a registry command errors, not silently ignored", async () => {
		// `md remove --gobal name` used to silently target the wrong scope.
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
		});
		const result = await runner.run(["node", "md", "remove", "somename", "--gobal"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("Unknown remove option: --gobal");
	});

	it("an unknown flag on `md list` errors instead of being ignored", async () => {
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
		});
		const result = await runner.run(["node", "md", "list", "--frobnicate"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("Unknown list option");
	});

	it("a value-taking flag with no value errors instead of leaking (--_hooks)", async () => {
		env.addFile("/test/f.echo.md", "---\n---\nhi\n");
		const { state, runCommandFn } = capture();
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/f.echo.md", "--_hooks"]);
		expect(result.exitCode).toBe(1);
		expect(result.errorMessage).toContain("--_hooks requires a value");
		expect(state.ctx).toBeUndefined();
	});
});

describe("round 7 (2026-07-17): injection mitigation + compat write safety", () => {
	it("the shell_escape / q filter single-quotes a value with shell metacharacters", () => {
		// Inline-command vars are interpolated raw by design; the documented
		// mitigation must neutralize `;`, `$()`, and backticks for untrusted
		// input (verified live: raw injected, `| q` did not).
		const inject = "x; touch /tmp/pwned $(evil) `evil`";
		const escaped = substituteTemplateVars("{{ _v | shell_escape }}", { _v: inject });
		const escapedShort = substituteTemplateVars("{{ _v | q }}", { _v: inject });
		expect(escaped).toBe(escapedShort);
		// The whole value is inside one single-quoted string: no metachar escapes.
		expect(escaped.startsWith("'")).toBe(true);
		expect(escaped.endsWith("'")).toBe(true);
		// The only way out of POSIX single-quotes is the '\'' sequence; a bare
		// unescaped single quote (which would end the quoting) must not appear.
		expect(escaped.slice(1, -1)).not.toMatch(/'(?!\\'')/);
	});

	it("stampCompatFile preserves an executable flow's mode (atomic write)", () => {
		// The stamp rewrites the user's SOURCE file; switching to atomic
		// temp+rename must keep a shebang flow's 0o755 bit, not drop to 0o600.
		const flow = join(dir, "exec.echo.md");
		writeFileSync(flow, "#!/usr/bin/env md\n---\nmodel-a: b\n---\nexec body\n");
		chmodSync(flow, 0o755);
		const stamped = stampCompatFile(flow, "9.9.9");
		expect(stamped).toBe(true);
		expect(statSync(flow).mode & 0o777).toBe(0o755);
		const after = readFileSync(flow, "utf8");
		expect(after).toContain("_compat: 9.9.9");
		expect(after.startsWith("#!/usr/bin/env md")).toBe(true);
		expect(after).toContain("exec body");
	});
});

describe("MDFLOW_ENGINE override does not turn a filename-engine flow into a document", () => {
	it("runs the flow on the env engine instead of printing it", async () => {
		// Chaos round 6: `MDFLOW_ENGINE=claude md task.echo.md` PRINTED the
		// file (env source is "implicit", empty frontmatter → document rule)
		// instead of executing it on the override engine.
		const env = createTestEnvironment();
		env.addFile("/test/task.echo.md", "---\n---\nrun me\n");
		const state: { ctx?: RunContext } = {};
		const runCommandFn = async (ctx: RunContext): Promise<RunResult> => {
			state.ctx = ctx;
			return {
				exitCode: 0,
				stdout: "",
				stderr: "",
				output: "",
				process: null as unknown as ReturnType<typeof Bun.spawn>,
			};
		};
		const runner = new CliRunner({
			env,
			isStdinTTY: false,
			stdinContent: "",
			cwd: "/test",
			processEnv: { ...process.env, MDFLOW_ENGINE: "echo" },
			runCommandFn,
		});
		const result = await runner.run(["node", "md", "/test/task.echo.md"]);
		expect(result.exitCode).toBe(0);
		// It executed (the command ran) rather than being printed as a document.
		expect(state.ctx?.command).toBe("echo");
		expect(state.ctx?.positionals[0]).toBe("run me");
	});
});

describe("registry-installed flows resolve by name", () => {
	it("md <name> finds a flow installed under ~/.mdflow/registry", () => {
		// Chaos round 4: `md install` placed the flow and `md list` showed it,
		// but the name-resolution ladder never looked in the registry dirs —
		// installed flows were unrunnable by name.
		const home = join(dir, "home");
		const work = join(dir, "work");
		mkdirSync(join(home, ".mdflow", "registry"), { recursive: true });
		mkdirSync(work, { recursive: true });
		const flow = "---\n---\nregistry says hi\n";
		writeFileSync(join(home, ".mdflow", "registry", "installed.echo.md"), flow);
		writeFileSync(join(home, ".mdflow", "mdflow.lock.json"), JSON.stringify({ entries: {
			"installed.echo.md": { installedPath: "installed.echo.md", source: "https://example.test/installed.echo.md",
				sha256: new Bun.CryptoHasher("sha256").update(flow).digest("hex"), installedAt: "2026-01-01T00:00:00Z" },
		} }));
		const result = Bun.spawnSync(
			["bun", "run", join(import.meta.dir, "index.ts"), "installed.echo"],
			{
				cwd: work,
				env: { ...process.env, HOME: home, MDFLOW_NO_TTY_PROMPT: "1" },
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("registry says hi");
	});
});

describe("error paths exit without logger noise (sonic boom regression)", () => {
	it("a failing import run prints its error and nothing after it", () => {
		writeFileSync(join(dir, "broken.echo.md"), "---\n---\n@./missing.md\n");
		const result = Bun.spawnSync(
			["bun", "run", join(import.meta.dir, "index.ts"), "broken.echo.md"],
			{ cwd: dir, env: { ...process.env, MDFLOW_NO_TTY_PROMPT: "1" } },
		);
		const stderr = result.stderr.toString();
		expect(result.exitCode).toBe(1);
		expect(stderr).toContain("Import error");
		expect(stderr).not.toContain("sonic boom");
		expect(stderr).not.toContain("Uncaught exception");
	});
});
