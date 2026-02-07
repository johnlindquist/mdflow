import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "./env";
import { getLogger } from "./logger";

test("test_loadEnvFiles_logs_warning_for_sensitive_env_keys", async () => {
  const envDir = await mkdtemp(join(tmpdir(), "env-warning-test-"));
  const originalApiKey = process.env.API_KEY;
  const originalAppMode = process.env.APP_MODE;
  const warnSpy = spyOn(getLogger(), "warn");

  await Bun.write(join(envDir, ".env"), "API_KEY=secret\nAPP_MODE=test\n");

  try {
    const count = await loadEnvFiles(envDir);
    expect(count).toBe(1);

    const sensitiveWarn = warnSpy.mock.calls.find((call) => {
      const payload = call[0] as { sensitiveKeys?: string[] } | undefined;
      return Array.isArray(payload?.sensitiveKeys) && payload.sensitiveKeys.includes("API_KEY");
    });

    expect(sensitiveWarn).toBeDefined();
  } finally {
    warnSpy.mockRestore();
    await rm(envDir, { recursive: true, force: true });

    if (originalApiKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = originalApiKey;
    }

    if (originalAppMode === undefined) {
      delete process.env.APP_MODE;
    } else {
      process.env.APP_MODE = originalAppMode;
    }
  }
});
