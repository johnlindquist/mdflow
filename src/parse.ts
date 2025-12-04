import type { CopilotFrontmatter, ParsedMarkdown } from "./types";

/**
 * Parse YAML frontmatter from markdown content
 */
export function parseFrontmatter(content: string): ParsedMarkdown {
  const lines = content.split("\n");

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join("\n").trim();
  const frontmatter = parseYamlSimple(frontmatterLines);

  return { frontmatter, body };
}

/**
 * Simple YAML parser for frontmatter (handles our specific schema)
 */
function parseYamlSimple(lines: string[]): CopilotFrontmatter {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let arrayValues: string[] = [];

  for (const line of lines) {
    // Array item (indented with -)
    if (/^\s+-\s+/.test(line) && currentKey) {
      const value = line.replace(/^\s+-\s+/, "").trim();
      arrayValues.push(value);
      continue;
    }

    // If we were collecting array values, save them
    if (currentKey && arrayValues.length > 0) {
      result[currentKey] = arrayValues;
      arrayValues = [];
      currentKey = null;
    }

    // Key: value pair
    const match = line.match(/^(\S+):\s*(.*)$/);
    if (match) {
      const [, key, value] = match;
      if (!key) continue;

      const trimmedValue = value?.trim() ?? "";

      // Inline array: [item1, item2]
      if (trimmedValue.startsWith("[") && trimmedValue.endsWith("]")) {
        const items = trimmedValue
          .slice(1, -1)
          .split(",")
          .map(s => s.trim().replace(/^["']|["']$/g, ""));
        result[key] = items;
        continue;
      }

      // Boolean values
      if (trimmedValue === "true") {
        result[key] = true;
        continue;
      }
      if (trimmedValue === "false") {
        result[key] = false;
        continue;
      }

      // Empty value means array follows
      if (trimmedValue === "") {
        currentKey = key;
        arrayValues = [];
        continue;
      }

      // String value
      result[key] = trimmedValue;
    }
  }

  // Save any remaining array values
  if (currentKey && arrayValues.length > 0) {
    result[currentKey] = arrayValues;
  }

  return result as CopilotFrontmatter;
}
