/**
 * Behavioral eval suite for review.md — run with:
 *   md eval flows/review.md --plan   (free)
 *   md eval flows/review.md --yes    (paid: 2 invocations)
 *
 * Showcases: setup() git fixtures, staged diffs, concrete file:line citations.
 * Guardrail: catches a reviewer that gives generic advice, misses a planted
 * off-by-one or authorization bug, cites no location, or produces a long
 * unfocused review. Requires git on PATH.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalCase } from "mdflow/src/evals";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(dir: string, ...args: string[]): void {
  if (!Bun.which("git")) {
    // The INCONCLUSIVE: prefix marks this trial environment-inconclusive
    // (missing prerequisite), not a behavioral failure of the flow.
    throw new Error("INCONCLUSIVE: git is not on PATH; this suite needs git fixtures");
  }
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
}

function initializeRepo(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "checkout", "-q", "-b", "main");
  git(dir, "config", "user.email", "eval@example.test");
  git(dir, "config", "user.name", "mdflow eval");
}

function checkReview(stdout: string, file: string, issue: RegExp): string | null {
  const text = stdout.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const citation = new RegExp(`${escaped}:\\d+(?:-\\d+)?`);
  if (words < 12) return "review is too thin to explain the defect";
  if (words > 220) return `review is not terse (${words} words)`;
  if (!citation.test(text)) return `expected a concrete ${file}:line citation`;
  if (!issue.test(text)) return "review did not identify the staged behavioral defect";
  return null;
}

const cases: EvalCase[] = [
  {
    name: "finds an out-of-bounds loop in a staged diff",
    setup: (dir) => {
      initializeRepo(dir);
      const path = join(dir, "src/items.ts");
      write(
        path,
        `export function total(items: Array<{ price: number }>): number {
  let result = 0;
  for (let i = 0; i < items.length; i++) result += items[i]!.price;
  return result;
}
`
      );
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat(items): add total helper");
      write(
        path,
        `export function total(items: Array<{ price: number }>): number {
  let result = 0;
  for (let i = 0; i <= items.length; i++) result += items[i]!.price;
  return result;
}
`
      );
      git(dir, "add", "src/items.ts");
    },
    check: ({ stdout }) =>
      checkReview(
        stdout,
        "src/items.ts",
        /out[- ]of[- ]bounds|undefined|off[- ]by[- ]one|<=.*length|length.*index/i
      ),
  },
  {
    name: "finds an authorization assignment bug in a staged diff",
    setup: (dir) => {
      initializeRepo(dir);
      const path = join(dir, "src/auth.ts");
      write(
        path,
        `export function canDelete(user: { id: string; role: string }, ownerId: string): boolean {
  return user.role === "admin" || user.id === ownerId;
}
`
      );
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat(auth): add delete authorization");
      write(
        path,
        `export function canDelete(user: { id: string; role: string }, ownerId: string): boolean {
  if ((user.role = "admin") || user.id === ownerId) return true;
  return false;
}
`
      );
      git(dir, "add", "src/auth.ts");
    },
    check: ({ stdout }) =>
      checkReview(
        stdout,
        "src/auth.ts",
        /assignment|single equals|mutat(?:e|es|ing).*role|authorization|permission|always truthy|bypass/i
      ),
  },
];

export default cases;
