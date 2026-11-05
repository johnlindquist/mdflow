import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(command: string[], cwd: string, env = process.env, stdin?: string): Promise<SpawnResult> {
  const proc = Bun.spawn(command, {
    cwd,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function requireSuccess(label: string, result: SpawnResult): void {
  if (result.exitCode === 0) return;
  throw new Error(`${label} failed (${result.exitCode})\n${result.stderr || result.stdout}`);
}

const root = resolve(import.meta.dir, "..");
const temp = await mkdtemp(join(tmpdir(), "mdflow-package-smoke-"));

try {
  const packed = await run(["npm", "pack", "--json", "--pack-destination", temp], root);
  requireSuccess("npm pack", packed);
  const metadata = JSON.parse(packed.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const artifact = metadata[0];
  if (!artifact) throw new Error("npm pack returned no artifact metadata");

  const paths = new Set(artifact.files.map((file) => file.path));
  for (const expected of ["LICENSE", "README.md", "bin/mdflow.mjs", "src/index.ts", "assets/capture/guide.md", "assets/init/catalog/review.eval.ts", "skills/mdflow/SKILL.md"]) {
    if (!paths.has(expected)) throw new Error(`packed artifact is missing ${expected}`);
  }

  for (const path of paths) {
    if (/\.test\.ts$|__snapshots__|^src\/test-utils\.ts$|^site\/|(^|\/)\.env($|\.)/.test(path)) throw new Error("Unexpected packed file: " + path);
  }
  const consumer = join(temp, "consumer");
  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  const installed = await run([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temp, artifact.filename),
  ], consumer);
  requireSuccess("clean tarball install", installed);

  // Exercise the actual bin links npm created. A source-tree import or a help
  // banner alone does not prove a consumer can scaffold, plan, and dispatch.
  const home = join(temp, "home");
  await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CI: "1", MDFLOW_NO_TTY_PROMPT: "1", TMPDIR: temp };
  const cli = (bin: string, args: string[], stdin?: string) => run([join(consumer, "node_modules", ".bin", bin), ...args], consumer, env, stdin);
  const help = await cli("mdflow", ["--help"]);
  requireSuccess("installed mdflow --help", help);
  if (!help.stdout.includes("Usage: md")) throw new Error("Installed help is missing the usage banner");
  requireSuccess("installed init", await cli("mdflow", ["init", "--yes"]));
  requireSuccess("installed static eval planner", await cli("md", ["eval", "flows/review.md", "--plan"]));
  await writeFile(join(consumer, "proof.echo.md"), "---\n_max_prompt_tokens: 100\n---\n{{ _stdin }}");
  const input = "literal !`printf WRONG`";
  const events = await cli("mdflow", ["proof.echo.md", "--events"], input);
  requireSuccess("installed event dispatch", events);
  const rows = events.stdout.trim().split("\n").map(s => JSON.parse(s));
  const output = rows.filter(e => e.event === "output.delta" && e.channel === "stdout").map(e => e.text).join("");
  if (rows[0]?.event !== "protocol" || rows.at(-1)?.event !== "run.completed" || output.trimEnd() !== input) {
    throw new Error("Installed CLI did not dispatch the literal input through the event protocol");
  }
  const refused = await cli("md", ["proof.echo.md", "--_dry-run", "--events"], input);
  const refusal = refused.stdout.trim().split("\n").map(s => JSON.parse(s).event);
  if (!refused.exitCode || refusal.join(",") !== "protocol,run.error") throw new Error("Installed CLI violated dry-run consent");

  console.log(`package smoke passed: ${artifact.filename}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
