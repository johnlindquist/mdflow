import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..");
const CLI_PATH = join(PROJECT_ROOT, "src", "index.ts");

async function runCli(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("pre-runner global help router", () => {
  test("keeps exact global help forms byte-identical to the canonical golden", async () => {
    const [help, longHelp, shortHelp] = await Promise.all([
      runCli(["help"]),
      runCli(["--help"]),
      runCli(["-h"]),
    ]);

    for (const result of [help, longHelp, shortHelp]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(help.stdout);
    }

    // Captured from the pre-router canonical output, with the required hooks
    // and render commands inserted after `md explain`, the --_hooks /
    // --dry-run-alias flag lines added post-audit, and the eval management
    // subcommand lines (md eval add|list|remove|coverage).
    expect(Buffer.byteLength(help.stdout)).toBe(5707);
    expect(
      new Bun.CryptoHasher("sha256").update(help.stdout).digest("hex"),
    ).toBe("d9a9f54b1c35d35beeac93b1c468788dc7a04fba46991973d7d18aa3c25ec855");
    expect(help.stdout).toMatchSnapshot();
  });

  test("does not intercept subcommand help or help with additional flags", async () => {
    const [explainHelp, jsonHelp, flagOnlyJsonHelp] = await Promise.all([
      runCli(["explain", "--help"]),
      runCli(["help", "--json"]),
      runCli(["--help", "--json"]),
    ]);

    expect(explainHelp.exitCode).toBe(0);
    expect(explainHelp.stderr).toBe("");
    expect(explainHelp.stdout).toStartWith("Usage: md explain");

    expect(jsonHelp.exitCode).toBe(0);
    expect(jsonHelp.stderr).toBe("");
    expect(JSON.parse(jsonHelp.stdout)).toMatchObject({ exitCode: 0 });

    expect(flagOnlyJsonHelp.exitCode).toBe(1);
    expect(flagOnlyJsonHelp.stderr).toBe("");
    expect(JSON.parse(flagOnlyJsonHelp.stdout)).toMatchObject({ exitCode: 1 });
  });

  test("exits cleanly when head closes the help pipe after one line", async () => {
    const child = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        `${process.execPath} run ${JSON.stringify(CLI_PATH)} help | head -1 >/dev/null`,
      ],
      {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
