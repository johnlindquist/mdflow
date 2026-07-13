/**
 * Behavioral eval suite for audit.claude.md — run with:
 *   md eval examples/multi-agent/audit.claude.md --plan   (free)
 *   md eval examples/multi-agent/audit.claude.md --yes    (paid: 3 invocations)
 *
 * Showcases: positional prompt (_1), setup fixtures, strict structured JSON
 * validation, a CLEAN no-findings contract, allowNonZero with failure-class
 * rejection.
 * Guardrail: catches an auditor that wraps output in prose (the flow
 * promises JSON or the word CLEAN — downstream patch.claude.md pipes this),
 * omits line numbers, misses either planted exposure (or merges both into
 * one combined finding), cries wolf on a safe file — or skips the CLEAN
 * token contract — or silently succeeds when the requested file is absent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalCase } from "mdflow/src/evals";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * The flow's contract is machine-readable output (it is piped straight into
 * patch.claude.md), so parsing is STRICT: the whole stdout must be the JSON
 * array — prose wrappers and Markdown fences are structure violations.
 */
function parseIssueArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text.trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const cases: EvalCase[] = [
  {
    name: "reports a vulnerable file as structured line-numbered JSON",
    prompt: "src/user.ts",
    setup: (dir) => {
      write(
        join(dir, "src/user.ts"),
        `export async function findUser(
  db: { query(sql: string): Promise<unknown> },
  name: string,
  password: string,
) {
  const sql = \`SELECT * FROM users WHERE name = '\${name}'\`;
  console.log("login attempt", { name, password });
  return db.query(sql);
}
`
      );
    },
    check: ({ stdout }) => {
      const issues = parseIssueArray(stdout);
      if (!issues) return "stdout must be exactly a JSON array (the flow's output is piped downstream)";
      if (issues.length === 0) return "expected a non-empty JSON issue list";
      const descriptions: string[] = [];
      for (const [index, raw] of issues.entries()) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return `issue ${index + 1} is not an object`;
        }
        const issue = raw as Record<string, unknown>;
        const line = issue.line ?? issue.lineNumber ?? issue.line_number;
        const description = issue.description ?? issue.issue ?? issue.message;
        if (!Number.isInteger(line) || Number(line) < 1 || Number(line) > 9) {
          return `issue ${index + 1} has no valid source line number`;
        }
        if (typeof description !== "string" || description.trim().length < 8) {
          return `issue ${index + 1} has no substantive description`;
        }
        descriptions.push(description);
      }
      // The fixture plants TWO distinct exposures; each needs its OWN
      // finding object — a single combined "SQL injection and password
      // logging" issue must not cover for both.
      const sqlIndices = new Set<number>();
      const credentialIndices = new Set<number>();
      descriptions.forEach((text, index) => {
        if (/SQL|inject/i.test(text)) sqlIndices.add(index);
        if (/credential|password|sensitive|log/i.test(text)) credentialIndices.add(index);
      });
      if (sqlIndices.size === 0) return "no issue describes the SQL injection in the query";
      if (credentialIndices.size === 0) return "no issue describes the credential-logging exposure";
      const hasDistinctFindings = [...sqlIndices].some((sqlIndex) =>
        [...credentialIndices].some((credentialIndex) => credentialIndex !== sqlIndex)
      );
      if (!hasDistinctFindings) {
        return "SQL injection and credential logging are separate exposures and need separate findings, not one combined issue";
      }
      return null;
    },
  },
  {
    name: "reports a safe file as CLEAN with no invented findings",
    prompt: "src/safe.ts",
    setup: (dir) => {
      write(
        join(dir, "src/safe.ts"),
        `export async function findUser(
  db: { query(sql: string, params?: unknown[]): Promise<unknown> },
  name: string,
): Promise<unknown> {
  return db.query("SELECT * FROM users WHERE name = ?", [name]);
}
`
      );
    },
    check: ({ stdout }) => {
      // The flow's contract for a clean file is the literal word CLEAN
      // (downstream patch.claude.md branches on that token), so an empty
      // JSON array is NOT an acceptable substitute. Tolerated variance is
      // documented: surrounding whitespace, optional quotes, a trailing
      // period, and letter case.
      const text = stdout.trim();
      if (/^"?CLEAN"?\.?$/i.test(text)) return null;
      return `safe file must output CLEAN (the flow's advertised contract), got: ${text.slice(0, 120)}`;
    },
  },
  {
    name: "surfaces a missing input file as an expected non-zero result",
    prompt: "src/missing.ts",
    allowNonZero: true,
    check: ({ stdout, stderr, exitCode, failureClass }) => {
      if (failureClass && failureClass !== "unknown") {
        return `unexpected ${failureClass} failure while testing a local missing file`;
      }
      if (exitCode === 0) return "missing file should not produce a successful audit";
      const text = `${stdout}\n${stderr}`;
      return /missing|no such file|not found|cat/i.test(text)
        ? null
        : "non-zero result did not explain that the requested file was missing";
    },
  },
];

export default cases;
