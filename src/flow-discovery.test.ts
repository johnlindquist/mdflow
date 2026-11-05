import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFlowCatalog } from "./flow-discovery";

const roots: string[] = [];

function fixture(): { project: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), "mdflow-discovery-"));
	roots.push(root);
	const project = join(root, "project");
	const home = join(root, "home");
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(home, { recursive: true });
	return { project, home };
}

function writeFlow(path: string, description = "Runnable fixture"): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		`---\ndescription: ${description}\n---\nRun this flow.\n`,
	);
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("discoverFlowCatalog", () => {
	test("merges nested project and top-level global flows with provenance", async () => {
		const { project, home } = fixture();
		writeFlow(
			join(project, "flows", "release", "review.claude.md"),
			"Review release",
		);
		writeFlow(
			join(home, ".mdflow", "flows", "personal.codex.md"),
			"Personal helper",
		);
		writeFlow(
			join(home, ".mdflow", "legacy.codex.md"),
			"Legacy personal helper",
		);
		writeFlow(
			join(home, ".mdflow", "logs", "private.claude.md"),
			"Must stay hidden",
		);
		writeFileSync(join(project, "README.md"), "# Not a flow\n");

		const catalog = await discoverFlowCatalog({
			cwd: project,
			homeDir: home,
			scorePath: () => 0,
		});

		expect(catalog.flows.map((flow) => flow.name)).toContain(
			"release/review.claude.md",
		);
		expect(catalog.flows.map((flow) => flow.name)).toContain(
			"personal.codex.md",
		);
		expect(catalog.flows.map((flow) => flow.name)).toContain("legacy.codex.md");
		expect(
			catalog.flows.some((flow) => flow.path.includes("/.mdflow/logs/")),
		).toBe(false);
		expect(catalog.flows.some((flow) => flow.path.endsWith("README.md"))).toBe(
			false,
		);
		expect(
			catalog.flows.find((flow) => flow.name === "release/review.claude.md"),
		).toMatchObject({
			scope: "project",
			provenanceLabel: "PROJECT",
			availability: { state: "ready" },
		});
		expect(
			catalog.flows.find((flow) => flow.name === "personal.codex.md"),
		).toMatchObject({
			scope: "global",
			origin: "global-flows",
			provenanceLabel: "GLOBAL",
		});
		expect(
			catalog.flows.find((flow) => flow.name === "legacy.codex.md"),
		).toMatchObject({
			scope: "global",
			origin: "global-personal",
			provenanceLabel: "GLOBAL · LEGACY",
		});
	});

	test("discovers nested installed entries from the lockfile and keeps missing entries disabled", async () => {
		const { project, home } = fixture();
		const registry = join(home, ".mdflow", "registry");
		const installed = join(registry, "team", "review.claude.md");
		const missing = join(registry, "team", "missing.claude.md");
		writeFlow(installed, "Installed review");
		mkdirSync(join(home, ".mdflow"), { recursive: true });
		writeFileSync(
			join(home, ".mdflow", "mdflow.lock.json"),
			JSON.stringify({
				entries: {
					"team-review": {
						source: "gh:team/flows/review.claude.md",
						resolvedRef: "main",
						sha256: createHash("sha256").update(readFileSync(installed)).digest("hex"),
						installedPath: installed,
						installedAt: "2026-01-01T00:00:00.000Z",
					},
					missing: {
						source: "gh:team/flows/missing.claude.md",
						sha256: "0".repeat(64),
						installedPath: missing,
						installedAt: "2026-01-02T00:00:00.000Z",
					},
				},
			}),
		);

		const catalog = await discoverFlowCatalog({
			cwd: project,
			homeDir: home,
			scorePath: () => 0,
		});

		expect(
			catalog.flows.find((flow) => flow.name === "team-review"),
		).toMatchObject({
			scope: "global",
			provenanceLabel: "GLOBAL · INSTALLED",
			relativePath: "team/review.claude.md",
			availability: { state: "ready" },
		});
		expect(catalog.flows.find((flow) => flow.name === "missing")).toMatchObject(
			{
				availability: { state: "unavailable", reason: "missing" },
			},
		);
	});

	test("discovers config-declared roster directories with provenance", async () => {
		const { project, home } = fixture();
		const extraGlobal = join(home, "extra-roster");
		writeFlow(join(extraGlobal, "nested", "zsh.codex.md"), "zsh config");
		writeFlow(join(project, "team-roster", "review.claude.md"), "Team review");
		mkdirSync(join(home, ".mdflow"), { recursive: true });
		writeFileSync(
			join(home, ".mdflow", "config.yaml"),
			"flows:\n  directories:\n    - ~/extra-roster\n",
		);
		writeFileSync(
			join(project, ".mdflow.yaml"),
			"flows:\n  directories:\n    - ./team-roster\n",
		);

		const catalog = await discoverFlowCatalog({
			cwd: project,
			homeDir: home,
			scorePath: () => 0,
		});

		expect(
			catalog.flows.find((flow) => flow.name === "nested/zsh.codex.md"),
		).toMatchObject({
			scope: "global",
			origin: "global-config",
			provenanceLabel: "GLOBAL · CONFIG",
			availability: { state: "ready" },
		});
		expect(
			catalog.flows.find((flow) => flow.name === "review.claude.md"),
		).toMatchObject({
			scope: "project",
			origin: "project-config",
			provenanceLabel: "PROJECT · CONFIG",
		});
		expect(catalog.counts).toMatchObject({ project: 1, global: 1 });
	});

	test("a declared directory overlapping a standard roster keeps the roster's provenance", async () => {
		const { project, home } = fixture();
		writeFlow(join(project, "flows", "review.claude.md"), "Review");
		mkdirSync(join(home, ".mdflow"), { recursive: true });
		writeFileSync(
			join(home, ".mdflow", "config.yaml"),
			`flows:\n  directories:\n    - ${join(project, "flows")}\n`,
		);

		const catalog = await discoverFlowCatalog({
			cwd: project,
			homeDir: home,
			scorePath: () => 0,
		});

		expect(
			catalog.flows.filter((flow) => flow.name === "review.claude.md"),
		).toHaveLength(1);
		expect(
			catalog.flows.find((flow) => flow.name === "review.claude.md"),
		).toMatchObject({ scope: "project", provenanceLabel: "PROJECT" });
	});

	test("a missing declared directory surfaces a diagnostic instead of vanishing", async () => {
		const { project, home } = fixture();
		mkdirSync(join(home, ".mdflow"), { recursive: true });
		writeFileSync(
			join(home, ".mdflow", "config.yaml"),
			"flows:\n  directories:\n    - ~/does-not-exist\n",
		);

		const catalog = await discoverFlowCatalog({
			cwd: project,
			homeDir: home,
			scorePath: () => 0,
		});

		expect(catalog.diagnostics).toContainEqual(
			expect.objectContaining({
				scope: "global",
				code: "DIRECTORY_UNREADABLE",
			}),
		);
	});

	test("retains same-name project and global flows as distinct choices", async () => {
		const { project, home } = fixture();
		writeFlow(join(project, "flows", "review.claude.md"));
		writeFlow(join(home, ".mdflow", "review.claude.md"));

		const catalog = await discoverFlowCatalog({
			cwd: project,
			homeDir: home,
			scorePath: () => 0,
		});
		expect(
			catalog.flows.filter((flow) => flow.name === "review.claude.md"),
		).toHaveLength(2);
		expect(catalog.counts).toMatchObject({ project: 1, global: 1 });
	});
});
