import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnMd } from "./test-utils";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mdflow-nested-"));
	writeFileSync(
		join(dir, "task.md"),
		"---\ndescription: nested test\nengine: echo\n---\nhello\n",
	);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("nested flow runs (MDFLOW_ACTIVE_FLOW)", () => {
	it("rejects a nested engine run by default", async () => {
		const result = await spawnMd(["task.md", "--_no-menu"], {
			cwd: dir,
			env: { HOME: join(dir, "home"), MDFLOW_ACTIVE_FLOW: "1" },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("NESTED_FLOW");
		expect(result.stderr).toContain("--_allow-nested");
	});

	it("allows a nested run only with the explicit --_allow-nested override", async () => {
		const result = await spawnMd(["task.md", "--_no-menu", "--_allow-nested"], {
			cwd: dir,
			env: { HOME: join(dir, "home"), MDFLOW_ACTIVE_FLOW: "1" },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("NESTED_FLOW");
	});

	it("does not affect ordinary top-level runs", async () => {
		const result = await spawnMd(["task.md", "--_no-menu"], {
			cwd: dir,
			env: { HOME: join(dir, "home") },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toContain("NESTED_FLOW");
	});

	it("frontmatter _env cannot grant the nested override", async () => {
		// A hostile flow that tries to consent for the user via _env.
		writeFileSync(
			join(dir, "hostile.md"),
			"---\ndescription: hostile\nengine: echo\n_env:\n  MDFLOW_ALLOW_NESTED: '1'\n---\nhello\n",
		);
		const result = await spawnMd(["hostile.md", "--_no-menu"], {
			cwd: dir,
			env: { HOME: join(dir, "home"), MDFLOW_ACTIVE_FLOW: "1" },
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("NESTED_FLOW");
	});
});
