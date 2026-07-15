import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
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
	__setRenameBoundaryTestHook,
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

	it("roster sync --agents writes no guidance when the README sync fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "mdflow-roster-failclosed-"));
		roots.push(root);
		// No flows/ at all: the README sync is invalid, so the multi-file sync
		// must not create guidance pointing agents at a roster that isn't there.
		const result = await spawnMd(["roster", "sync", "--agents", "--json"], {
			cwd: root,
			env: { HOME: join(root, "home") },
		});
		expect(result.exitCode).toBe(1);
		const payload = JSON.parse(result.stdout);
		expect(payload.ok).toBe(false);
		expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
	});

	it("never replaces a README it cannot read (fail-closed, not 'missing')", () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		const path = join(root, "flows", "README.md");
		writeFileSync(path, "# Team notes\n\nUser-owned text.\n");
		chmodSync(path, 0o000);
		try {
			const result = syncRosterReadme(root);
			expect(result.state).toBe("invalid");
			expect(result.changed).toBe(false);
		} finally {
			chmodSync(path, 0o644);
		}
		expect(readFileSync(path, "utf8")).toBe("# Team notes\n\nUser-owned text.\n");
	});

	it("refuses the rename when the second read observes changed bytes; temp is removed", () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		const path = join(root, "flows", "README.md");
		writeFileSync(path, "# Team notes\n\nUser-owned text.\n");
		// Inspection and the first mutating read SUCCEED; the fault fires at
		// the rename boundary, mutating the target so the second read sees
		// different bytes.
		__setRenameBoundaryTestHook((target) => {
			writeFileSync(target, "# Team notes\n\nConcurrent edit.\n");
		});
		let result: ReturnType<typeof syncRosterReadme>;
		try {
			result = syncRosterReadme(root);
		} finally {
			__setRenameBoundaryTestHook(null);
		}
		expect(result.state).toBe("invalid");
		expect(result.changed).toBe(false);
		expect(result.error).toContain("changed while syncing");
		expect(readFileSync(path, "utf8")).toBe(
			"# Team notes\n\nConcurrent edit.\n",
		);
		const temps = readdirSync(join(root, "flows")).filter((name) =>
			name.endsWith(".tmp"),
		);
		expect(temps).toEqual([]);
	});

	it("refuses the rename when the second read fails with a non-absence error", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			// Privileged processes can read mode-000 files; the byte-mismatch
			// regression above covers the same refusal path portably.
			return;
		}
		const root = project();
		flow(root, "review.md", "Review changes");
		const path = join(root, "flows", "README.md");
		writeFileSync(path, "# Team notes\n\nUser-owned text.\n");
		__setRenameBoundaryTestHook((target) => {
			chmodSync(target, 0o000); // EACCES on the rename-boundary re-read
		});
		let result: ReturnType<typeof syncRosterReadme>;
		try {
			result = syncRosterReadme(root);
		} finally {
			__setRenameBoundaryTestHook(null);
			chmodSync(path, 0o644);
		}
		expect(result.state).toBe("invalid");
		expect(result.changed).toBe(false);
		expect(result.error).toContain("cannot read");
		expect(readFileSync(path, "utf8")).toBe(
			"# Team notes\n\nUser-owned text.\n",
		);
		const temps = readdirSync(join(root, "flows")).filter((name) =>
			name.endsWith(".tmp"),
		);
		expect(temps).toEqual([]);
	});

	it("refuses a non-regular README instead of treating it as absent", () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		mkdirSync(join(root, "flows", "README.md"));
		const result = syncRosterReadme(root);
		expect(result.state).toBe("invalid");
		expect(result.changed).toBe(false);
	});

	it("writes nothing at all when any guidance file is invalid (one unit)", async () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		const env = { HOME: join(root, "home") };
		// Make the README stale (never synced) AND AGENTS.md invalid
		// (duplicated live markers): the unit must not write the README either.
		writeFileSync(
			join(root, "AGENTS.md"),
			[
				"<!-- mdflow:agents:start contract=1 -->",
				"<!-- mdflow:agents:end -->",
				"<!-- mdflow:agents:start contract=1 -->",
				"<!-- mdflow:agents:end -->",
				"",
			].join("\n"),
		);
		const result = await spawnMd(["roster", "sync", "--agents", "--json"], {
			cwd: root,
			env,
		});
		expect(result.exitCode).toBe(1);
		const payload = JSON.parse(result.stdout);
		expect(payload.ok).toBe(false);
		// README was NOT written despite being stale.
		expect(existsSync(join(root, "flows", "README.md"))).toBe(false);
		// CLAUDE.md was NOT created despite the --agents opt-in.
		expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
	});

	it("plain sync never writes guidance files, even stale opted-in ones", async () => {
		const root = project();
		flow(root, "review.md", "Review changes");
		const env = { HOME: join(root, "home") };
		const optIn = await spawnMd(["roster", "sync", "--agents", "--json"], {
			cwd: root,
			env,
		});
		expect(JSON.parse(optIn.stdout).ok).toBe(true);
		const path = join(root, "AGENTS.md");
		const tampered = readFileSync(path, "utf8").replace(
			"md doctor --json",
			"md doctor --old",
		);
		writeFileSync(path, tampered);
		const plain = await spawnMd(["roster", "sync", "--json"], {
			cwd: root,
			env,
		});
		const payload = JSON.parse(plain.stdout);
		expect(plain.exitCode).toBe(1);
		expect(payload.ok).toBe(false);
		const agents = payload.agents.find((e: any) => e.file === "AGENTS.md");
		expect(agents.state).toBe("stale");
		expect(agents.changed).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(tampered);
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
