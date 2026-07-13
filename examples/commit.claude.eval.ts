/**
 * Behavioral eval suite for commit.claude.md — run with:
 *   md eval examples/commit.claude.md --plan   (free)
 *   md eval examples/commit.claude.md --yes    (paid: 3 invocations)
 *
 * Showcases: stdin piping, multiple representative inputs, two-sided bounds.
 * Guardrail: catches a model that emits prose, multiple lines, an invalid
 * conventional-commit shape, a vague tiny answer, a message of 72+
 * characters, a copied commit hash, or a summary that names the subsystem
 * without the actual behavior changed (anchor groups: all must match).
 */
import type { EvalCase } from "mdflow/src/evals";

const CONVENTIONAL_COMMIT =
  /^(feat|fix|docs|style|refactor|test|chore)\([a-z0-9][a-z0-9._/-]*\): [^\r\n]+$/;
const COMMIT_HASH = /\b[0-9a-f]{7,40}\b/i;

/**
 * Anchor GROUPS: every group must match somewhere in the message. Each case
 * passes one group naming the subsystem touched and one naming the behavior
 * changed, so "fix(parser): improve parser handling" cannot pass on the
 * subsystem word alone.
 */
function checkCommitMessage(stdout: string, anchorGroups: RegExp[][]): string | null {
  const message = stdout.trim();
  const length = [...message].length;
  if (!message) return "expected one commit-message line";
  if (message.includes("```")) return "output must not be wrapped in a code fence";
  if (message.split(/\r?\n/).length !== 1) return "expected exactly one line";
  if (length < 12) return `message is too vague (${length} characters)`;
  if (length >= 72) return `message must be under 72 characters (got ${length})`;
  if (!CONVENTIONAL_COMMIT.test(message)) {
    return "expected type(scope): description using an allowed conventional-commit type";
  }
  if (COMMIT_HASH.test(message)) return "commit messages must not contain commit hashes";
  for (const group of anchorGroups) {
    if (!group.some((anchor) => anchor.test(message))) {
      return "description must name both the subsystem and the behavior changed by the diff";
    }
  }
  return null;
}

const cases: EvalCase[] = [
  {
    name: "summarizes an invoice retry feature from stdin",
    stdin: `diff --git a/src/payments/invoice.ts b/src/payments/invoice.ts
index 1111111..2222222 100644
--- a/src/payments/invoice.ts
+++ b/src/payments/invoice.ts
@@ -8,6 +8,10 @@
 export async function sendInvoice(id: string) {
   return gateway.send(id);
 }
+
+export async function retryInvoice(id: string) {
+  return gateway.retry(id, { attempts: 3 });
+}
`,
    check: ({ stdout }) =>
      checkCommitMessage(stdout, [
        [/invoice/i, /payment/i],
        [/retry/i, /re-?attempt/i, /resend/i],
      ]),
  },
  {
    name: "summarizes a parser crash fix from stdin",
    stdin: `diff --git a/src/config/parser.ts b/src/config/parser.ts
index 3333333..4444444 100644
--- a/src/config/parser.ts
+++ b/src/config/parser.ts
@@ -21,7 +21,9 @@
 export function parsePort(raw: string | undefined) {
-  return Number(raw.trim());
+  if (raw == null || raw.trim() === "") return 3000;
+  return Number(raw.trim());
 }
`,
    check: ({ stdout }) =>
      checkCommitMessage(stdout, [
        [/pars/i, /config/i, /\bports?\b/i],
        [/missing/i, /empty/i, /default/i, /fallback/i, /undefined/i, /unset/i],
      ]),
  },
  {
    name: "summarizes a deployment documentation change from stdin",
    stdin: `diff --git a/docs/deploy.md b/docs/deploy.md
index 5555555..6666666 100644
--- a/docs/deploy.md
+++ b/docs/deploy.md
@@ -4,3 +4,8 @@
 Run the release workflow from main.
+
+## Rollback
+
+Use the previous image tag and verify the health endpoint before reopening
+traffic.
`,
    check: ({ stdout }) =>
      checkCommitMessage(stdout, [
        [/deploy/i, /release/i],
        [/rollback/i, /roll[- ]back/i, /revert/i],
      ]),
  },
];

export default cases;
