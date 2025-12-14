import { describe, test, expect } from "bun:test";
import {
  isSensitiveKey,
  maskValue,
  redactValue,
  redactArgs,
  maskArgs,
  maskArgsArray,
  redactArgsArray,
} from "./secrets";

describe("isSensitiveKey", () => {
  test("detects 'key' in key names (case-insensitive)", () => {
    expect(isSensitiveKey("api_key")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("key")).toBe(true);
    expect(isSensitiveKey("KEY")).toBe(true);
    expect(isSensitiveKey("openai-key")).toBe(true);
  });

  test("detects 'token' in key names (case-insensitive)", () => {
    expect(isSensitiveKey("access_token")).toBe(true);
    expect(isSensitiveKey("ACCESS_TOKEN")).toBe(true);
    expect(isSensitiveKey("accessToken")).toBe(true);
    expect(isSensitiveKey("token")).toBe(true);
    expect(isSensitiveKey("github-token")).toBe(true);
  });

  test("detects 'secret' in key names (case-insensitive)", () => {
    expect(isSensitiveKey("client_secret")).toBe(true);
    expect(isSensitiveKey("CLIENT_SECRET")).toBe(true);
    expect(isSensitiveKey("secret")).toBe(true);
    expect(isSensitiveKey("secretValue")).toBe(true);
  });

  test("detects 'password' in key names (case-insensitive)", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("PASSWORD")).toBe(true);
    expect(isSensitiveKey("db_password")).toBe(true);
    expect(isSensitiveKey("userPassword")).toBe(true);
  });

  test("detects 'credential' in key names (case-insensitive)", () => {
    expect(isSensitiveKey("credential")).toBe(true);
    expect(isSensitiveKey("CREDENTIAL")).toBe(true);
    expect(isSensitiveKey("credentials")).toBe(true);
    expect(isSensitiveKey("user_credentials")).toBe(true);
  });

  test("detects 'auth' in key names (case-insensitive)", () => {
    expect(isSensitiveKey("auth")).toBe(true);
    expect(isSensitiveKey("AUTH")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("auth_header")).toBe(true);
    expect(isSensitiveKey("authToken")).toBe(true);
  });

  test("returns false for non-sensitive keys", () => {
    expect(isSensitiveKey("model")).toBe(false);
    expect(isSensitiveKey("name")).toBe(false);
    expect(isSensitiveKey("verbose")).toBe(false);
    expect(isSensitiveKey("debug")).toBe(false);
    expect(isSensitiveKey("config")).toBe(false);
    expect(isSensitiveKey("output")).toBe(false);
    expect(isSensitiveKey("host")).toBe(false);
    expect(isSensitiveKey("port")).toBe(false);
  });

  test("detects key in compound words", () => {
    // Words containing 'key' even unintentionally
    expect(isSensitiveKey("monkey")).toBe(true);
    expect(isSensitiveKey("keyboard")).toBe(true);
  });

  test("handles edge cases", () => {
    expect(isSensitiveKey("")).toBe(false);
    expect(isSensitiveKey(null as unknown as string)).toBe(false);
    expect(isSensitiveKey(undefined as unknown as string)).toBe(false);
  });
});

describe("maskValue", () => {
  test("preserves common API key prefixes", () => {
    expect(maskValue("sk-abc123def456")).toBe("sk-****");
    expect(maskValue("pk-xyz789")).toBe("pk-****");
    expect(maskValue("ghp_xxxxxxxxxxxx")).toBe("ghp_****");
    expect(maskValue("ghr_xxxxxxxxxxxx")).toBe("ghr_****");
    expect(maskValue("npm_xxxxxxxxxxxx")).toBe("npm_****");
    expect(maskValue("xox-xxxxxxxxxxxx")).toBe("xox-****");
  });

  test("returns ***** for values without recognizable prefixes", () => {
    expect(maskValue("mysecretvalue")).toBe("*****");
    expect(maskValue("1234567890")).toBe("*****");
    expect(maskValue("short")).toBe("*****");
  });

  test("handles edge cases", () => {
    expect(maskValue("")).toBe("*****");
    expect(maskValue(null as unknown as string)).toBe("*****");
    expect(maskValue(undefined as unknown as string)).toBe("*****");
  });
});

describe("redactValue", () => {
  test("always returns [REDACTED]", () => {
    expect(redactValue("sk-abc123")).toBe("[REDACTED]");
    expect(redactValue("any-value")).toBe("[REDACTED]");
    expect(redactValue(12345)).toBe("[REDACTED]");
    expect(redactValue({ nested: "object" })).toBe("[REDACTED]");
  });
});

describe("redactArgs", () => {
  test("redacts sensitive values in object", () => {
    const result = redactArgs({
      model: "opus",
      api_key: "sk-secret123",
      token: "my-token",
    });

    expect(result.model).toBe("opus");
    expect(result.api_key).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
  });

  test("preserves non-sensitive values", () => {
    const result = redactArgs({
      model: "sonnet",
      verbose: true,
      count: 5,
    });

    expect(result.model).toBe("sonnet");
    expect(result.verbose).toBe(true);
    expect(result.count).toBe(5);
  });

  test("handles nested objects", () => {
    const result = redactArgs({
      config: {
        api_key: "secret",
        model: "opus",
      },
      name: "test",
    });

    expect((result.config as Record<string, unknown>).api_key).toBe("[REDACTED]");
    expect((result.config as Record<string, unknown>).model).toBe("opus");
    expect(result.name).toBe("test");
  });

  test("handles edge cases", () => {
    expect(redactArgs(null as unknown as Record<string, unknown>)).toBeNull();
    expect(redactArgs(undefined as unknown as Record<string, unknown>)).toBeUndefined();
    expect(redactArgs({})).toEqual({});
  });
});

describe("maskArgs", () => {
  test("masks sensitive values with prefix preservation", () => {
    const result = maskArgs({
      model: "opus",
      api_key: "sk-secret123",
      token: "ghp_mytoken",
    });

    expect(result.model).toBe("opus");
    expect(result.api_key).toBe("sk-****");
    expect(result.token).toBe("ghp_****");
  });

  test("handles non-string sensitive values", () => {
    const result = maskArgs({
      api_key: 12345,
      password: true,
    });

    // Non-strings are preserved as-is (edge case)
    expect(result.api_key).toBe(12345);
    expect(result.password).toBe(true);
  });

  test("handles nested objects", () => {
    const result = maskArgs({
      auth: {
        token: "sk-nested",
        user: "john",
      },
    });

    expect((result.auth as Record<string, unknown>).token).toBe("sk-****");
    expect((result.auth as Record<string, unknown>).user).toBe("john");
  });
});

describe("maskArgsArray", () => {
  test("masks values after sensitive flags", () => {
    const result = maskArgsArray([
      "--model",
      "opus",
      "--api-key",
      "sk-secret123",
      "--verbose",
    ]);

    expect(result).toEqual([
      "--model",
      "opus",
      "--api-key",
      "sk-****",
      "--verbose",
    ]);
  });

  test("handles multiple sensitive flags", () => {
    const result = maskArgsArray([
      "--api-key",
      "sk-key1",
      "--token",
      "ghp_token1",
      "--password",
      "mysecret",
    ]);

    expect(result).toEqual([
      "--api-key",
      "sk-****",
      "--token",
      "ghp_****",
      "--password",
      "*****",
    ]);
  });

  test("handles short flags", () => {
    const result = maskArgsArray(["-m", "opus", "-k", "sk-secret"]);

    // -k doesn't contain 'key', so it won't be masked
    expect(result).toEqual(["-m", "opus", "-k", "sk-secret"]);
  });

  test("handles flags with sensitive substrings", () => {
    const result = maskArgsArray([
      "--auth-token",
      "bearer-xyz",
      "--credential-file",
      "/path/to/creds",
    ]);

    expect(result).toEqual([
      "--auth-token",
      "*****",
      "--credential-file",
      "*****",
    ]);
  });

  test("handles empty array", () => {
    expect(maskArgsArray([])).toEqual([]);
  });

  test("handles array with no flags", () => {
    const result = maskArgsArray(["value1", "value2"]);
    expect(result).toEqual(["value1", "value2"]);
  });
});

describe("redactArgsArray", () => {
  test("redacts values after sensitive flags", () => {
    const result = redactArgsArray([
      "--model",
      "opus",
      "--api-key",
      "sk-secret123",
      "--verbose",
    ]);

    expect(result).toEqual([
      "--model",
      "opus",
      "--api-key",
      "[REDACTED]",
      "--verbose",
    ]);
  });

  test("handles multiple sensitive flags", () => {
    const result = redactArgsArray([
      "--api-key",
      "sk-key1",
      "--token",
      "ghp_token1",
    ]);

    expect(result).toEqual([
      "--api-key",
      "[REDACTED]",
      "--token",
      "[REDACTED]",
    ]);
  });

  test("handles edge cases", () => {
    expect(redactArgsArray([])).toEqual([]);
    expect(
      redactArgsArray(null as unknown as string[])
    ).toBeNull();
  });
});

describe("integration scenarios", () => {
  test("typical API key scenario", () => {
    const args = {
      model: "gpt-4",
      api_key: "sk-abcdefghijklmnop",
      max_tokens: 1000,
    };

    const masked = maskArgs(args);
    const redacted = redactArgs(args);

    expect(masked.api_key).toBe("sk-****");
    expect(redacted.api_key).toBe("[REDACTED]");
    expect(masked.model).toBe("gpt-4");
    expect(redacted.model).toBe("gpt-4");
  });

  test("CLI args with secrets", () => {
    const cliArgs = [
      "claude",
      "--model",
      "opus",
      "--api-key",
      "sk-test123",
      "--print",
      "Hello world",
    ];

    const masked = maskArgsArray(cliArgs);

    expect(masked).toContain("--api-key");
    expect(masked).toContain("sk-****");
    expect(masked).not.toContain("sk-test123");
  });

  test("environment-like config", () => {
    const config = {
      OPENAI_API_KEY: "sk-openai123",
      ANTHROPIC_TOKEN: "sk-ant-123",
      DATABASE_PASSWORD: "dbpass123",
      NODE_ENV: "production",
      DEBUG: "true",
    };

    const redacted = redactArgs(config);

    expect(redacted.OPENAI_API_KEY).toBe("[REDACTED]");
    expect(redacted.ANTHROPIC_TOKEN).toBe("[REDACTED]");
    expect(redacted.DATABASE_PASSWORD).toBe("[REDACTED]");
    expect(redacted.NODE_ENV).toBe("production");
    expect(redacted.DEBUG).toBe("true");
  });
});
