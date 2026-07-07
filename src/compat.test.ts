import { describe, it, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyCompatStamp,
  compareVersions,
  compatNotice,
  isCompatOnlyFrontmatter,
  mdflowVersion,
  parseVersion,
  recordedVersion,
  stampCompatFile,
  stampCreatedVersion,
} from "./compat";

const v = (s: string) => parseVersion(s)!;

describe("parseVersion", () => {
  it("parses plain and prefixed versions", () => {
    expect(parseVersion("3.0.0")).toEqual({ major: 3, minor: 0, patch: 0, prerelease: [] });
    expect(parseVersion("v2.1.7")).toEqual({ major: 2, minor: 1, patch: 7, prerelease: [] });
  });

  it("parses prerelease identifiers", () => {
    expect(parseVersion("3.0.0-next.2")).toEqual({
      major: 3,
      minor: 0,
      patch: 0,
      prerelease: ["next", "2"],
    });
  });

  it("returns null for garbage", () => {
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion({})).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by major/minor/patch", () => {
    expect(compareVersions(v("3.0.0"), v("2.9.9"))).toBeGreaterThan(0);
    expect(compareVersions(v("3.0.0"), v("3.1.0"))).toBeLessThan(0);
    expect(compareVersions(v("3.0.1"), v("3.0.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("3.0.0"), v("3.0.0"))).toBe(0);
  });

  it("ranks releases above prereleases of the same core version", () => {
    expect(compareVersions(v("3.0.0"), v("3.0.0-next.2"))).toBeGreaterThan(0);
    expect(compareVersions(v("3.0.0-next.2"), v("3.0.0"))).toBeLessThan(0);
  });

  it("orders prerelease identifiers numerically then lexically", () => {
    expect(compareVersions(v("3.0.0-next.2"), v("3.0.0-next.10"))).toBeLessThan(0);
    expect(compareVersions(v("3.0.0-alpha"), v("3.0.0-beta"))).toBeLessThan(0);
    expect(compareVersions(v("3.0.0-next"), v("3.0.0-next.1"))).toBeLessThan(0);
  });
});

describe("recordedVersion", () => {
  it("prefers the newest of _compat and _mdflow_version", () => {
    expect(recordedVersion({ _mdflow_version: "3.0.0", _compat: "3.2.0" })).toEqual(v("3.2.0"));
    expect(recordedVersion({ _mdflow_version: "3.2.0", _compat: "3.0.0" })).toEqual(v("3.2.0"));
    expect(recordedVersion({ _mdflow_version: "3.0.0" })).toEqual(v("3.0.0"));
    expect(recordedVersion({})).toBeNull();
  });
});

describe("isCompatOnlyFrontmatter", () => {
  it("treats version-only frontmatter as empty", () => {
    expect(isCompatOnlyFrontmatter({})).toBe(true);
    expect(isCompatOnlyFrontmatter({ _compat: "3.0.0" })).toBe(true);
    expect(isCompatOnlyFrontmatter({ _mdflow_version: "3.0.0", _compat: "3.0.0" })).toBe(true);
    expect(isCompatOnlyFrontmatter({ model: "opus" })).toBe(false);
    expect(isCompatOnlyFrontmatter({ _compat: "3.0.0", description: "x" })).toBe(false);
  });
});

describe("compatNotice", () => {
  it("is silent when versions agree on major or no version is recorded", () => {
    expect(compatNotice({ _compat: "3.1.0" }, "3.0.0")).toBeNull();
    expect(compatNotice({}, "3.0.0")).toBeNull();
    expect(compatNotice({ _compat: "banana" }, "3.0.0")).toBeNull();
  });

  it("notices a flow verified with a newer major", () => {
    const notice = compatNotice({ _compat: "4.0.0" }, "3.0.0");
    expect(notice).toContain("expects mdflow v4");
    expect(notice).toContain("upgrading mdflow");
  });

  it("notices a flow last verified with an older major", () => {
    const notice = compatNotice({ _mdflow_version: "2.5.0" }, "3.0.0");
    expect(notice).toContain("last verified with mdflow 2.5.0");
    expect(notice).toContain("re-verify");
  });
});

describe("stampCreatedVersion", () => {
  it("inserts _mdflow_version into existing frontmatter", () => {
    const stamped = stampCreatedVersion("---\ndescription: Test\n---\n\nBody\n", "3.0.0");
    expect(stamped).toBe("---\ndescription: Test\n_mdflow_version: 3.0.0\n---\n\nBody\n");
  });

  it("creates a frontmatter block when none exists", () => {
    const stamped = stampCreatedVersion("Just a body\n", "3.0.0");
    expect(stamped).toBe("---\n_mdflow_version: 3.0.0\n---\n\nJust a body\n");
  });

  it("preserves a shebang line", () => {
    const stamped = stampCreatedVersion("#!/usr/bin/env md\n---\nmodel: opus\n---\n\nBody\n", "3.0.0");
    expect(stamped).toBe("#!/usr/bin/env md\n---\nmodel: opus\n_mdflow_version: 3.0.0\n---\n\nBody\n");
  });

  it("does not touch flows that already carry version info", () => {
    const withCreated = "---\n_mdflow_version: 2.0.0\n---\n\nBody\n";
    expect(stampCreatedVersion(withCreated, "3.0.0")).toBe(withCreated);
    const withCompat = "---\n_compat: 2.0.0\n---\n\nBody\n";
    expect(stampCreatedVersion(withCompat, "3.0.0")).toBe(withCompat);
  });
});

describe("applyCompatStamp", () => {
  it("adds _compat to an unversioned flow", () => {
    const next = applyCompatStamp("---\ndescription: Test\nmodel: opus\n---\n\nBody\n", "3.0.0");
    expect(next).toBe("---\ndescription: Test\nmodel: opus\n_compat: 3.0.0\n---\n\nBody\n");
  });

  it("upgrades an older _compat in place", () => {
    const next = applyCompatStamp("---\n_compat: 2.9.0\nmodel: opus\n---\n\nBody\n", "3.0.0");
    expect(next).toBe("---\n_compat: 3.0.0\nmodel: opus\n---\n\nBody\n");
  });

  it("is a no-op when already verified at this version or newer", () => {
    expect(applyCompatStamp("---\n_compat: 3.0.0\n---\n\nBody\n", "3.0.0")).toBeNull();
    expect(applyCompatStamp("---\n_compat: 4.0.0\n---\n\nBody\n", "3.0.0")).toBeNull();
    expect(applyCompatStamp("---\n_mdflow_version: 3.0.0\n---\n\nBody\n", "3.0.0")).toBeNull();
  });

  it("upgrades past the creation version after a clean run on newer mdflow", () => {
    const next = applyCompatStamp("---\n_mdflow_version: 3.0.0\n---\n\nBody\n", "3.1.0");
    expect(next).toBe("---\n_mdflow_version: 3.0.0\n_compat: 3.1.0\n---\n\nBody\n");
  });

  it("skips patch- and prerelease-level upgrades to avoid git churn", () => {
    expect(applyCompatStamp("---\n_compat: 3.0.0-next.2\n---\n\nBody\n", "3.0.0")).toBeNull();
    expect(applyCompatStamp("---\n_compat: 3.0.0\n---\n\nBody\n", "3.0.5")).toBeNull();
    expect(applyCompatStamp("---\n_mdflow_version: 3.1.0\n---\n\nBody\n", "3.1.9")).toBeNull();
  });

  it("stamps minor and major upgrades", () => {
    expect(applyCompatStamp("---\n_compat: 3.0.9\n---\n\nBody\n", "3.1.0")).toBe(
      "---\n_compat: 3.1.0\n---\n\nBody\n"
    );
    expect(applyCompatStamp("---\n_compat: 2.9.0\n---\n\nBody\n", "3.0.0")).toBe(
      "---\n_compat: 3.0.0\n---\n\nBody\n"
    );
  });

  it("creates a frontmatter block for bare files", () => {
    expect(applyCompatStamp("Body only\n", "3.0.0")).toBe("---\n_compat: 3.0.0\n---\n\nBody only\n");
  });

  it("preserves the body byte for byte", () => {
    const body = "\nLine with trailing spaces   \n\n\tindented\n_compat: not-yaml-here\n";
    const next = applyCompatStamp(`---\nmodel: opus\n---${body}`, "3.0.0");
    expect(next).toBe(`---\nmodel: opus\n_compat: 3.0.0\n---${body}`);
  });

  it("leaves unterminated frontmatter alone", () => {
    expect(applyCompatStamp("---\nmodel: opus\nBody\n", "3.0.0")).toBeNull();
  });

  it("replaces an unparseable _compat value instead of appending", () => {
    const next = applyCompatStamp("---\n_compat: banana\n---\n\nBody\n", "3.0.0");
    expect(next).toBe("---\n_compat: 3.0.0\n---\n\nBody\n");
  });
});

describe("stampCompatFile", () => {
  it("writes the stamp and reports true, then no-ops on the second pass", () => {
    const dir = mkdtempSync(join(tmpdir(), "mdflow-compat-"));
    const flowPath = join(dir, "task.claude.md");
    writeFileSync(flowPath, "---\nmodel: opus\n---\n\nBody\n");

    expect(stampCompatFile(flowPath, "3.0.0")).toBe(true);
    expect(readFileSync(flowPath, "utf-8")).toBe("---\nmodel: opus\n_compat: 3.0.0\n---\n\nBody\n");
    expect(stampCompatFile(flowPath, "3.0.0")).toBe(false);
  });

  it("returns false for a missing file", () => {
    expect(stampCompatFile("/nonexistent/nope.md", "3.0.0")).toBe(false);
  });
});

describe("mdflowVersion", () => {
  it("reads a parseable version from package.json", () => {
    expect(parseVersion(mdflowVersion())).not.toBeNull();
  });
});
