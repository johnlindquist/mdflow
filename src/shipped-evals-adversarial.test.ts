/**
 * Adversarial regression tests for the shipped eval suites' check() logic
 * (audit finding F13): each "hardened" check previously still ACCEPTED the
 * exact weak output its comment claimed to reject. These tests execute the
 * real check() functions directly against adversarial fixtures and assert
 * rejection (the EvalCase contract: null = pass, string = failure reason),
 * plus happy-path fixtures proving genuinely good model output still passes
 * so the paid evals stay strict without becoming brittle.
 *
 * The suites are loaded via runtime-computed dynamic import (the same
 * mechanism the eval runner uses in evals.ts) because the shipped suites'
 * `import type ... from "mdflow/src/evals"` is a type-only import that only
 * exists for editor tooling — it is erased at runtime and is not resolvable
 * inside this repo's tsc program.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { EvalCase, EvalContext } from "./evals";

const ROOT = join(import.meta.dir, "..");

async function loadSuite(relativePath: string): Promise<EvalCase[]> {
  const suitePath = join(ROOT, relativePath);
  const mod = (await import(suitePath)) as { default: EvalCase[] };
  if (!Array.isArray(mod.default)) throw new Error(`${relativePath}: expected a default EvalCase[]`);
  return mod.default;
}

function findCase(cases: EvalCase[], name: string): EvalCase {
  const found = cases.find((evalCase) => evalCase.name === name);
  if (!found) throw new Error(`case not found: ${name}`);
  return found;
}

function ctx(stdout: string, overrides: Partial<EvalContext> = {}): EvalContext {
  return { stdout, stderr: "", exitCode: 0, dir: "/nonexistent-eval-dir", ...overrides };
}

async function runCheck(evalCase: EvalCase, context: EvalContext): Promise<string | null> {
  return await evalCase.check(context);
}

const auditCases = await loadSuite("examples/multi-agent/audit.claude.eval.ts");
const logoCases = await loadSuite("examples/logo-grid.claude.eval.ts");
const commitCases = await loadSuite("examples/commit.claude.eval.ts");

describe("audit.claude.eval.ts checks", () => {
  const vulnerable = findCase(auditCases, "reports a vulnerable file as structured line-numbered JSON");
  const clean = findCase(auditCases, "reports a safe file as CLEAN with no invented findings");

  it("one combined audit issue cannot cover two exposures", async () => {
    const combined = JSON.stringify([
      { line: 6, description: "SQL injection and password logging in this function" },
    ]);
    const verdict = await runCheck(vulnerable, ctx(combined));
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("separate");
  });

  it("still accepts two distinct, line-numbered findings", async () => {
    const good = JSON.stringify([
      { line: 6, description: "SQL injection: user-controlled name is interpolated into the query" },
      { line: 7, description: "Sensitive data exposure: the plaintext password is logged" },
    ]);
    expect(await runCheck(vulnerable, ctx(good))).toBeNull();
  });

  it("accepts distinct findings regardless of ordering or extra findings", async () => {
    const good = JSON.stringify([
      { line: 7, description: "Credential logging: password written to console output" },
      { line: 8, description: "Executes an injectable SQL string built by concatenation" },
    ]);
    expect(await runCheck(vulnerable, ctx(good))).toBeNull();
  });

  it("safe audit output must follow the CLEAN contract: bare [] fails", async () => {
    const verdict = await runCheck(clean, ctx("[]"));
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("CLEAN");
  });

  it("safe audit output: literal CLEAN passes (with documented tolerance only)", async () => {
    expect(await runCheck(clean, ctx("CLEAN"))).toBeNull();
    expect(await runCheck(clean, ctx('  "CLEAN"\n'))).toBeNull();
    expect(await runCheck(clean, ctx("clean."))).toBeNull();
    expect(await runCheck(clean, ctx("The file is CLEAN, no issues found."))).not.toBeNull();
  });
});

describe("logo-grid.claude.eval.ts checks", () => {
  const previewable = findCase(logoCases, "keeps every mark self-contained, color-bounded, and previewable");

  function mark(index: number): string {
    return `<svg id="logo-${index}" viewBox="0 0 120 120" width="120" height="120"><circle cx="60" cy="60" r="${10 + index * 7}" fill="#112233"/></svg>`;
  }

  function previews(): string {
    return (
      `<svg viewBox="0 0 120 120" width="16" height="16"><circle cx="60" cy="60" r="40" fill="#112233"/></svg>` +
      `<svg viewBox="0 0 120 120" width="32" height="32"><circle cx="60" cy="60" r="40" fill="#112233"/></svg>`
    );
  }

  function page(cells: string): string {
    return `<!DOCTYPE html>
<html><head><style>
body{font-family:system-ui;background:#fafafa}
.grid{display:grid;grid-template-columns:repeat(3,1fr)}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}
</style></head><body><main class="grid">${cells}</main></body></html>`;
  }

  it("favicon preview counts are enforced per concept: all previews under one concept fails", async () => {
    // Twelve preview tokens (six 16s, six 32s) parked under logo-1 satisfied
    // the old GLOBAL count; per-concept slicing must reject it.
    const hoarder =
      `<section>${mark(1)}<div>${previews().repeat(6)}</div></section>` +
      [2, 3, 4, 5, 6].map((index) => `<section>${mark(index)}</section>`).join("");
    const verdict = await runCheck(previewable, ctx(page(hoarder)));
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("logo-2");
  });

  it("well-formed per-concept output still passes", async () => {
    const cells = [1, 2, 3, 4, 5, 6]
      .map((index) => `<section>${mark(index)}<div>${previews()}</div></section>`)
      .join("");
    expect(await runCheck(previewable, ctx(page(cells)))).toBeNull();
  });
});

describe("commit.claude.eval.ts checks", () => {
  const invoice = findCase(commitCases, "summarizes an invoice retry feature from stdin");
  const parser = findCase(commitCases, "summarizes a parser crash fix from stdin");
  const docs = findCase(commitCases, "summarizes a deployment documentation change from stdin");

  it("parser commit must name the defaulting behavior", async () => {
    const verdict = await runCheck(parser, ctx("fix(parser): improve parser handling"));
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("behavior");
  });

  it("parser commit naming default/empty-input behavior passes", async () => {
    expect(await runCheck(parser, ctx("fix(config): default port to 3000 for empty input"))).toBeNull();
    expect(await runCheck(parser, ctx("fix(parser): handle undefined port values safely"))).toBeNull();
  });

  it("invoice commit cannot pass on the subsystem word alone", async () => {
    expect(await runCheck(invoice, ctx("feat(invoice): improve invoice handling"))).not.toBeNull();
    expect(await runCheck(invoice, ctx("feat(payments): add invoice retry with 3 attempts"))).toBeNull();
  });

  it("docs commit must name the rollback content, not just the deploy area", async () => {
    expect(await runCheck(docs, ctx("docs(deploy): update deployment documentation"))).not.toBeNull();
    expect(await runCheck(docs, ctx("docs(deploy): add rollback instructions"))).toBeNull();
  });

  it("still rejects the original failure classes (shape, fences, hashes)", async () => {
    expect(await runCheck(parser, ctx("Here is a commit message:\nfix(config): default missing port"))).not.toBeNull();
    expect(await runCheck(parser, ctx("```\nfix(config): default missing port\n```"))).not.toBeNull();
    expect(await runCheck(parser, ctx("fix(config): default missing port as in 3333333"))).not.toBeNull();
  });
});
