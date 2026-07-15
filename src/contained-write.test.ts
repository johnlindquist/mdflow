import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ContainmentError,
	assertPlainDirectory,
	containedWritePath,
} from "./contained-write";
import { scaffoldStarterFlows } from "./init";
import { syncRosterReadme } from "./roster-readme";
import { syncAgentGuidance } from "./agent-guidance";

let dir: string;
let victim: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdflow-contained-"));
	victim = mkdtempSync(join(tmpdir(), "mdflow-victim-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(victim, { recursive: true, force: true });
});

describe("containedWritePath", () => {
	it("accepts plain paths and returns a canonical-root target", () => {
		const path = containedWritePath(dir, "AGENTS.md");
		expect(path.endsWith("AGENTS.md")).toBe(true);
	});

	it("rejects traversal segments", () => {
		expect(() => containedWritePath(dir, "..", "escape.md")).toThrow(
			ContainmentError,
		);
		expect(() => containedWritePath(dir, "flows/../..", "x.md")).toThrow(
			ContainmentError,
		);
	});

	it("rejects a symlinked directory component", () => {
		symlinkSync(victim, join(dir, "flows"));
		expect(() => containedWritePath(dir, "flows", "README.md")).toThrow(
			ContainmentError,
		);
	});

	it("rejects a symlinked final target, dangling or not", () => {
		symlinkSync(join(victim, "target.md"), join(dir, "AGENTS.md"));
		expect(() => containedWritePath(dir, "AGENTS.md")).toThrow(
			ContainmentError,
		);
	});

	it("rejects a non-regular final target", () => {
		mkdirSync(join(dir, "AGENTS.md"));
		expect(() => containedWritePath(dir, "AGENTS.md")).toThrow(
			ContainmentError,
		);
	});
});

describe("assertPlainDirectory", () => {
	it("accepts absent and plain directories, rejects symlinks", () => {
		expect(() => assertPlainDirectory(join(dir, "missing"))).not.toThrow();
		mkdirSync(join(dir, "real"));
		expect(() => assertPlainDirectory(join(dir, "real"))).not.toThrow();
		symlinkSync(victim, join(dir, "linked"));
		expect(() => assertPlainDirectory(join(dir, "linked"))).toThrow(
			ContainmentError,
		);
	});
});

describe("symlinked project layouts are refused end to end", () => {
	it("init refuses to scaffold through a symlinked flows/", () => {
		symlinkSync(victim, join(dir, "flows"));
		expect(() => scaffoldStarterFlows(dir, "pi")).toThrow(ContainmentError);
		expect(existsSync(join(victim, "review.md"))).toBe(false);
	});

	it("init refuses a dangling .mdflow.yaml symlink instead of creating its target", () => {
		symlinkSync(join(victim, "planted.yaml"), join(dir, ".mdflow.yaml"));
		const result = scaffoldStarterFlows(dir, "pi");
		expect(
			result.lines.some((line) => line.includes("refused .mdflow.yaml")),
		).toBe(true);
		// A refused required component is a structured non-success, never
		// summarized into "ready".
		expect(result.ok).toBe(false);
		expect(result.refused).toBeGreaterThan(0);
		expect(existsSync(join(victim, "planted.yaml"))).toBe(false);
	});

	it("roster sync refuses a symlinked flows/ instead of writing through it", () => {
		mkdirSync(join(victim, "flows"));
		symlinkSync(join(victim, "flows"), join(dir, "flows"));
		const result = syncRosterReadme(dir);
		expect(result.state).toBe("invalid");
		expect(result.changed).toBe(false);
		expect(existsSync(join(victim, "flows", "README.md"))).toBe(false);
	});

	it("agent guidance refuses symlinked targets and writes nothing anywhere", () => {
		symlinkSync(join(victim, "AGENTS.md"), join(dir, "AGENTS.md"));
		const results = syncAgentGuidance(dir, { optIn: true });
		const agents = results.find((entry) => entry.file === "AGENTS.md");
		const claude = results.find((entry) => entry.file === "CLAUDE.md");
		expect(agents?.state).toBe("invalid");
		expect(agents?.error).toContain("symlink");
		// Fail-closed unit: the sibling file is not created either.
		expect(claude?.changed).toBe(false);
		expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
		expect(existsSync(join(victim, "AGENTS.md"))).toBe(false);
	});
});
