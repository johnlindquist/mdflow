/**
 * Behavioral eval suite for changelog.md — run with:
 *   md eval flows/changelog.md --plan   (free)
 *   md eval flows/changelog.md --yes    (paid: 2 invocations)
 *
 * Showcases: git-history fixtures, structural section parsing, two-sided
 * bounds, prohibited-content checks.
 * Guardrail: catches a changelog that copies raw commit subjects or hashes,
 * omits feature/fix/chore grouping, misses actual release content, or is
 * too thin or bloated. Requires git on PATH.
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
  write(join(dir, "README.md"), "# Fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "chore: initialize fixture");
}

function commitFile(dir: string, file: string, content: string, message: string): void {
  write(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-qm", message);
}

type ChangeGroup = "feature" | "fix" | "chore";

function headingGroup(line: string): ChangeGroup | undefined {
  const label = line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\*\*(.+)\*\*:?$/, "$1")
    .replace(/:$/, "")
    .trim()
    .toLowerCase();
  if (/^(features?|added)$/.test(label)) return "feature";
  if (/^(fix(?:es)?|bug fixes?)$/.test(label)) return "fix";
  if (/^(chores?|maintenance)$/.test(label)) return "chore";
  return undefined;
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed) || /^\*\*[^*]+\*\*:?$/.test(trimmed);
}

function groupedContent(text: string): Record<ChangeGroup, number> {
  const counts: Record<ChangeGroup, number> = { feature: 0, fix: 0, chore: 0 };
  let current: ChangeGroup | undefined;
  for (const line of text.split(/\r?\n/)) {
    const group = headingGroup(line);
    if (group) {
      current = group;
      continue;
    }
    if (isHeadingLine(line)) {
      // An unrecognized heading ("Docs", "Breaking changes") ends the
      // previous group — its content must not inflate that group's count.
      current = undefined;
      continue;
    }
    if (current && line.trim()) counts[current]++;
  }
  return counts;
}

function checkChangelog(stdout: string, anchors: RegExp[]): string | null {
  const text = stdout.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const groups = groupedContent(text);
  if (words < 25) return "changelog is too thin to explain the user-visible changes";
  if (words > 220) return `changelog is not concise (${words} words)`;
  if (groups.feature === 0) return "missing a populated feature group";
  if (groups.fix === 0) return "missing a populated fix group";
  if (groups.chore === 0) return "missing a populated chore group";
  if (/\b[0-9a-f]{7,40}\b/i.test(text)) return "changelog must not expose commit hashes";
  if (/^\s*[-*]\s*(feat|fix|chore)(?:\([^)]*\))?:/im.test(text)) {
    return "rewrite commit subjects for users instead of copying conventional prefixes";
  }
  const matchedAnchors = anchors.filter((anchor) => anchor.test(text)).length;
  if (matchedAnchors < 2) return "changelog omitted most of the actual release content";
  return null;
}

const cases: EvalCase[] = [
  {
    name: "groups export, timeout, and cache changes without hashes",
    setup: (dir) => {
      initializeRepo(dir);
      commitFile(
        dir,
        "src/export.ts",
        "export const exportCsv = () => 'csv';\n",
        "feat(export): add CSV downloads"
      );
      commitFile(
        dir,
        "src/timeout.ts",
        "export const requestTimeoutMs = 15000;\n",
        "fix(api): prevent requests from hanging forever"
      );
      commitFile(
        dir,
        "src/cache.ts",
        "export const cacheVersion = 2;\n",
        "chore(cache): refresh cache metadata"
      );
    },
    check: ({ stdout }) => checkChangelog(stdout, [/CSV|export/i, /timeout|hanging/i, /cache/i]),
  },
  {
    name: "groups search, sync, and dependency changes for users",
    setup: (dir) => {
      initializeRepo(dir);
      commitFile(
        dir,
        "src/search.ts",
        "export const fuzzySearch = true;\n",
        "feat(search): support fuzzy project matching"
      );
      commitFile(
        dir,
        "src/sync.ts",
        "export const preservesDeletedItems = false;\n",
        "fix(sync): stop deleted items from reappearing"
      );
      commitFile(
        dir,
        "package.json",
        '{"name":"fixture","dependencies":{"yaml":"2.8.0"}}\n',
        "chore(deps): update yaml dependency"
      );
    },
    check: ({ stdout }) =>
      checkChangelog(stdout, [/fuzzy|search/i, /deleted|reappearing|sync/i, /dependency|yaml/i]),
  },
];

export default cases;
