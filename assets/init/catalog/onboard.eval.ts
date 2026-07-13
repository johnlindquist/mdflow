/**
 * Behavioral eval suite for onboard.md — run with:
 *   md eval flows/onboard.md --plan   (free)
 *   md eval flows/onboard.md --yes    (paid: 2 invocations)
 *
 * Showcases: filesystem assertions through ctx.dir — every file path the
 * model cites is validated against the planted fixture project.
 * Guardrail: catches onboarding prose that hallucinates files, never
 * identifies core implementation paths, gives fewer than three concrete
 * starting files, or does not explain what the fixture actually does.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { EvalCase } from "mdflow/src/evals";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function citedFiles(text: string): string[] {
  // Longest extensions first + a trailing token boundary, so "package.json"
  // can never be captured as "package.js"; a path-shape rule below keeps
  // prose like "Node.js" from counting as a cited file.
  const pattern =
    /(?:^|[\s("'`])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx|ts|jsx|js|mjs|cjs|json|md|toml|yaml|yml|rs|go|py))((?:[:#]\d+(?:-\d+)?)?)(?![A-Za-z0-9])/gm;
  const files = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;
    const withoutLine = raw.replace(/^\.\//, "");
    const path = normalize(withoutLine).replaceAll("\\", "/");
    if (path.startsWith("../") || path.startsWith("/")) continue;
    // A citation is path-shaped: it has a directory segment, or it is a
    // conventional root config/doc file. A bare word with a code extension
    // ("Node.js", "index.ts" mid-sentence) is prose, not a citation.
    const rootConfigOrDoc = /^[A-Za-z0-9_.-]+\.(?:json|toml|yaml|yml|md)$/i.test(path);
    if (path.includes("/") || rootConfigOrDoc) files.add(path);
  }
  return [...files];
}

function checkOnboarding(stdout: string, dir: string, anchors: RegExp[]): string | null {
  const text = stdout.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const cited = citedFiles(text);
  const missing = cited.filter((path) => !existsSync(join(dir, path)));
  const existing = cited.filter((path) => existsSync(join(dir, path)));
  if (words < 80) return "onboarding guide is too thin for a new teammate";
  if (words > 600) return `onboarding guide is too long (${words} words)`;
  if (missing.length > 0) return `guide cites files that do not exist: ${missing.join(", ")}`;
  if (new Set(existing).size < 3) {
    return (
      "expected at least three concrete existing files, got " + (existing.join(", ") || "none")
    );
  }
  if (!existing.some((path) => path.startsWith("src/"))) {
    return "the reading path never points into the core src/ implementation";
  }
  if (anchors.filter((anchor) => anchor.test(text)).length < 2) {
    return "guide does not explain the fixture's actual purpose and architecture";
  }
  return null;
}

const cases: EvalCase[] = [
  {
    name: "onboards a queue worker using only real fixture paths",
    setup: (dir) => {
      write(
        join(dir, "README.md"),
        "# Acorn Queue\nA small TypeScript service that accepts jobs and processes them with workers.\n"
      );
      write(
        join(dir, "package.json"),
        '{"name":"acorn-queue","scripts":{"test":"bun test","start":"bun src/index.ts"}}\n'
      );
      write(join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
      write(join(dir, "src/index.ts"), "import { startWorker } from './worker';\nstartWorker();\n");
      write(
        join(dir, "src/queue.ts"),
        "const jobs: string[] = [];\nexport const enqueue = (job: string) => jobs.push(job);\n"
      );
      write(join(dir, "src/worker.ts"), "export function startWorker(): void { /* poll queue */ }\n");
      write(
        join(dir, "test/queue.test.ts"),
        "import { test } from 'bun:test';\ntest('queue', () => {});\n"
      );
    },
    check: ({ stdout, dir }) =>
      checkOnboarding(stdout, dir, [/Acorn|queue/i, /worker|job/i, /TypeScript|service/i]),
  },
  {
    name: "onboards a command-line config tool using real fixture paths",
    setup: (dir) => {
      write(
        join(dir, "README.md"),
        "# Quartz CLI\nA command-line tool that validates YAML configuration and prints a deployment plan.\n"
      );
      write(
        join(dir, "package.json"),
        '{"name":"quartz-cli","bin":{"quartz":"src/cli.ts"},"scripts":{"test":"bun test"}}\n'
      );
      write(join(dir, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
      write(
        join(dir, "src/cli.ts"),
        "import { loadConfig } from './config';\nconsole.log(loadConfig(process.argv[2]!));\n"
      );
      write(
        join(dir, "src/config.ts"),
        "export function loadConfig(path: string) { return { path }; }\n"
      );
      write(join(dir, "src/plan.ts"), "export function buildPlan(config: unknown) { return config; }\n");
      write(
        join(dir, "test/config.test.ts"),
        "import { test } from 'bun:test';\ntest('config', () => {});\n"
      );
    },
    check: ({ stdout, dir }) =>
      checkOnboarding(stdout, dir, [/Quartz|command-line|CLI/i, /YAML|config/i, /deployment|plan/i]),
  },
];

export default cases;
