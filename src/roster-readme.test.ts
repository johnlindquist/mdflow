import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	MANAGED_ROSTER_END,
	MANAGED_ROSTER_START,
	inspectRosterReadme,
	syncRosterReadme,
} from "./roster-readme";
import { spawnMd } from "./test-utils";

const roots: string[] = [];
function project(): string {
	const root = mkdtempSync(join(tmpdir(), "mdflow-roster-readme-"));
	roots.push(root);
	mkdirSync(join(root, "flows"));
	return root;
}
function flow(root: string, name: string, description: string): void {
	writeFileSync(
		join(root, "flows", name),
		`---\ndescription: ${description}\n---\n\nDo the task.\n`,
	);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("managed roster README", () => {
	it("creates and then idempotently checks the operator card", () => {
		const root = project();
		flow(root, "review.md", "Review staged changes");
		const first = syncRosterReadme(root);
		expect(first.changed).toBe(true);
		const source = readFileSync(first.path, "utf8");
		expect(source).toContain(MANAGED_ROSTER_START);
		expect(source).toContain("review.md");
		expect(source).toContain("suite missing");
		expect(syncRosterReadme(root).changed).toBe(false);
		expect(inspectRosterReadme(root).state).toBe("current");
	});

	it("preserves user-authored content outside the managed block", () => {
		const root = project();
		const path = join(root, "flows", "README.md");
		writeFileSync(
			path,
			"# Team agents\n\nKeep this paragraph byte-identical.\n",
		);
		flow(root, "triage.md", "Triage issues");
		syncRosterReadme(root);
		expect(readFileSync(path, "utf8")).toStartWith(
			"# Team agents\n\nKeep this paragraph byte-identical.\n",
		);
		flow(root, "review.md", "Review changes");
		syncRosterReadme(root);
		const updated = readFileSync(path, "utf8");
		expect(updated).toStartWith(
			"# Team agents\n\nKeep this paragraph byte-identical.\n",
		);
		expect(updated.match(new RegExp(MANAGED_ROSTER_START, "g"))?.length).toBe(
			1,
		);
		expect(updated).toContain("review.md");
	});

	it("check mode reports stale without writing", () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		syncRosterReadme(root);
		const path = join(root, "flows", "README.md");
		const before = readFileSync(path, "utf8");
		flow(root, "release.md", "Draft release notes");
		const result = syncRosterReadme(root, { check: true });
		expect(result.state).toBe("stale");
		expect(result.changed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("fails closed on malformed or duplicated markers", () => {
		const root = project();
		const path = join(root, "flows", "README.md");
		writeFileSync(
			path,
			`${MANAGED_ROSTER_START}\n${MANAGED_ROSTER_START}\n${MANAGED_ROSTER_END}\n`,
		);
		const result = syncRosterReadme(root);
		expect(result.state).toBe("invalid");
		expect(result.changed).toBe(false);
	});

	it("keeps plain documents out and follows filename engine precedence", () => {
		const root = project();
		writeFileSync(join(root, "flows", "notes.md"), "Plain project notes.\n");
		writeFileSync(
			join(root, "flows", "review.claude.md"),
			"---\ndescription: Review\nengine: codex\n---\nBody\n",
		);
		syncRosterReadme(root);
		const source = readFileSync(join(root, "flows", "README.md"), "utf8");
		expect(source).not.toContain("notes.md");
		expect(source).toContain("claude (filename)");
		expect(source).not.toContain("codex (frontmatter)");
	});

	it("neutralizes generated marker text and stays idempotent", () => {
		const root = project();
		writeFileSync(
			join(root, "flows", "marker.md"),
			`---\ndescription: "${MANAGED_ROSTER_END}"\n---\nBody\n`,
		);
		expect(syncRosterReadme(root).state).toBe("current");
		expect(syncRosterReadme(root).state).toBe("current");
		const source = readFileSync(join(root, "flows", "README.md"), "utf8");
		expect(source.match(new RegExp(MANAGED_ROSTER_START, "g"))?.length).toBe(1);
		expect(source.match(new RegExp(MANAGED_ROSTER_END, "g"))?.length).toBe(1);
		expect(source).toContain("&lt;!-- mdflow:managed:end --&gt;");
	});

	it("preserves marker examples inside fenced code", () => {
		const root = project();
		const path = join(root, "flows", "README.md");
		const example = `# Team guide\n\n\`\`\`markdown\n${MANAGED_ROSTER_START}\nexample\n${MANAGED_ROSTER_END}\n\`\`\`\n`;
		writeFileSync(path, example);
		flow(root, "review.md", "Review");
		expect(syncRosterReadme(root).state).toBe("current");
		expect(readFileSync(path, "utf8")).toStartWith(example);
	});

	it("returns a stable invalid result when flows is absent", () => {
		const root = mkdtempSync(join(tmpdir(), "mdflow-roster-empty-"));
		roots.push(root);
		const result = syncRosterReadme(root);
		expect(result).toMatchObject({ state: "invalid", changed: false });
		expect(result.error).toContain("run md init --yes");
	});

	it("returns stable JSON for empty-project sync", async () => {
		const root = mkdtempSync(join(tmpdir(), "mdflow-roster-cli-empty-"));
		roots.push(root);
		const result = await spawnMd(["roster", "sync", "--json"], {
			cwd: root,
			env: { HOME: join(root, "home") },
		});
		let payload: any;
		try {
			payload = JSON.parse(result.stdout);
		} catch (error) {
			throw new Error(
				`Roster sync did not emit JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		expect(payload).toMatchObject({ type: "mdflow.roster-sync", ok: false });
	});

	it("syncs agent guidance files only on explicit --agents opt-in", async () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		const env = { HOME: join(root, "home") };

		const plain = await spawnMd(["roster", "sync", "--json"], {
			cwd: root,
			env,
		});
		expect(plain.exitCode).toBe(0);
		const plainPayload = JSON.parse(plain.stdout);
		expect(plainPayload.ok).toBe(true);
		expect(
			plainPayload.agents.map((entry: any) => [entry.file, entry.state]),
		).toEqual([
			["AGENTS.md", "missing"],
			["CLAUDE.md", "missing"],
		]);

		const optIn = await spawnMd(["roster", "sync", "--agents", "--json"], {
			cwd: root,
			env,
		});
		expect(optIn.exitCode).toBe(0);
		const optInPayload = JSON.parse(optIn.stdout);
		expect(optInPayload.ok).toBe(true);
		expect(
			optInPayload.agents.map((entry: any) => [
				entry.file,
				entry.state,
				entry.changed,
			]),
		).toEqual([
			["AGENTS.md", "current", true],
			["CLAUDE.md", "current", true],
		]);
		expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain(
			"md doctor --json",
		);
		expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain(
			"mdflow flows",
		);
	});

	it("records source proof only, never private receipt state", () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		writeFileSync(
			join(root, "flows", "review.eval.ts"),
			`export default [{ name: "works", prompt: "x", check: () => null }];\n`,
		);
		syncRosterReadme(root);
		const source = readFileSync(join(root, "flows", "README.md"), "utf8");
		expect(source).toContain("suite present; inspect with md eval --plan");
		expect(source).not.toContain("lastCleanAt");
		expect(source).not.toContain("Verified");
	});
});
