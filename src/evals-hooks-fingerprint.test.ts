/**
 * A flow's lifecycle hooks are part of its behavior, so changing a hook must
 * invalidate a clean eval/evolve verification receipt exactly like changing
 * the prompt body would (fusion-max audit should-fix #3).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerificationEnvironmentFingerprint } from "./evals";
import { renderHooksTemplate } from "./hooks";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mdflow-hook-fp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFlowAndSuite(): { flow: string; suite: string } {
  const flow = join(dir, "task.codex.md");
  const suite = join(dir, "task.codex.eval.ts");
  writeFileSync(flow, "---\ndescription: t\n---\nSay ok.\n");
  writeFileSync(suite, "export default [];\n");
  return { flow, suite };
}

describe("hook bytes in the eval verification fingerprint", () => {
  it("flowHash changes when the hooks file changes", async () => {
    const { flow, suite } = writeFlowAndSuite();
    const hooksFile = join(dir, "task.codex.hooks.ts");
    writeFileSync(hooksFile, renderHooksTemplate(["stop"]), { mode: 0o755 });

    const before = await buildVerificationEnvironmentFingerprint(flow, suite);
    writeFileSync(hooksFile, renderHooksTemplate(["stop", "sessionStart"]), { mode: 0o755 });
    const after = await buildVerificationEnvironmentFingerprint(flow, suite);

    expect(after.flowHash).not.toBe(before.flowHash);
  });

  it("flowHash changes when a helper IMPORTED by the hooks file changes", async () => {
    const { flow, suite } = writeFlowAndSuite();
    const helper = join(dir, "policy.ts");
    writeFileSync(helper, "export const LIMIT = 1;\n");
    // A hand-written hooks file that imports a local helper (still statically
    // discoverable via the handlers marker).
    writeFileSync(
      join(dir, "task.codex.hooks.ts"),
      '#!/usr/bin/env bun\nimport { LIMIT } from "./policy";\n' +
        "type HookHandler = (p: unknown) => unknown;\n" +
        "const handlers: Record<string, HookHandler> = {\n" +
        "  stop: async () => { void LIMIT; },\n};\n",
      { mode: 0o755 }
    );

    const before = await buildVerificationEnvironmentFingerprint(flow, suite);
    writeFileSync(helper, "export const LIMIT = 999;\n");
    const after = await buildVerificationEnvironmentFingerprint(flow, suite);

    expect(after.flowHash).not.toBe(before.flowHash);
  });

  it("flowHash is stable when nothing changes", async () => {
    const { flow, suite } = writeFlowAndSuite();
    writeFileSync(join(dir, "task.codex.hooks.ts"), renderHooksTemplate(["stop"]), { mode: 0o755 });
    const a = await buildVerificationEnvironmentFingerprint(flow, suite);
    const b = await buildVerificationEnvironmentFingerprint(flow, suite);
    expect(a.flowHash).toBe(b.flowHash);
  });
});

describe("hook bytes in the explain/render configFingerprint", () => {
  it("configFingerprint changes when the flow's hook file changes", async () => {
    const { buildExplainJson } = await import("./explain");
    const flow = join(dir, "review.codex.md");
    writeFileSync(flow, "---\ndescription: t\n---\nSay ok.\n");
    const hooksFile = join(dir, "review.codex.hooks.ts");
    writeFileSync(hooksFile, renderHooksTemplate(["stop"]), { mode: 0o755 });

    const before = await buildExplainJson(flow, [], dir);
    writeFileSync(hooksFile, renderHooksTemplate(["stop", "sessionStart"]), { mode: 0o755 });
    const after = await buildExplainJson(flow, [], dir);

    expect(before.configFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(after.configFingerprint).not.toBe(before.configFingerprint);
  });

  // A binding is only trustworthy in both directions: bytes changed must move
  // the fingerprint (above), and bytes unchanged must NOT — otherwise every
  // receipt is stale on arrival and the invalidation signal means nothing.
  it("configFingerprint is stable while the flow and its hooks are unchanged", async () => {
    const { buildExplainJson } = await import("./explain");
    const flow = join(dir, "review.codex.md");
    writeFileSync(flow, "---\ndescription: t\n---\nSay ok.\n");
    writeFileSync(join(dir, "review.codex.hooks.ts"), renderHooksTemplate(["stop"]), {
      mode: 0o755,
    });

    const a = await buildExplainJson(flow, [], dir);
    const b = await buildExplainJson(flow, [], dir);

    expect(a.configFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.configFingerprint).toBe(b.configFingerprint);
  });
});
