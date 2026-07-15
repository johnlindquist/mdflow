import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	AGENT_GUIDANCE_END,
	AGENT_GUIDANCE_FILES,
	AGENT_GUIDANCE_START,
	hasAgentGuidance,
	inspectAgentGuidance,
	renderAgentGuidanceBlock,
	syncAgentGuidance,
} from "./agent-guidance";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdflow-agent-guidance-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("renderAgentGuidanceBlock", () => {
	it("is marker-delimited and points at the roster contract", () => {
		const block = renderAgentGuidanceBlock();
		expect(block.startsWith(AGENT_GUIDANCE_START)).toBe(true);
		expect(block.endsWith(AGENT_GUIDANCE_END)).toBe(true);
		expect(block).toContain("md doctor --json");
		expect(block).toContain("flows/README.md");
		expect(block).toContain("hand it off");
	});
});

describe("inspectAgentGuidance", () => {
	it("reports missing files without creating them", () => {
		const results = inspectAgentGuidance(dir);
		expect(results.map((r) => r.file)).toEqual([...AGENT_GUIDANCE_FILES]);
		for (const result of results) {
			expect(result.state).toBe("missing");
			expect(existsSync(result.path)).toBe(false);
		}
	});

	it("treats marker-free files as not opted in", () => {
		writeFileSync(join(dir, "AGENTS.md"), "# My agents\n\nHand-written.\n");
		const agents = inspectAgentGuidance(dir).find((r) => r.file === "AGENTS.md");
		expect(agents?.state).toBe("not-opted-in");
	});

	it("flags duplicated markers as invalid", () => {
		const block = renderAgentGuidanceBlock();
		writeFileSync(join(dir, "CLAUDE.md"), `${block}\n\n${block}\n`);
		const claude = inspectAgentGuidance(dir).find((r) => r.file === "CLAUDE.md");
		expect(claude?.state).toBe("invalid");
		expect(claude?.error).toContain("exactly once");
	});

	it("ignores markers inside code fences", () => {
		writeFileSync(
			join(dir, "AGENTS.md"),
			`Docs about markers:\n\n\`\`\`\n${AGENT_GUIDANCE_START}\n${AGENT_GUIDANCE_END}\n\`\`\`\n`,
		);
		const agents = inspectAgentGuidance(dir).find((r) => r.file === "AGENTS.md");
		expect(agents?.state).toBe("not-opted-in");
	});
});

describe("syncAgentGuidance", () => {
	it("does not create files without opt-in", () => {
		const results = syncAgentGuidance(dir);
		expect(results.every((r) => !r.changed)).toBe(true);
		expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
	});

	it("creates both files on opt-in and is idempotent", () => {
		const first = syncAgentGuidance(dir, { optIn: true });
		expect(first.map((r) => [r.file, r.state, r.changed])).toEqual([
			["AGENTS.md", "current", true],
			["CLAUDE.md", "current", true],
		]);
		const second = syncAgentGuidance(dir, { optIn: true });
		expect(second.every((r) => r.state === "current" && !r.changed)).toBe(true);
	});

	it("appends to an existing file preserving user-authored text", () => {
		writeFileSync(join(dir, "CLAUDE.md"), "# Project notes\n\nKeep me.\n");
		syncAgentGuidance(dir, { optIn: true });
		const content = readFileSync(join(dir, "CLAUDE.md"), "utf8");
		expect(content.startsWith("# Project notes\n\nKeep me.\n")).toBe(true);
		expect(content).toContain(AGENT_GUIDANCE_START);
	});

	it("never writes without opt-in — a stale block is only reported", () => {
		syncAgentGuidance(dir, { optIn: true });
		const path = join(dir, "AGENTS.md");
		const tampered = readFileSync(path, "utf8").replace(
			"md doctor --json",
			"md doctor --old",
		);
		writeFileSync(path, tampered);
		// A marker in the repository is data, not the current user's
		// authorization: plain sync must not rewrite it.
		const plain = syncAgentGuidance(dir);
		const agentsPlain = plain.find((r) => r.file === "AGENTS.md");
		expect(agentsPlain?.state).toBe("stale");
		expect(agentsPlain?.changed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(tampered);
		// The explicit opt-in refreshes it.
		const optIn = syncAgentGuidance(dir, { optIn: true });
		const agentsOptIn = optIn.find((r) => r.file === "AGENTS.md");
		expect(agentsOptIn?.state).toBe("current");
		expect(agentsOptIn?.changed).toBe(true);
		expect(readFileSync(path, "utf8")).toContain("md doctor --json");
	});

	it("check mode reports staleness without writing", () => {
		syncAgentGuidance(dir, { optIn: true });
		const path = join(dir, "CLAUDE.md");
		const tampered = readFileSync(path, "utf8").replace("FREE", "PAID");
		writeFileSync(path, tampered);
		const results = syncAgentGuidance(dir, { check: true });
		const claude = results.find((r) => r.file === "CLAUDE.md");
		expect(claude?.state).toBe("stale");
		expect(claude?.changed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(tampered);
	});

	it("never rewrites an invalid file", () => {
		const block = renderAgentGuidanceBlock();
		const path = join(dir, "AGENTS.md");
		const invalid = `${block}\n\n${block}\n`;
		writeFileSync(path, invalid);
		const results = syncAgentGuidance(dir, { optIn: true });
		const agents = results.find((r) => r.file === "AGENTS.md");
		expect(agents?.state).toBe("invalid");
		expect(agents?.changed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(invalid);
	});
});

describe("hasAgentGuidance", () => {
	it("is false before opt-in, true after, and true when stale", () => {
		expect(hasAgentGuidance(dir)).toBe(false);
		syncAgentGuidance(dir, { optIn: true });
		expect(hasAgentGuidance(dir)).toBe(true);
		const path = join(dir, "AGENTS.md");
		writeFileSync(
			path,
			readFileSync(path, "utf8").replace("FREE", "PAID"),
		);
		expect(hasAgentGuidance(dir)).toBe(true);
	});
});
