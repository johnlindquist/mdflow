import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { collectDoctorReport } from "./doctor";
import { renderHooksTemplate } from "./hooks";
import { spawnMd } from "./test-utils";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "mdflow-doctor-"));
	roots.push(value);
	return value;
}
function allInstalled(engine: string): string {
	return `/bin/${engine}`;
}
function parseDoctorJson(stdout: string): any {
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw new Error(
			`Doctor did not emit valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function snapshot(dir: string): Array<[string, number, string]> {
	const out: Array<[string, number, string]> = [];
	const walk = (current: string): void => {
		for (const name of readdirSync(current).sort()) {
			const path = join(current, name);
			const stats = statSync(path);
			if (stats.isDirectory()) walk(path);
			else
				out.push([relative(dir, path), stats.size, readFileSync(path, "utf8")]);
		}
	};
	walk(dir);
	return out;
}

afterEach(() => {
	for (const value of roots.splice(0))
		rmSync(value, { recursive: true, force: true });
});

describe("md doctor", () => {
	it("diagnoses an empty project without failing structurally", async () => {
		const project = root();
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		expect(report.type).toBe("mdflow.doctor");
		expect(report.effect).toBe("FREE");
		expect(report.summary.flows).toBe(0);
		expect(report.summary.structuralErrors).toBe(0);
		expect(
			report.diagnostics.some(
				(item) => item.code === "PROJECT_NOT_INITIALIZED",
			),
		).toBe(true);
	});

	it("rejects hook configurations the real run would reject", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		writeFileSync(join(project, ".mdflow.yaml"), "engine: claude\n");
		// Valid hooks sidecar + a flow that also sets `settings:` — the runtime
		// fails this ownership conflict, so doctor must not report "ready".
		writeFileSync(
			join(project, "flows", "review.md"),
			'---\ndescription: review\nsettings: \'{"model":"opus"}\'\n---\nBody\n',
		);
		writeFileSync(
			join(project, "flows", "review.hooks.ts"),
			renderHooksTemplate(["stop"]),
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		const flow = report.flows.find((item) => item.path.endsWith("review.md"));
		expect(flow?.hooks.state).toBe("invalid");
		expect(
			report.diagnostics.some(
				(item) =>
					item.code === "HOOKS_INVALID" && item.message.includes("settings"),
			),
		).toBe(true);
	});

	it("suppresses mutating next actions while structural errors are present", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		// A flow that cannot parse: structurally broken, NOT uninitialized.
		writeFileSync(
			join(project, "flows", "broken.md"),
			"---\ndescription: [unclosed\n---\nBody\n",
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		expect(
			report.diagnostics.some((item) => item.code === "FLOW_INVALID"),
		).toBe(true);
		expect(
			report.diagnostics.some(
				(item) => item.code === "PROJECT_NOT_INITIALIZED",
			),
		).toBe(false);
		expect(
			report.nextActions.every((item) => item.effect === "FREE"),
		).toBe(true);
	});

	it("suppresses mutating actions everywhere they surface, not only nextActions", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		// Structural error (invalid config) ALONGSIDE a valid flow that would
		// otherwise earn LOCAL_WRITE actions (missing eval suite, missing
		// roster README): none of those may leak through diagnostics[].action
		// or the rendered text while the error is present.
		writeFileSync(join(project, ".mdflow.yaml"), "engine: [unterminated\n");
		writeFileSync(
			join(project, "flows", "task.md"),
			"---\ndescription: Task\n_flow_id: flow_task\n---\nBody\n",
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		expect(
			report.diagnostics.some((item) => item.code === "CONFIG_INVALID"),
		).toBe(true);
		const leakedActions = report.diagnostics.filter(
			(item) => item.action && item.action.effect !== "FREE",
		);
		expect(leakedActions).toEqual([]);
		expect(
			report.nextActions.every((item) => item.effect === "FREE"),
		).toBe(true);
		const { renderDoctorText } = await import("./doctor");
		const text = renderDoctorText(report);
		expect(text).not.toContain("Next [LOCAL_WRITE]");
		expect(text).not.toContain("Next [ENGINE]");
	});

	it("diagnoses opted-in agent guidance drift and stays quiet before opt-in", async () => {
		const project = root();
		const homeDir = join(project, "home");

		const before = await collectDoctorReport({
			cwd: project,
			homeDir,
			which: allInstalled,
		});
		expect(before.project.agentGuidance).toEqual([
			{ file: "AGENTS.md", state: "missing" },
			{ file: "CLAUDE.md", state: "missing" },
		]);
		expect(
			before.diagnostics.some((item) =>
				item.code.startsWith("AGENT_GUIDANCE"),
			),
		).toBe(false);

		const { syncAgentGuidance } = await import("./agent-guidance");
		syncAgentGuidance(project, { optIn: true });
		writeFileSync(
			join(project, "AGENTS.md"),
			readFileSync(join(project, "AGENTS.md"), "utf8").replace(
				"md doctor --json",
				"md doctor --old",
			),
		);

		const after = await collectDoctorReport({
			cwd: project,
			homeDir,
			which: allInstalled,
		});
		expect(after.project.agentGuidance).toEqual([
			{ file: "AGENTS.md", state: "stale" },
			{ file: "CLAUDE.md", state: "current" },
		]);
		const stale = after.diagnostics.find(
			(item) => item.code === "AGENT_GUIDANCE_STALE",
		);
		expect(stale?.severity).toBe("warning");
		expect(stale?.action?.argv).toEqual(["md", "roster", "sync", "--agents"]);
	});

	it("reports stable engine, eval, capability, hook, and roster diagnostics", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		writeFileSync(join(project, ".mdflow.yaml"), "engine: pi\n");
		writeFileSync(
			join(project, "flows", "review.md"),
			`---\ndescription: Review changes\n_flow_id: flow_review\n---\n\nReview @https://example.invalid/context and !\`git diff --cached\`.\n`,
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		expect(report.flows).toHaveLength(1);
		expect(report.flows[0]?.engine).toEqual({
			name: "pi",
			source: "config",
			installed: true,
		});
		expect(report.flows[0]?.capabilities).toContain(
			"url:https://example.invalid/context",
		);
		expect(report.flows[0]?.capabilities).toContain(
			"command:git diff --cached",
		);
		expect(report.diagnostics.map((item) => item.code)).toContain(
			"EVAL_MISSING",
		);
		expect(report.diagnostics.map((item) => item.code)).toContain(
			"ROSTER_README_MISSING",
		);
	});

	it("never executes evals, hooks, commands, URLs, or context providers and never writes", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		writeFileSync(join(project, ".mdflow.yaml"), "engine: codex\n");
		const sentinel = join(project, "EXECUTED");
		writeFileSync(
			join(project, "flows", "guard.md"),
			`---\ndescription: Guard behavior\n_flow_id: flow_guard\n---\n\n!\`touch ${sentinel}\`\n@https://example.invalid/no-fetch\n@git:diff\n\`\`\`!bash\ntouch ${sentinel}\n\`\`\`\n`,
		);
		writeFileSync(
			join(project, "flows", "guard.eval.ts"),
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "eval executed");\nexport default [{ name: "guard", prompt: "x", check: () => null }];\n`,
		);
		writeFileSync(
			join(project, "flows", "guard.hooks.ts"),
			`${renderHooksTemplate(["stop"])}\nwriteFileSync(${JSON.stringify(sentinel)}, "hook executed");\n`,
		);
		const before = snapshot(project);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		expect(report.flows[0]?.hooks.state).toBe("ready");
		expect(snapshot(project)).toEqual(before);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("routes native JSON through the CLI without generic wrapping", async () => {
		const project = root();
		const home = join(project, "home");
		mkdirSync(join(project, "flows"));
		mkdirSync(home);
		writeFileSync(join(project, ".mdflow.yaml"), "engine: echo\n");
		writeFileSync(
			join(project, "flows", "inspect.md"),
			"---\ndescription: Inspect\n_flow_id: flow_inspect\n---\nBody\n",
		);
		const result = await spawnMd(["doctor", "--json"], {
			cwd: project,
			env: { HOME: home },
		});
		expect(result.exitCode).toBe(0);
		let payload: unknown;
		try {
			payload = JSON.parse(result.stdout);
		} catch (error) {
			throw new Error(
				`Doctor did not emit one JSON object: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		expect(payload).toMatchObject({
			type: "mdflow.doctor",
			protocolVersion: 1,
			effect: "FREE",
		});
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
	});

	it("does not spawn git while inspecting eval status", async () => {
		const project = root();
		const home = join(project, "home");
		const bin = join(project, "bin");
		mkdirSync(join(project, ".git"));
		mkdirSync(join(project, "flows"));
		mkdirSync(home);
		mkdirSync(bin);
		const sentinel = join(project, "GIT_EXECUTED");
		const fakeGit = join(bin, "git");
		writeFileSync(
			fakeGit,
			`#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\nexit 0\n`,
		);
		chmodSync(fakeGit, 0o755);
		writeFileSync(join(project, ".mdflow.yaml"), "engine: pi\n");
		writeFileSync(
			join(project, "flows", "task.md"),
			"---\ndescription: Task\n_flow_id: flow_task\n---\nBody\n",
		);
		writeFileSync(
			join(project, "flows", "task.eval.ts"),
			`export default [{ name: "task", prompt: "x", check: () => null }];\n`,
		);
		writeFileSync(
			join(home, "eval-results.json"),
			JSON.stringify({
				"flow:flow_task": {
					flow: join(project, "flows", "task.md"),
					flowId: "flow_task",
					pass: 1,
					fail: 0,
					total: 1,
					full: true,
					currentClean: true,
					lastRunAt: "2026-07-14T00:00:00.000Z",
					lastRunFingerprint: "sha256:prior",
					verification: { fingerprint: "sha256:prior" },
				},
			}),
		);
		const beforeProject = snapshot(project);
		const beforeHome = snapshot(home);
		// The spawned Bun runtime derives its transpiler/install caches from
		// $HOME when BUN_INSTALL isn't inherited (CI runners): those .pile
		// cache writes would land inside the snapshotted fake HOME and fail
		// the "writes nothing" assertion for an mdflow-unrelated reason. Pin
		// both cache roots outside the snapshots so the assertion measures
		// doctor, not the runtime.
		const bunCache = mkdtempSync(join(tmpdir(), "mdflow-doctor-buncache-"));
		roots.push(bunCache);
		const result = await spawnMd(["doctor", "--json"], {
			cwd: project,
			env: {
				HOME: home,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				MDFLOW_EVAL_RESULTS: join(home, "eval-results.json"),
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(bunCache, "transpiler"),
				BUN_INSTALL_CACHE_DIR: join(bunCache, "install"),
			},
		});
		parseDoctorJson(result.stdout);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(existsSync(sentinel)).toBe(false);
		expect(snapshot(project)).toEqual(beforeProject);
		expect(snapshot(home)).toEqual(beforeHome);
	});

	it("keeps invalid config JSON-pure and reports CONFIG_INVALID", async () => {
		const project = root();
		const home = join(project, "home");
		mkdirSync(join(project, "flows"));
		mkdirSync(home);
		writeFileSync(join(project, ".mdflow.yaml"), "engine: [unterminated\n");
		const result = await spawnMd(["doctor", "--json"], {
			cwd: project,
			env: { HOME: home },
		});
		const payload = parseDoctorJson(result.stdout);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(payload.diagnostics.map((item: any) => item.code)).toContain(
			"CONFIG_INVALID",
		);
	});

	it("keeps filesystem shape errors in one JSON object", async () => {
		const project = root();
		const home = join(project, "home");
		mkdirSync(join(project, "flows", "README.md"), { recursive: true });
		mkdirSync(home);
		writeFileSync(
			join(project, "flows", "echo.md"),
			"---\ndescription: Echo\nengine: echo\n_flow_id: flow_echo\n---\nBody\n",
		);
		const result = await spawnMd(["doctor", "--json"], {
			cwd: project,
			env: { HOME: home },
		});
		const payload = parseDoctorJson(result.stdout);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(payload.diagnostics.map((item: any) => item.code)).toContain(
			"ROSTER_MARKERS_INVALID",
		);
	});

	it("turns invalid engine tokens into FLOW_INVALID JSON", async () => {
		const project = root();
		const home = join(project, "home");
		mkdirSync(join(project, "flows"));
		mkdirSync(home);
		writeFileSync(
			join(project, "flows", "bad.md"),
			"---\ndescription: Bad\nengine: bad command\n---\nBody\n",
		);
		const result = await spawnMd(["doctor", "--json"], {
			cwd: project,
			env: { HOME: home },
		});
		const payload = parseDoctorJson(result.stdout);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expect(payload.diagnostics.map((item: any) => item.code)).toContain(
			"FLOW_INVALID",
		);
	});

	it("does not require an unused default pi for explicit installed engines", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		writeFileSync(
			join(project, "flows", "echo.md"),
			"---\ndescription: Echo\nengine: echo\n_flow_id: flow_echo\n---\nBody\n",
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: (engine) => (engine === "echo" ? "/bin/echo" : null),
		});
		expect(
			report.diagnostics.some((item) => item.code === "ENGINE_NOT_INSTALLED"),
		).toBe(false);
		expect(report.summary.structuralErrors).toBe(0);
	});

	it("does not let global roster defects fail a healthy project", async () => {
		const project = root();
		const home = join(project, "home");
		mkdirSync(join(project, "flows"));
		mkdirSync(join(home, ".mdflow"), { recursive: true });
		writeFileSync(
			join(project, "flows", "echo.md"),
			"---\ndescription: Echo\nengine: echo\n_flow_id: flow_echo\n---\nBody\n",
		);
		writeFileSync(
			join(home, ".mdflow", "broken.md"),
			"---\n: [ invalid\n---\n",
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: home,
			which: allInstalled,
		});
		expect(
			report.diagnostics.some((item) => item.message.includes("broken.md")),
		).toBe(false);
	});

	it("matches command-default hook disablement", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		writeFileSync(
			join(project, ".mdflow.yaml"),
			"engine: codex\ncommands:\n  codex:\n    _hooks: false\n",
		);
		writeFileSync(
			join(project, "flows", "guard.md"),
			"---\ndescription: Guard\n_flow_id: flow_guard\n---\nBody\n",
		);
		writeFileSync(
			join(project, "flows", "guard.hooks.ts"),
			renderHooksTemplate(["stop"]),
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		expect(report.flows[0]?.hooks.state).toBe("disabled");
	});

	it("publishes consent-safe argv actions and stable embedded ids", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		const filename = "review;touch PWN;.md";
		writeFileSync(
			join(project, "flows", filename),
			"---\ndescription: Review\nengine: echo\n_flow_id: flow_stable\n---\nBody\n",
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		const missing = report.diagnostics.find(
			(item) => item.code === "EVAL_MISSING",
		);
		expect(report.flows[0]?.id).toBe("flow_stable");
		expect(report.flows[0]?.rosterId).toContain("review;touch PWN;");
		expect(missing?.action).toMatchObject({
			argv: ["md", "eval", "add", `flows/${filename}`],
			effect: "LOCAL_WRITE",
			requiresConsent: true,
		});
		expect(missing?.action?.command).toContain("'flows/review;touch PWN;.md'");
	});

	it("distinguishes draft and uninspectable suites without importing them", async () => {
		const project = root();
		mkdirSync(join(project, "flows"));
		writeFileSync(join(project, ".mdflow.yaml"), "engine: pi\n");
		writeFileSync(
			join(project, "flows", "draft.md"),
			"---\ndescription: Draft\n_flow_id: flow_draft\n---\nBody\n",
		);
		writeFileSync(
			join(project, "flows", "draft.eval.ts"),
			`export default [{ name: "draft", draft: true, prompt: "x", check: () => null }];\n`,
		);
		writeFileSync(
			join(project, "flows", "broken.md"),
			"---\ndescription: Broken\n_flow_id: flow_broken\n---\nBody\n",
		);
		writeFileSync(
			join(project, "flows", "broken.eval.ts"),
			"export default makeCases();\n",
		);
		const report = await collectDoctorReport({
			cwd: project,
			homeDir: join(project, "home"),
			which: allInstalled,
		});
		const codes = report.diagnostics.map((item) => item.code);
		expect(codes).toContain("EVAL_DRAFT");
		expect(codes).toContain("EVAL_UNINSPECTABLE");
	});
});
