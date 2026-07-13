/**
 * Behavioral eval suite for pr-description.md — run with:
 *   md eval flows/pr-description.md --plan   (free)
 *   md eval flows/pr-description.md --yes    (paid: 4 invocations — one case
 *   runs 3 stochastic trials with a 2-of-3 quorum)
 *
 * Showcases: repetitions + quorum for stochastic checks, git branch
 * fixtures, under/over word bounds, lead-with-outcome checks.
 * Guardrail: catches an unstable PR writer, one that reaches 200 words,
 * copies hashes, omits why or verification, or buries the outcome.
 * Requires git on PATH.
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

function initializeFeatureBranch(dir: string): void {
  git(dir, "init", "-q");
  git(dir, "checkout", "-q", "-b", "main");
  git(dir, "config", "user.email", "eval@example.test");
  git(dir, "config", "user.name", "mdflow eval");
  write(join(dir, "package.json"), '{"name":"fixture","scripts":{"test":"bun test"}}\n');
  write(join(dir, "src/index.ts"), "export const version = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "chore: initialize fixture");
  git(dir, "checkout", "-q", "-b", "feature/eval");
}

function checkPrDescription(stdout: string, changeAnchors: RegExp[]): string | null {
  const text = stdout.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const firstOutcomeWords = text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*#/.test(line))
    .slice(0, 3)
    .join(" ")
    .split(/\s+/)
    .slice(0, 60)
    .join(" ");
  // No arbitrary word minimum: the structural anchors below (every change,
  // rationale, verification) are the real substance check — a description
  // that satisfies all of them in 40 words is excellent, not "too thin".
  if (words.length >= 200) return `PR description must be under 200 words (got ${words.length})`;
  if (/\b[0-9a-f]{7,40}\b/i.test(text)) return "PR description must not expose raw commit hashes";
  // EVERY substantive change on the branch must be represented — anchors are
  // required individually so one change cannot cover for another.
  const missing = changeAnchors.filter((anchor) => !anchor.test(text));
  if (missing.length > 0) {
    return `PR description omits ${missing.length} of the branch's concrete changes (${missing.map(String).join(", ")})`;
  }
  if (!changeAnchors.some((anchor) => anchor.test(firstOutcomeWords))) {
    return "the opening does not lead with the branch outcome";
  }
  if (!/\bwhy\b|because|so that|prevents?|allows?|reduces?|avoids?|ensures?/i.test(text)) {
    return "missing a rationale for why the change was made";
  }
  if (!/verif(?:y|ied|ication)|validat(?:e|ed|ion)|tests?\b|test suite|bun test|npm test|pnpm test|yarn test/i.test(text)) {
    return "missing a concrete verification path";
  }
  return null;
}

const cases: EvalCase[] = [
  {
    name: "describes an export feature with stable quorum",
    kind: "stochastic",
    repetitions: 3,
    quorum: 2,
    setup: (dir) => {
      initializeFeatureBranch(dir);
      write(
        join(dir, "src/export.ts"),
        "export function toCsv(rows: string[][]): string { return rows.map((r) => r.join(',')).join('\\n'); }\n"
      );
      write(
        join(dir, "test/export.test.ts"),
        "import { test, expect } from 'bun:test';\nimport { toCsv } from '../src/export';\ntest('csv export', () => expect(toCsv([['a']])).toBe('a'));\n"
      );
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "feat(export): add CSV downloads");
      write(
        join(dir, "src/export.ts"),
        "export function toCsv(rows: string[][]): string { return rows.map((r) => r.map((v) => JSON.stringify(v)).join(',')).join('\\n'); }\n"
      );
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "fix(export): quote CSV cells");
    },
    // Change anchors only — verification/tests are asserted separately, so
    // a /test/ anchor can never double-count as a "concrete change".
    check: ({ stdout }) => checkPrDescription(stdout, [/CSV|export|download/i, /quot(?:e|ed|ing)|cell/i]),
  },
  {
    name: "describes a retry fix and its verification",
    setup: (dir) => {
      initializeFeatureBranch(dir);
      write(
        join(dir, "src/retry.ts"),
        "export async function retry<T>(fn: () => Promise<T>): Promise<T> { return fn(); }\n"
      );
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "fix(api): retry transient requests three times");
      write(
        join(dir, "test/retry.test.ts"),
        "import { test } from 'bun:test';\ntest('retry', () => {});\n"
      );
      git(dir, "add", ".");
      git(dir, "commit", "-qm", "test(api): cover transient request retries");
    },
    check: ({ stdout }) => checkPrDescription(stdout, [/retr(?:y|ies|ied)/i, /transient|request/i]),
  },
];

export default cases;
