import yaml from "js-yaml";
import type { AgentFrontmatter, ParsedMarkdown } from "./types";
import { validateFrontmatter } from "./schema";

/**
 * Strip shebang line from content if present
 * Allows markdown files to be executable with #!/usr/bin/env md
 */
export function stripShebang(content: string): string {
  const lines = content.split("\n");
  if (lines[0]?.startsWith("#!")) {
    return lines.slice(1).join("\n");
  }
  return content;
}

/**
 * Raw parsed frontmatter result (before validation)
 */
export interface RawParsedMarkdown {
  frontmatter: unknown;
  body: string;
}

/**
 * Extract raw frontmatter without validation
 * Use this for --check mode to inspect invalid files without throwing
 */
export function parseRawFrontmatter(content: string): RawParsedMarkdown {
  const strippedContent = stripShebang(content);
  const lines = strippedContent.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: strippedContent };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Frontmatter fences are document delimiters only at column zero.
    // Indented `---` lines are valid content inside YAML block scalars.
    if (line.startsWith("---") && line.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterYaml = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n").trim();

  try {
    const parsed = yaml.load(frontmatterYaml);
    return { frontmatter: parsed ?? {}, body };
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      throw new Error(`YAML parse error: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Parse YAML frontmatter from markdown content
 * Automatically strips shebang line if present
 * Uses js-yaml for robust parsing and zod for validation
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
  const { frontmatter: raw, body } = parseRawFrontmatter(content);

  // Handle empty frontmatter
  if (raw === null || raw === undefined || (typeof raw === 'object' && Object.keys(raw as object).length === 0)) {
    return { frontmatter: {}, body };
  }

  // Validate against schema
  const frontmatter = validateFrontmatter(raw);

  return { frontmatter: frontmatter as AgentFrontmatter, body };
}

/**
 * Parse YAML content directly (for testing or programmatic use)
 */
export function parseYaml(content: string): unknown {
  return yaml.load(content);
}
