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
import { recordTouch, getFrecencyScore } from "./history";

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
 * Highlight search term in a line (case-insensitive)
 */
function highlightSearchTerm(line: string, searchTerm: string): string {
  if (!searchTerm) return line;

  const lowerLine = line.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  let result = "";
  let pos = 0;

  while (pos < line.length) {
    const matchPos = lowerLine.indexOf(lowerSearch, pos);
    if (matchPos === -1) {
      result += line.slice(pos);
      break;
    }
    // Add text before match
    result += line.slice(pos, matchPos);
    // Add highlighted match (yellow background)
    result += `\x1b[43m\x1b[30m${line.slice(matchPos, matchPos + searchTerm.length)}\x1b[0m`;
    pos = matchPos + searchTerm.length;
  }

  return result;
}

/**
 * Wrap a line to fit within maxWidth, preserving words when possible
 */
function wrapLine(line: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [line];

  const plainLine = stripAnsi(line);
  if (plainLine.length <= maxWidth) return [line];

  const wrapped: string[] = [];
  let remaining = line;
  let remainingPlain = plainLine;

  while (remainingPlain.length > maxWidth) {
    // Try to break at a word boundary (space) within maxWidth
    let breakPoint = maxWidth;
    const spaceIdx = remainingPlain.lastIndexOf(" ", maxWidth);
    if (spaceIdx > maxWidth * 0.4) {
      // Only use word break if it's not too far back
      breakPoint = spaceIdx;
    }

    // Find the actual position in the ANSI string
    let visibleCount = 0;
    let actualIdx = 0;
    for (let i = 0; i < remaining.length && visibleCount < breakPoint; i++) {
      if (remaining[i] === "\x1b") {
        // Skip ANSI sequence
        const end = remaining.indexOf("m", i);
        if (end !== -1) {
          i = end;
          continue;
        }
      }
      visibleCount++;
      actualIdx = i + 1;
    }

    wrapped.push(remaining.slice(0, actualIdx) + "\x1b[0m");
    remaining = remaining.slice(actualIdx);
    remainingPlain = stripAnsi(remaining);
  }

  if (remaining) {
    wrapped.push(remaining);
  }

  return wrapped;
}

/**
 * Format preview content with line numbers, syntax highlighting, and word wrap
 */
function formatPreviewContent(
  content: string,
  previewHeight: number,
  scrollOffset: number,
  previewWidth: number,
  searchTerm?: string
): { lines: string[]; totalLines: number; matchDisplayLines: number[] } {
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  const lineNumWidth = String(totalLines).length;
  const contentWidth = previewWidth - lineNumWidth - 3; // "123| " format
  const wrapIndent = " ".repeat(lineNumWidth) + " \x1b[90m┆\x1b[0m "; // Continuation marker

  // Build display lines with wrapping
  const displayLines: string[] = [];
  const matchDisplayLines: number[] = [];
  const lowerSearch = searchTerm?.toLowerCase();

  for (let lineIdx = 0; lineIdx < allLines.length; lineIdx++) {
    const line = allLines[lineIdx]!;
    const lineNum = lineIdx + 1;
    const lineNumStr = String(lineNum).padStart(lineNumWidth, " ");

    // Track display line of each match (before wrapping adds more lines)
    if (lowerSearch && line.toLowerCase().includes(lowerSearch)) {
      matchDisplayLines.push(displayLines.length);
    }

    // Apply syntax highlighting
    let highlighted = highlightSyntax(line);
    // Highlight search term if in content mode
    if (searchTerm) {
      highlighted = highlightSearchTerm(highlighted, searchTerm);
    }

    // Wrap the line
    const wrappedParts = wrapLine(highlighted, contentWidth);

    // First part gets line number
    displayLines.push(`\x1b[90m${lineNumStr} │\x1b[0m ${wrappedParts[0] || ""}`);

    // Continuation lines get indent marker
    for (let i = 1; i < wrappedParts.length; i++) {
      displayLines.push(`${wrapIndent}${wrappedParts[i]}`);
    }
  }

  // Apply scroll offset to display lines
  const maxScroll = Math.max(0, displayLines.length - previewHeight);
  const startLine = Math.min(scrollOffset, maxScroll);
  const visibleLines = displayLines.slice(startLine, startLine + previewHeight);

  // Pad with empty lines if content is shorter than preview height
  while (visibleLines.length < previewHeight) {
    visibleLines.push("");
  }

  return { lines: visibleLines, totalLines: displayLines.length, matchDisplayLines };
}

// Cache for lowercase file content (avoid repeated toLowerCase calls)
const lowerContentCache = new LRUCache<string, string>(100);

function getLowerContent(filePath: string): string {
  const cached = lowerContentCache.get(filePath);
  if (cached !== undefined) return cached;

  const content = readFileContentSync(filePath).toLowerCase();
  lowerContentCache.set(filePath, content);
  return content;
}

/**
 * Score a file against a content search filter.
 * Returns score based on number of matches found in file content.
 */
function getContentMatchScore(filter: string, file: AgentFile): number {
  if (!filter) return 1;

  const content = getLowerContent(file.path);
  const search = filter.toLowerCase();

  // Count occurrences
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }

  if (count === 0) return 0;

  // Score: base 50 + 10 per match (capped at 100)
  return Math.min(100, 50 + count * 10);
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
    const [previewScroll, setPreviewScroll] = useState(0);
    // Combined search state for atomic updates (reduces re-renders)
    const [searchState, setSearchState] = useState<{ filter: string; mode: "name" | "content" }>({
      filter: "",
      mode: "name",
    });
    const { filter, mode: searchMode } = searchState;
    // Current match index for Tab/Shift+Tab cycling in content mode
    const [matchIndex, setMatchIndex] = useState(0);

    // Filter and sort files by match score (best matches first)
    const scoreFn = searchMode === "content" ? getContentMatchScore : getMatchScore;
    const filteredFiles = filter
      ? files
          .map((f) => ({ file: f, score: scoreFn(filter, f) }))
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

      // Tab: In content mode, cycle to next match. Otherwise, edit file.
      if (key.name === "tab") {
        if (searchMode === "content" && filter) {
          // Cycle to next match (will wrap in render based on match count)
          setMatchIndex(matchIndex + 1);
          setPreviewScroll(0); // Reset scroll so auto-scroll takes effect
        } else if (currentFile) {
          done({ action: "edit", path: currentFile.path });
        }
        return;
      }

      // Shift+Tab: In content mode, cycle to previous match
      if (extKey.shift && extKey.sequence === "\x1b[Z") {
        if (searchMode === "content" && filter) {
          setMatchIndex(matchIndex - 1);
          setPreviewScroll(0);
        }
        return;
      }

      // Ctrl+E to edit the file in $EDITOR (works in all modes)
      if (key.ctrl && key.name === "e") {
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
        setSearchState({ ...searchState, filter: filter.slice(0, -1) });
        setCursor(0);
        setPreviewScroll(0);
        setMatchIndex(0);
        return;
      }

      // Escape: clear filter and exit content mode (single atomic update)
      if (key.name === "escape") {
        if (searchMode === "content" || filter) {
          setSearchState({ filter: "", mode: "name" });
          setMatchIndex(0);
          if (filter) {
            setCursor(0);
            setPreviewScroll(0);
          }
        }
        return;
      }

      // "/" to toggle content search mode
      if (extKey.sequence === "/" && !filter) {
        setSearchState({ ...searchState, mode: searchMode === "content" ? "name" : "content" });
        setMatchIndex(0);
        return;
      }

      // Add character to filter (printable characters only, including space for path search)
      if (extKey.sequence && extKey.sequence.length === 1 && !extKey.ctrl && !extKey.meta) {
        const char = extKey.sequence;
        if (char.match(/[\w\-\.\s\/]/)) {
          setSearchState({ ...searchState, filter: filter + char });
          setCursor(0);
          setPreviewScroll(0);
          setMatchIndex(0); // Reset to first match on filter change
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
    let matchCount = 0;
    let currentMatchIdx = 0;

    if (currentFile) {
      const content = readFileContentSync(currentFile.path);
      const searchTerm = searchMode === "content" && filter ? filter : undefined;
      const previewContentHeight = contentHeight - 2; // Leave room for header and footer

      // Calculate effective scroll - auto-scroll to current match in content mode
      let effectiveScroll = previewScroll;
      if (searchTerm && previewScroll === 0) {
        // First pass: get all match positions
        const firstPass = formatPreviewContent(content, previewContentHeight, 0, previewWidth, searchTerm);
        matchCount = firstPass.matchDisplayLines.length;
        if (matchCount > 0) {
          // Wrap matchIndex to valid range
          currentMatchIdx = ((matchIndex % matchCount) + matchCount) % matchCount;
          const targetLine = firstPass.matchDisplayLines[currentMatchIdx]!;
          // Scroll to show match with some context above (3 lines)
          effectiveScroll = Math.max(0, targetLine - 3);
        }
      }

      const formatted = formatPreviewContent(
        content,
        previewContentHeight,
        effectiveScroll,
        previewWidth,
        searchTerm
      );
      previewLines = formatted.lines;
      totalLines = formatted.totalLines;
      // Update match count from final pass (in case first pass was skipped)
      if (searchTerm && matchCount === 0) {
        matchCount = formatted.matchDisplayLines.length;
      }

      // Header: shortened path + match indicator in content mode
      const shortPath = shortenPath(currentFile.path);
      const matchIndicator = searchTerm && matchCount > 0
        ? `  \x1b[33m[${currentMatchIdx + 1}/${matchCount}]\x1b[0m`
        : searchTerm && matchCount === 0
          ? `  \x1b[90m[no matches]\x1b[0m`
          : "";
      previewHeader = `\x1b[1m\x1b[34m${shortPath}\x1b[0m${matchIndicator}`;

      // Footer: scroll position
      const scrollPct =
        totalLines <= previewContentHeight
          ? 100
          : Math.round(
              ((effectiveScroll + previewContentHeight) / totalLines) * 100
            );
      previewFooter = `\x1b[90m${Math.min(effectiveScroll + 1, totalLines)}-${Math.min(effectiveScroll + previewContentHeight, totalLines)} of ${totalLines} lines (${Math.min(scrollPct, 100)}%)\x1b[0m`;
    }

    // Combine list and preview side by side
    const separator = " \x1b[90m│\x1b[0m ";
    const outputLines: string[] = [];

    // Header line
    const modeIndicator = searchMode === "content"
      ? `\x1b[33m[content]\x1b[0m `
      : "";
    const filterDisplay = filter
      ? `${modeIndicator}\x1b[90mFilter:\x1b[0m \x1b[36m${filter}\x1b[0m`
      : searchMode === "content"
        ? `${modeIndicator}\x1b[90mType to search file contents...\x1b[0m`
        : `\x1b[90mType to filter...\x1b[0m`;
    const fileCountDisplay = `\x1b[90m(${filteredFiles.length}/${files.length})\x1b[0m`;
    outputLines.push(`${prefix} ${config.message} ${fileCountDisplay}  ${filterDisplay}`);
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
    // Show different Tab hint in content mode (cycles matches vs edit)
    const tabHint = searchMode === "content" && filter
      ? `${k("Tab")} Next  ${k("S-Tab")} Prev`
      : `${k("Tab")} Edit`;
    outputLines.push(
      `${k("↑↓")} Nav  ${k("Enter")} Run  ${k("^R")} Dry  ${tabHint}  ${k("/")} Content  ${k("Esc")} Clear`
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
        // Record touch to boost frecency (await to update in-memory data)
        await recordTouch(result.path);
        // Open in editor, then return to selector
        openInEditor(result.path);
        // Clear file content cache so preview reflects edits
        fileContentCache.clear();
        // Re-calculate frecency scores and re-sort so edited file jumps to top
        for (const file of files) {
          file.frecency = getFrecencyScore(file.path);
        }
        files.sort((a, b) => {
          const frecencyDiff = (b.frecency ?? 0) - (a.frecency ?? 0);
          if (frecencyDiff !== 0) return frecencyDiff;
          return a.name.localeCompare(b.name);
        });
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
