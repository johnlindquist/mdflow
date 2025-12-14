/**
 * Interactive file selector with split-pane preview
 * Provides file preview, path display, and fuzzy filtering
 */

import {
  createPrompt,
  useState,
  useKeypress,
  isEnterKey,
  isUpKey,
  isDownKey,
  usePrefix,
  makeTheme,
  type KeypressEvent,
} from "@inquirer/core";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "os";
import { spawnSync } from "node:child_process";
import type { AgentFile } from "./cli";
import { LRUCache } from "./cache";

/** Result from file selector - either a path to run, edit, or dry-run */
export interface FileSelectorResult {
  action: "run" | "edit" | "dry-run";
  path: string;
}

/** Result from showFileSelectorWithPreview */
export interface FileSelectorSelection {
  path: string;
  dryRun: boolean;
}

// Extended key event type (runtime has more properties than type declares)
interface ExtendedKeyEvent extends KeypressEvent {
  sequence?: string;
  meta?: boolean;
  shift?: boolean;
}

// Proper LRU cache for file contents (refreshes recency on read)
const fileContentCache = new LRUCache<string, string>(100);

/**
 * Read file content with LRU caching (synchronous for use in render loop)
 * Uses proper LRU eviction - recently accessed items are kept, oldest evicted.
 */
function readFileContentSync(filePath: string): string {
  const cached = fileContentCache.get(filePath);
  if (cached !== undefined) {
    return cached;
  }
  try {
    if (!existsSync(filePath)) {
      return `[File not found: ${filePath}]`;
    }
    const content = readFileSync(filePath, "utf8");
    fileContentCache.set(filePath, content);
    return content;
  } catch (error) {
    return `[Error reading file: ${error}]`;
  }
}

/**
 * Get terminal width, defaulting to 80 if unavailable
 */
function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Get terminal height, defaulting to 24 if unavailable
 */
function getTerminalHeight(): number {
  return process.stdout.rows || 24;
}

/**
 * Replace home directory with ~ in path
 */
function shortenPath(filePath: string): string {
  const home = homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

/**
 * Strip ANSI codes for length calculation
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Truncate or pad a string to a specific width (ANSI-aware)
 */
function fitToWidth(str: string, width: number): string {
  const plainStr = stripAnsi(str);
  if (plainStr.length > width) {
    // Find where to cut in the original string
    let visibleLen = 0;
    let cutIndex = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "\x1b") {
        // Skip ANSI sequence
        const end = str.indexOf("m", i);
        if (end !== -1) {
          i = end;
          continue;
        }
      }
      visibleLen++;
      if (visibleLen >= width - 1) {
        cutIndex = i + 1;
        break;
      }
    }
    return str.slice(0, cutIndex) + "\x1b[0m";
  }
  return str + " ".repeat(Math.max(0, width - plainStr.length));
}

/**
 * Simple syntax highlighting for Markdown/YAML frontmatter
 */
function highlightSyntax(line: string): string {
  const trimmed = line.trim();
  // YAML frontmatter delimiter
  if (trimmed === "---") {
    return `\x1b[90m${line}\x1b[0m`;
  }
  // YAML Keys (e.g. "model: value")
  if (/^[\w_-]+:/.test(trimmed)) {
    return line.replace(/^([\w_-]+:)(.*)/, "\x1b[34m$1\x1b[0m$2");
  }
  // Markdown Headers (# Header)
  if (trimmed.startsWith("#")) {
    return `\x1b[1m\x1b[33m${line}\x1b[0m`;
  }
  // Comments
  if (trimmed.startsWith("//") || trimmed.startsWith("# ")) {
    return `\x1b[90m${line}\x1b[0m`;
  }
  return line;
}

/**
 * Format preview content with line numbers and syntax highlighting
 */
function formatPreviewContent(
  content: string,
  previewHeight: number,
  scrollOffset: number,
  previewWidth: number
): { lines: string[]; totalLines: number } {
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  // Clamp scroll offset
  const maxScroll = Math.max(0, totalLines - previewHeight);
  const startLine = Math.min(scrollOffset, maxScroll);
  const visibleLines = allLines.slice(startLine, startLine + previewHeight);

  const lineNumWidth = String(totalLines).length;
  const contentWidth = previewWidth - lineNumWidth - 3; // "123| " format

  const formattedLines = visibleLines.map((line, idx) => {
    const lineNum = startLine + idx + 1;
    const lineNumStr = String(lineNum).padStart(lineNumWidth, " ");
    // Apply syntax highlighting before truncation
    const highlighted = highlightSyntax(line);
    // Truncate if too long (fitToWidth handles ANSI codes)
    const displayLine =
      stripAnsi(highlighted).length > contentWidth
        ? fitToWidth(highlighted, contentWidth - 1) + "~"
        : highlighted;
    return `\x1b[90m${lineNumStr} │\x1b[0m ${displayLine}`;
  });

  // Pad with empty lines if content is shorter than preview height
  while (formattedLines.length < previewHeight) {
    formattedLines.push("");
  }

  return { lines: formattedLines, totalLines };
}

/**
 * Score a file against a filter.
 * Higher = better match. 0 = no match.
 * 100 = Exact name, 80 = Starts with, 60 = Contains name,
 * 50 = Description match, 40 = Path match, 20 = Fuzzy match
 *
 * Frecency is added as a small bonus (capped at 15) to boost frequently/recently
 * used files without overriding better string matches.
 */
function getMatchScore(filter: string, file: AgentFile): number {
  const frecencyBonus = Math.min(15, file.frecency ?? 0);

  // Empty query: return base score + frecency to maintain frecency sort
  if (!filter) return 1 + frecencyBonus;

  const search = filter.toLowerCase();
  const name = file.name.toLowerCase();
  const path = file.path.toLowerCase();
  const description = (file.description ?? "").toLowerCase();

  let score = 0;

  if (name === search) {
    score = 100;
  } else if (name.startsWith(search)) {
    score = 80;
  } else if (name.includes(search)) {
    score = 60;
  } else if (description.includes(search)) {
    // Semantic search: match against description
    score = 50;
  } else {
    // Multi-term search (e.g. "auth login") - check name, description, and path
    const terms = search.split(/\s+/);
    const searchText = `${name} ${description} ${path}`;
    if (terms.every((t) => searchText.includes(t))) {
      score = 40;
    } else {
      // Fuzzy match as fallback (all chars in order)
      let filterIdx = 0;
      for (let i = 0; i < name.length && filterIdx < search.length; i++) {
        if (name[i] === search[filterIdx]) {
          filterIdx++;
        }
      }
      if (filterIdx === search.length) {
        score = 20;
      }
    }
  }

  // Add frecency bonus if we have a match
  if (score > 0) {
    score += frecencyBonus;
  }

  return score;
}

/**
 * Highlight matching characters in text
 */
function highlightMatch(filter: string, text: string): string {
  if (!filter) return text;

  const lowerFilter = filter.toLowerCase();
  const lowerText = text.toLowerCase();

  let result = "";
  let filterIdx = 0;

  for (let i = 0; i < text.length; i++) {
    if (
      filterIdx < lowerFilter.length &&
      lowerText[i] === lowerFilter[filterIdx]
    ) {
      result += `\x1b[36m\x1b[1m${text[i]}\x1b[0m`; // Cyan bold for matches
      filterIdx++;
    } else {
      result += text[i];
    }
  }

  return result;
}

export interface FileSelectorConfig {
  message: string;
  files: AgentFile[];
  pageSize?: number;
}

/**
 * Interactive file selector with preview pane
 */
export const fileSelector = createPrompt<FileSelectorResult, FileSelectorConfig>(
  (config, done) => {
    const { files, pageSize = 15 } = config;
    const prefix = usePrefix({ status: "idle", theme: makeTheme({}) });

    const [cursor, setCursor] = useState(0);
    const [filter, setFilter] = useState("");
    const [previewScroll, setPreviewScroll] = useState(0);

    // Filter and sort files by match score (best matches first)
    const filteredFiles = filter
      ? files
          .map((f) => ({ file: f, score: getMatchScore(filter, f) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.file)
      : files;

    // Ensure cursor is within bounds
    const effectiveCursor = Math.min(cursor, Math.max(0, filteredFiles.length - 1));

    // Reset preview scroll when cursor changes
    const currentFile = filteredFiles[effectiveCursor];

    // Calculate layout dimensions early (needed for scroll step)
    const termWidth = getTerminalWidth();
    const termHeight = getTerminalHeight();
    const listWidth = Math.floor(termWidth * 0.35);
    const separatorWidth = 3;
    const previewWidth = termWidth - listWidth - separatorWidth - 2;
    const contentHeight = Math.min(pageSize, termHeight - 6);

    // Half-page scroll step for vim-style scrolling
    const scrollStep = Math.max(1, Math.floor(contentHeight / 2));

    useKeypress((key, rl) => {
      const extKey = key as ExtendedKeyEvent;

      // Ctrl+R for dry-run (review before running)
      if (key.ctrl && key.name === "r") {
        if (currentFile) {
          done({ action: "dry-run", path: currentFile.path });
        }
        return;
      }

      if (isEnterKey(key)) {
        if (currentFile) {
          done({ action: "run", path: currentFile.path });
        }
        return;
      }

      // Tab or Ctrl+E to edit the file in $EDITOR
      if (key.name === "tab" || (key.ctrl && key.name === "e")) {
        if (currentFile) {
          done({ action: "edit", path: currentFile.path });
        }
        return;
      }

      // Unified navigation: Arrows + Emacs (Ctrl+N/P) + Vim (Ctrl+J/K)
      const isNavUp =
        isUpKey(key) || (key.ctrl && (key.name === "p" || key.name === "k"));
      const isNavDown =
        isDownKey(key) || (key.ctrl && (key.name === "n" || key.name === "j"));

      if (isNavUp) {
        setCursor(Math.max(0, effectiveCursor - 1));
        setPreviewScroll(0);
        return;
      }

      if (isNavDown) {
        setCursor(Math.min(filteredFiles.length - 1, effectiveCursor + 1));
        setPreviewScroll(0);
        return;
      }

      // Vim-style half-page preview scrolling (Ctrl+U / Ctrl+D)
      if (key.name === "pageup" || (key.ctrl && key.name === "u")) {
        setPreviewScroll(Math.max(0, previewScroll - scrollStep));
        return;
      }

      if (key.name === "pagedown" || (key.ctrl && key.name === "d")) {
        setPreviewScroll(previewScroll + scrollStep);
        return;
      }

      // Backspace to delete filter character
      if (key.name === "backspace") {
        setFilter(filter.slice(0, -1));
        setCursor(0);
        setPreviewScroll(0);
        return;
      }

      // Escape to clear filter
      if (key.name === "escape") {
        if (filter) {
          setFilter("");
          setCursor(0);
          setPreviewScroll(0);
        }
        return;
      }

      // Add character to filter (printable characters only, including space for path search)
      if (extKey.sequence && extKey.sequence.length === 1 && !extKey.ctrl && !extKey.meta) {
        const char = extKey.sequence;
        if (char.match(/[\w\-\.\s]/)) {
          setFilter(filter + char);
          setCursor(0);
          setPreviewScroll(0);
        }
      }
    });

    // Build file list with pagination
    const startIdx = Math.max(
      0,
      Math.min(effectiveCursor - Math.floor(contentHeight / 2), filteredFiles.length - contentHeight)
    );
    const visibleFiles = filteredFiles.slice(startIdx, startIdx + contentHeight);

    const listLines: string[] = [];

    // Handle empty state
    if (filteredFiles.length === 0 && filter) {
      listLines.push("");
      listLines.push(`  \x1b[33mNo matches for "${filter}"\x1b[0m`);
      listLines.push(`  \x1b[90mTry fewer characters or path terms\x1b[0m`);
      while (listLines.length < contentHeight) {
        listLines.push("");
      }
    } else {
      // Inverse video helper: \x1b[7m = inverse, \x1b[27m = reset inverse
      const inverse = (str: string) => `\x1b[7m${str}\x1b[27m`;

      for (let i = 0; i < contentHeight; i++) {
        const file = visibleFiles[i];
        if (!file) {
          listLines.push("");
          continue;
        }

        const fileIdx = startIdx + i;
        const isSelected = fileIdx === effectiveCursor;
        const name = highlightMatch(filter, file.name);
        const source =
          file.source === "cwd" ? "" : ` (${file.source})`;

        // Build line content with description
        // Format: "filename.md - Description text" or just "filename.md" if no description
        const nameAndSource = `${stripAnsi(file.name)}${source}`;
        const descSeparator = " \u2022 "; // bullet point separator
        const maxDescLen = listWidth - nameAndSource.length - descSeparator.length - 2; // -2 for leading space and padding

        let lineContent: string;
        let lineWithColors: string;

        if (file.description && maxDescLen > 10) {
          // Truncate description if needed
          const desc = file.description.length > maxDescLen
            ? file.description.slice(0, maxDescLen - 1) + "\u2026" // ellipsis
            : file.description;
          lineContent = ` ${nameAndSource}${descSeparator}${desc}`;
          // For non-selected rows, add dim styling to description
          lineWithColors = ` ${name}\x1b[90m${source}${descSeparator}${desc}\x1b[0m`;
        } else {
          lineContent = ` ${nameAndSource}`;
          lineWithColors = ` ${name}\x1b[90m${source}\x1b[0m`;
        }

        const rawLen = lineContent.length;
        const padding = " ".repeat(Math.max(0, listWidth - rawLen));

        if (isSelected) {
          // Use inverse video for selected row (full-width highlight)
          listLines.push(inverse(`${lineContent}${padding}`));
        } else {
          listLines.push(lineWithColors);
        }
      }
    }

    // Build preview pane
    let previewLines: string[] = [];
    let previewHeader = "";
    let previewFooter = "";
    let totalLines = 0;

    if (currentFile) {
      const content = readFileContentSync(currentFile.path);
      const formatted = formatPreviewContent(
        content,
        contentHeight - 2, // Leave room for header and footer
        previewScroll,
        previewWidth
      );
      previewLines = formatted.lines;
      totalLines = formatted.totalLines;

      // Header: shortened path
      const shortPath = shortenPath(currentFile.path);
      previewHeader = `\x1b[1m\x1b[34m${shortPath}\x1b[0m`;

      // Footer: scroll position
      const scrollPct =
        totalLines <= contentHeight - 2
          ? 100
          : Math.round(
              ((previewScroll + contentHeight - 2) / totalLines) * 100
            );
      previewFooter = `\x1b[90m${Math.min(previewScroll + 1, totalLines)}-${Math.min(previewScroll + contentHeight - 2, totalLines)} of ${totalLines} lines (${Math.min(scrollPct, 100)}%)\x1b[0m`;
    }

    // Combine list and preview side by side
    const separator = " \x1b[90m│\x1b[0m ";
    const outputLines: string[] = [];

    // Header line
    const filterDisplay = filter
      ? `\x1b[90mFilter:\x1b[0m \x1b[36m${filter}\x1b[0m`
      : `\x1b[90mType to filter...\x1b[0m`;
    const matchCount = `\x1b[90m(${filteredFiles.length}/${files.length})\x1b[0m`;
    outputLines.push(`${prefix} ${config.message} ${matchCount}  ${filterDisplay}`);
    outputLines.push("");

    for (let i = 0; i < contentHeight; i++) {
      const listLine = fitToWidth(listLines[i] || "", listWidth);
      let previewLine = "";

      if (i === 0) {
        previewLine = previewHeader;
      } else if (i === contentHeight - 1) {
        previewLine = previewFooter;
      } else if (previewLines[i - 1]) {
        previewLine = previewLines[i - 1] ?? "";
      }

      previewLine = fitToWidth(previewLine, previewWidth);
      outputLines.push(`${listLine}${separator}${previewLine}`);
    }

    // Help line with styled keys (inverse video for keys)
    const k = (t: string) => `\x1b[7m ${t} \x1b[27m`;
    outputLines.push("");
    outputLines.push(
      `${k("↑↓")} Nav  ${k("Enter")} Run  ${k("^R")} Dry  ${k("Tab")} Edit  ${k("Esc")} Clear`
    );

    return outputLines.join("\n");
  }
);

/**
 * Open a file in the user's $EDITOR
 * Returns true if successful, false if editor not configured or failed
 */
export function openInEditor(filePath: string): boolean {
  const editor = process.env.EDITOR || process.env.VISUAL;

  if (!editor) {
    console.error(
      "\x1b[33mNo $EDITOR environment variable set.\x1b[0m\n" +
      "Set it in your shell config (e.g., ~/.bashrc or ~/.zshrc):\n" +
      "  export EDITOR=vim\n" +
      "  export EDITOR=nano\n" +
      "  export EDITOR=\"code --wait\"\n"
    );
    return false;
  }

  try {
    // Parse editor command (may include flags like "code --wait")
    const parts = editor.split(/\s+/);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), filePath];

    const result = spawnSync(cmd, args, {
      stdio: "inherit",
      shell: false,
    });

    if (result.error) {
      console.error(
        `\x1b[31mFailed to open editor "${editor}":\x1b[0m ${result.error.message}\n` +
        "Check that your $EDITOR is installed and in your PATH."
      );
      return false;
    }

    return result.status === 0;
  } catch (error) {
    console.error(
      `\x1b[31mFailed to open editor "${editor}":\x1b[0m ${error}\n` +
      "Check that your $EDITOR is installed and in your PATH."
    );
    return false;
  }
}

/**
 * Show interactive file picker with preview and return selected file path
 */
export async function showFileSelectorWithPreview(
  files: AgentFile[]
): Promise<FileSelectorSelection | undefined> {
  if (files.length === 0) {
    return undefined;
  }

  // Loop to allow editing and returning to selector
  while (true) {
    try {
      const result = await fileSelector({
        message: "Select an agent to run:",
        files,
        pageSize: 15,
      });

      if (result.action === "edit") {
        // Open in editor, then return to selector
        openInEditor(result.path);
        // Clear file content cache so preview reflects edits
        fileContentCache.clear();
        // Clear screen before re-showing selector to avoid duplication artifacts
        process.stdout.write("\x1b[2J\x1b[H");
        continue;
      }

      // action === "run" or "dry-run" - clear screen before returning
      process.stdout.write("\x1b[2J\x1b[H");
      return { path: result.path, dryRun: result.action === "dry-run" };
    } catch {
      // User cancelled (Ctrl+C) or other error
      return undefined;
    }
  }
}
