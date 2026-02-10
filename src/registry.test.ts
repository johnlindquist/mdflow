import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installAgent, listAgents, removeAgent, resolveInstallSpec } from "./registry";
import { CliRunner } from "./cli-runner";
import { createTestEnvironment } from "./system-environment";

interface TestDirs {
  root: string;
  projectCwd: string;
  homeDir: string;
}

interface FetchResponse {
  status?: number;
  body: string;
}

function createFetchStub(
  responses: Record<string, FetchResponse>
): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: typeof fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    calls.push(url);
    const response = responses[url];
    if (!response) {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }

    return new Response(response.body, { status: response.status ?? 200 });
  }) as typeof fetch;

  return { fetchFn, calls };
}

describe("registry", () => {
  let dirs: TestDirs;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "mdflow-registry-test-"));
    const projectCwd = join(root, "project");
    const homeDir = join(root, "home");
    mkdirSync(projectCwd, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    dirs = { root, projectCwd, homeDir };
  });

  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true });
  });

  test("test_installAgent_writes_lockfile_with_sha256_when_gh_shorthand_is_used", async () => {
    mkdirSync(join(dirs.projectCwd, ".mdflow"), { recursive: true });
    const spec = "gh:acme/tools/agents/review.claude.md@main";
    const expectedUrl = "https://raw.githubusercontent.com/acme/tools/main/agents/review.claude.md";
    const content = "---\nmodel: claude\n---\nReview this PR";
    const installedDate = new Date("2026-02-10T14:00:00.000Z");
    const { fetchFn, calls } = createFetchStub({
      [expectedUrl]: { body: content },
    });

    const result = await installAgent(spec, {
      scope: "project",
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
      fetchFn,
      now: () => installedDate,
    });

    expect(calls).toEqual([expectedUrl]);
    expect(result.name).toBe("review.claude.md");
    expect(result.source).toBe(spec);
    expect(result.resolvedRef).toBe("main");
    expect(result.scope).toBe("project");

    const lockfilePath = join(dirs.projectCwd, ".mdflow", "mdflow.lock.json");
    expect(existsSync(lockfilePath)).toBe(true);
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
      entries: Record<string, {
        source: string;
        resolvedRef?: string;
        sha256: string;
        installedPath: string;
        installedAt: string;
      }>;
    };
    const entry = lockfile.entries["review.claude.md"];
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(entry.source).toBe(spec);
    expect(entry.resolvedRef).toBe("main");
    expect(entry.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(entry.installedAt).toBe(installedDate.toISOString());
    expect(readFileSync(entry.installedPath, "utf8")).toBe(content);
  });

  test("test_installAgent_uses_user_registry_when_project_mdflow_directory_is_missing", async () => {
    const spec = "https://example.com/agents/lint.md";
    const content = "# lint agent";
    const { fetchFn } = createFetchStub({
      [spec]: { body: content },
    });

    const result = await installAgent(spec, {
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
      fetchFn,
      now: () => new Date("2026-02-10T14:01:00.000Z"),
    });

    expect(result.scope).toBe("user");
    expect(result.installedPath).toBe(join(dirs.homeDir, ".mdflow", "registry", "lint.md"));
    expect(existsSync(join(dirs.homeDir, ".mdflow", "mdflow.lock.json"))).toBe(true);
    expect(readFileSync(result.installedPath, "utf8")).toBe(content);
  });

  test("test_installAgent_converts_github_blob_urls_to_raw_content_url_before_fetching", async () => {
    mkdirSync(join(dirs.projectCwd, ".mdflow"), { recursive: true });
    const spec = "https://github.com/acme/tools/blob/main/agents/triage.md";
    const expectedUrl = "https://raw.githubusercontent.com/acme/tools/main/agents/triage.md";
    const { fetchFn, calls } = createFetchStub({
      [expectedUrl]: { body: "# triage" },
    });

    await installAgent(spec, {
      scope: "project",
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
      fetchFn,
      now: () => new Date("2026-02-10T14:02:00.000Z"),
    });

    expect(calls).toEqual([expectedUrl]);
  });

  test("test_removeAgent_deletes_file_and_lockfile_entry_when_agent_exists", async () => {
    mkdirSync(join(dirs.projectCwd, ".mdflow"), { recursive: true });
    const spec = "https://example.com/cleanup.claude.md";
    const { fetchFn } = createFetchStub({
      [spec]: { body: "clean up temp files" },
    });

    const installed = await installAgent(spec, {
      scope: "project",
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
      fetchFn,
      now: () => new Date("2026-02-10T14:03:00.000Z"),
    });

    const removed = await removeAgent("cleanup.claude", {
      scope: "project",
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
    });

    expect(removed.removed).toBe(true);
    expect(removed.removedFrom).toEqual(["project"]);
    expect(existsSync(installed.installedPath)).toBe(false);

    const lockfilePath = join(dirs.projectCwd, ".mdflow", "mdflow.lock.json");
    const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
      entries: Record<string, unknown>;
    };
    expect(lockfile.entries["cleanup.claude.md"]).toBeUndefined();
  });

  test("test_removeAgent_returns_removed_false_when_agent_is_not_installed", async () => {
    const removed = await removeAgent("missing-agent.md", {
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
    });

    expect(removed.removed).toBe(false);
    expect(removed.removedFrom).toEqual([]);
  });

  test("test_listAgents_returns_source_metadata_across_project_and_user_scopes", async () => {
    mkdirSync(join(dirs.projectCwd, ".mdflow"), { recursive: true });
    const projectSpec = "https://example.com/project-agent.md";
    const userSpec = "gh:acme/tools/agents/global-agent.md@v1";
    const projectUrl = projectSpec;
    const userUrl = "https://raw.githubusercontent.com/acme/tools/v1/agents/global-agent.md";
    const { fetchFn } = createFetchStub({
      [projectUrl]: { body: "project agent body" },
      [userUrl]: { body: "user agent body" },
    });

    await installAgent(projectSpec, {
      scope: "project",
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
      fetchFn,
      now: () => new Date("2026-02-10T14:04:00.000Z"),
    });

    await installAgent(userSpec, {
      scope: "user",
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
      fetchFn,
      now: () => new Date("2026-02-10T14:05:00.000Z"),
    });

    const agents = await listAgents({
      cwd: dirs.projectCwd,
      homeDir: dirs.homeDir,
    });

    expect(agents).toHaveLength(2);
    expect(agents[0]?.name).toBe("global-agent.md");
    expect(agents[0]?.scope).toBe("user");

    const projectAgent = agents.find((agent) => agent.name === "project-agent.md");
    expect(projectAgent?.scope).toBe("project");
    expect(projectAgent?.source).toBe(projectSpec);
    expect(typeof projectAgent?.sha256).toBe("string");

    const userAgent = agents.find((agent) => agent.name === "global-agent.md");
    expect(userAgent?.scope).toBe("user");
    expect(userAgent?.source).toBe(userSpec);
    expect(userAgent?.resolvedRef).toBe("v1");
  });

  test("test_resolveInstallSpec_defaults_gh_ref_to_main_when_not_provided", () => {
    const resolved = resolveInstallSpec("gh:acme/tools/agents/reviewer.md");
    expect(resolved.downloadUrl).toBe(
      "https://raw.githubusercontent.com/acme/tools/main/agents/reviewer.md"
    );
    expect(resolved.resolvedRef).toBe("main");
    expect(resolved.suggestedName).toBe("reviewer.md");
  });

  test("test_cliRunner_install_list_remove_subcommands_manage_registry_entries", async () => {
    mkdirSync(join(dirs.projectCwd, ".mdflow"), { recursive: true });
    const spec = "https://example.com/agents/runner-agent.md";
    const { fetchFn } = createFetchStub({
      [spec]: { body: "runner agent body" },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;

    try {
      const runner = new CliRunner({
        env: createTestEnvironment(),
        cwd: dirs.projectCwd,
        isStdinTTY: true,
      });

      const installResult = await runner.run(["node", "md", "install", spec, "--project"]);
      expect(installResult.exitCode).toBe(0);

      const listResult = await runner.run(["node", "md", "list", "--project"]);
      expect(listResult.exitCode).toBe(0);

      const removeResult = await runner.run(["node", "md", "remove", "runner-agent", "--project"]);
      expect(removeResult.exitCode).toBe(0);

      const lockfilePath = join(dirs.projectCwd, ".mdflow", "mdflow.lock.json");
      const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
        entries: Record<string, unknown>;
      };
      expect(lockfile.entries["runner-agent.md"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
