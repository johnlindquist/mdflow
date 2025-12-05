import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  checkBinary,
  checkEnvVar,
  validatePrerequisites,
  formatPrerequisiteErrors,
} from "./prerequisites";

describe("checkBinary", () => {
  test("returns true for existing binary (ls)", async () => {
    const exists = await checkBinary("ls");
    expect(exists).toBe(true);
  });

  test("returns true for bun", async () => {
    const exists = await checkBinary("bun");
    expect(exists).toBe(true);
  });

  test("returns false for non-existent binary", async () => {
    const exists = await checkBinary("definitely-not-a-real-binary-12345");
    expect(exists).toBe(false);
  });
});

describe("checkEnvVar", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns true for set variable", () => {
    process.env.TEST_VAR = "value";
    expect(checkEnvVar("TEST_VAR")).toBe(true);
  });

  test("returns false for unset variable", () => {
    delete process.env.DEFINITELY_NOT_SET_12345;
    expect(checkEnvVar("DEFINITELY_NOT_SET_12345")).toBe(false);
  });

  test("returns false for empty string", () => {
    process.env.EMPTY_VAR = "";
    expect(checkEnvVar("EMPTY_VAR")).toBe(false);
  });

  test("returns true for PATH (should always exist)", () => {
    expect(checkEnvVar("PATH")).toBe(true);
  });
});

describe("validatePrerequisites", () => {
  test("passes with no requirements", async () => {
    const result = await validatePrerequisites({});
    expect(result.success).toBe(true);
    expect(result.missingBinaries).toEqual([]);
    expect(result.missingEnvVars).toEqual([]);
  });

  test("passes with existing binary", async () => {
    const result = await validatePrerequisites({ bin: ["ls"] });
    expect(result.success).toBe(true);
    expect(result.missingBinaries).toEqual([]);
  });

  test("fails with missing binary", async () => {
    const result = await validatePrerequisites({
      bin: ["fake-binary-xyz-12345"],
    });
    expect(result.success).toBe(false);
    expect(result.missingBinaries).toContain("fake-binary-xyz-12345");
  });

  test("passes with existing env var", async () => {
    const result = await validatePrerequisites({ env: ["PATH"] });
    expect(result.success).toBe(true);
    expect(result.missingEnvVars).toEqual([]);
  });

  test("fails with missing env var", async () => {
    const result = await validatePrerequisites({
      env: ["DEFINITELY_NOT_SET_XYZ_12345"],
    });
    expect(result.success).toBe(false);
    expect(result.missingEnvVars).toContain("DEFINITELY_NOT_SET_XYZ_12345");
  });

  test("reports multiple missing items", async () => {
    const result = await validatePrerequisites({
      bin: ["fake-bin-1", "fake-bin-2"],
      env: ["FAKE_VAR_1", "FAKE_VAR_2"],
    });
    expect(result.success).toBe(false);
    expect(result.missingBinaries).toHaveLength(2);
    expect(result.missingEnvVars).toHaveLength(2);
  });
});

describe("formatPrerequisiteErrors", () => {
  test("formats missing binaries", () => {
    const result = {
      success: false,
      missingBinaries: ["docker", "kubectl"],
      missingEnvVars: [],
    };
    const output = formatPrerequisiteErrors(result);
    expect(output).toContain("Missing required binaries");
    expect(output).toContain("docker");
    expect(output).toContain("kubectl");
  });

  test("formats missing env vars", () => {
    const result = {
      success: false,
      missingBinaries: [],
      missingEnvVars: ["API_KEY", "SECRET"],
    };
    const output = formatPrerequisiteErrors(result);
    expect(output).toContain("Missing required environment variables");
    expect(output).toContain("API_KEY");
    expect(output).toContain("SECRET");
  });

  test("formats both missing binaries and env vars", () => {
    const result = {
      success: false,
      missingBinaries: ["docker"],
      missingEnvVars: ["TOKEN"],
    };
    const output = formatPrerequisiteErrors(result);
    expect(output).toContain("Missing required binaries");
    expect(output).toContain("docker");
    expect(output).toContain("Missing required environment variables");
    expect(output).toContain("TOKEN");
  });
});
