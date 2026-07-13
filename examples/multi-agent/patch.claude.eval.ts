/**
 * Behavioral eval suite for patch.claude.md — run with:
 *   md eval examples/multi-agent/patch.claude.md --plan   (free)
 *   md eval examples/multi-agent/patch.claude.md --yes    (paid: 2 invocations)
 *
 * Showcases: simultaneous positional prompt and stdin, TypeScript
 * parseability (Bun.Transpiler), structural security assertions, and a
 * clean/no-op case.
 * Guardrail: catches a patcher that wraps code in prose, emits invalid
 * TypeScript, removes the public function, leaves SQL interpolation, adds
 * an unnecessary dependency, or rewrites a clean file unsafely.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalCase } from "mdflow/src/evals";

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function extractCode(stdout: string): string | null {
  const code = stdout.trim();
  if (!code || code.includes("```")) return null;
  if (
    !/^(?:\/\/|\/\*|import|export|const|let|var|async\s+function|function|class|interface|type)\b/.test(
      code
    )
  ) {
    return null;
  }
  return code;
}

function parsesAsTypeScript(code: string): string | null {
  try {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    transpiler.transformSync(code);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkSafeQuery(code: string): string | null {
  if (!/\bfindUser\b/.test(code)) return "rewritten code removed the findUser API";
  if (/SELECT[\s\S]{0,200}\$\{\s*name\s*\}/i.test(code)) {
    return "SQL query still interpolates name directly";
  }
  if (/SELECT[\s\S]{0,200}\+\s*name/i.test(code)) {
    return "SQL query still concatenates name directly";
  }
  // The placeholder must appear inside a string literal — a `params?:` type
  // annotation elsewhere in the signature must not satisfy this check.
  if (!/["'`][^"'`\n]*(?:\?|\$\d)[^"'`\n]*["'`]/.test(code)) {
    return "the SQL string has no parameter placeholder";
  }
  if (!/query\s*\([\s\S]*?,[\s\S]*(?:\[\s*name\s*\]|values\s*:\s*\[\s*name\s*\])/i.test(code)) {
    return "query does not pass name as a bound parameter";
  }
  return null;
}

/** Whitespace-insensitive equality for "leave clean input alone" checks. */
function normalizedEquals(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(a) === normalize(b);
}

const VULNERABLE_SOURCE = `export async function findUser(
  db: { query(sql: string, params?: unknown[]): Promise<unknown> },
  name: string,
): Promise<unknown> {
  return db.query(\`SELECT * FROM users WHERE name = '\${name}'\`);
}
`;

const SAFE_SOURCE = `export async function findUser(
  db: { query(sql: string, params?: unknown[]): Promise<unknown> },
  name: string,
): Promise<unknown> {
  return db.query("SELECT * FROM users WHERE name = ?", [name]);
}
`;

const cases: EvalCase[] = [
  {
    name: "uses positional file input and piped audit to parameterize SQL",
    prompt: "src/user.ts",
    stdin: '[{"line":5,"description":"SQL injection: name is interpolated into the query"}]',
    setup: (dir) => write(join(dir, "src/user.ts"), VULNERABLE_SOURCE),
    check: ({ stdout }) => {
      const code = extractCode(stdout);
      if (!code) return "expected code only, with no Markdown fence or commentary";
      if (code.length < 120 || code.length > 2_000) {
        return `unexpected rewritten-code size: ${code.length} bytes`;
      }
      const parseError = parsesAsTypeScript(code);
      if (parseError) return `output is not parseable TypeScript: ${parseError}`;
      return checkSafeQuery(code);
    },
  },
  {
    name: "preserves a clean file as safe parseable code",
    prompt: "src/user.ts",
    stdin: "CLEAN",
    setup: (dir) => write(join(dir, "src/user.ts"), SAFE_SOURCE),
    check: ({ stdout }) => {
      const code = extractCode(stdout);
      if (!code) return "expected the original code only, with no prose wrapper";
      const parseError = parsesAsTypeScript(code);
      if (parseError) return `output is not parseable TypeScript: ${parseError}`;
      // A clean audit means a no-op: anything beyond whitespace drift is an
      // unrequested rewrite, however "safe" it looks.
      if (!normalizedEquals(code, SAFE_SOURCE)) {
        return "clean input must be returned unchanged (whitespace aside)";
      }
      return null;
    },
  },
];

export default cases;
