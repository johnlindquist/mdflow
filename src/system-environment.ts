/**
 * SystemEnvironment - Adapter pattern for abstracting system dependencies
 *
 * This interface allows the codebase to be tested without real file system,
 * network, or shell operations by providing injectable implementations.
 */

import { Glob } from "bun";

/**
 * Result from shell command execution
 */
export interface ShellResult {
  /** Exit code from the command */
  exitCode: number;
  /** Standard output content */
  stdout: string;
  /** Standard error content */
  stderr: string;
}

/**
 * Options for shell command execution
 */
export interface ShellOptions {
  /** Working directory for command execution */
  cwd?: string;
  /** Environment variables to pass to the command */
  env?: Record<string, string>;
  /** Stdin configuration: "inherit", "pipe", or content to pipe */
  stdin?: "inherit" | "pipe" | string;
  /** Stdout configuration: "inherit" or "pipe" */
  stdout?: "inherit" | "pipe";
  /** Stderr configuration: "inherit" or "pipe" */
  stderr?: "inherit" | "pipe";
}

/**
 * File system operations abstraction
 */
export interface FileSystem {
  /**
   * Read text content from a file
   * @param path - Absolute path to the file
   * @returns Promise resolving to file content as string
   * @throws Error if file does not exist or cannot be read
   */
  readText(path: string): Promise<string>;

  /**
   * Read raw bytes from a file (for binary detection)
   * @param path - Absolute path to the file
   * @param start - Start byte offset
   * @param end - End byte offset
   * @returns Promise resolving to Uint8Array of bytes
   */
  readBytes(path: string, start: number, end: number): Promise<Uint8Array>;

  /**
   * Check if a file or directory exists
   * @param path - Absolute path to check
   * @returns Promise resolving to true if exists, false otherwise
   */
  exists(path: string): Promise<boolean>;

  /**
   * Get file size in bytes
   * @param path - Absolute path to the file
   * @returns Promise resolving to file size
   * @throws Error if file does not exist
   */
  size(path: string): Promise<number>;

  /**
   * Iterate over files matching a glob pattern
   * @param pattern - Glob pattern to match
   * @param options - Options for the glob scan
   * @returns AsyncIterable of matching file paths
   */
  glob(
    pattern: string,
    options: { cwd: string; absolute: boolean; onlyFiles: boolean }
  ): AsyncIterable<string>;

  /**
   * Write text content to a file
   * @param path - Absolute path to the file
   * @param content - Content to write
   * @returns Promise resolving when write is complete
   */
  write(path: string, content: string): Promise<void>;

  /**
   * Delete a file
   * @param path - Absolute path to the file
   * @returns Promise resolving when delete is complete
   */
  unlink(path: string): Promise<void>;
}

/**
 * Shell/process execution abstraction
 */
export interface Shell {
  /**
   * Execute a command asynchronously with streaming support
   * @param cmd - Command to execute
   * @param args - Command arguments
   * @param options - Execution options
   * @returns Promise resolving to execution result
   */
  execute(
    cmd: string,
    args: string[],
    options?: ShellOptions
  ): Promise<ShellResult>;

  /**
   * Execute a command synchronously (blocking)
   * @param cmd - Command to execute
   * @param args - Command arguments
   * @param options - Execution options
   * @returns Execution result
   */
  executeSync(
    cmd: string,
    args: string[],
    options?: ShellOptions
  ): ShellResult;

  /**
   * Check if a command exists in PATH
   * @param cmd - Command name to check
   * @returns Path to command if found, null otherwise
   */
  which(cmd: string): string | null;

  /**
   * Spawn a process with full control (for streaming/interactive use)
   * Returns a handle to manage the process lifecycle
   */
  spawn(
    cmd: string,
    args: string[],
    options?: ShellOptions
  ): SpawnedProcess;
}

/**
 * Handle for a spawned process
 */
export interface SpawnedProcess {
  /** Promise that resolves to exit code when process completes */
  exited: Promise<number>;
  /** Stdout stream (if piped) */
  stdout: ReadableStream<Uint8Array> | null;
  /** Stderr stream (if piped) */
  stderr: ReadableStream<Uint8Array> | null;
  /** Kill the process */
  kill(signal?: string): void;
  /** The underlying process (for compatibility) */
  _process?: unknown;
}

/**
 * Network operations abstraction
 */
export interface Network {
  /**
   * Fetch content from a URL
   * @param url - URL to fetch
   * @param options - Fetch options (headers, etc.)
   * @returns Promise resolving to Response object
   */
  fetch(url: string, options?: RequestInit): Promise<Response>;
}

/**
 * Complete system environment interface
 * Aggregates all system dependencies for easy injection
 */
export interface SystemEnvironment {
  /** File system operations */
  fs: FileSystem;
  /** Shell/process execution */
  shell: Shell;
  /** Network operations */
  network: Network;
}

/**
 * BunSystemEnvironment - Real implementation using Bun APIs
 *
 * This is the production implementation that wraps actual Bun/system calls.
 */
export class BunSystemEnvironment implements SystemEnvironment {
  fs: FileSystem = {
    async readText(path: string): Promise<string> {
      const file = Bun.file(path);
      return file.text();
    },

    async readBytes(path: string, start: number, end: number): Promise<Uint8Array> {
      const file = Bun.file(path);
      const buffer = await file.slice(start, end).arrayBuffer();
      return new Uint8Array(buffer);
    },

    async exists(path: string): Promise<boolean> {
      const file = Bun.file(path);
      return file.exists();
    },

    async size(path: string): Promise<number> {
      const file = Bun.file(path);
      return file.size;
    },

    async *glob(
      pattern: string,
      options: { cwd: string; absolute: boolean; onlyFiles: boolean }
    ): AsyncIterable<string> {
      const glob = new Glob(pattern);
      for await (const file of glob.scan(options)) {
        yield file;
      }
    },

    async write(path: string, content: string): Promise<void> {
      await Bun.write(path, content);
    },

    async unlink(path: string): Promise<void> {
      await Bun.file(path).nuke();
    },
  };

  shell: Shell = {
    async execute(
      cmd: string,
      args: string[],
      options: ShellOptions = {}
    ): Promise<ShellResult> {
      const proc = Bun.spawn([cmd, ...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        stdin: options.stdin === "inherit" ? "inherit" : "pipe",
        stdout: options.stdout === "inherit" ? "inherit" : "pipe",
        stderr: options.stderr === "inherit" ? "inherit" : "pipe",
      });

      const [stdout, stderr] = await Promise.all([
        proc.stdout ? new Response(proc.stdout).text() : "",
        proc.stderr ? new Response(proc.stderr).text() : "",
      ]);

      const exitCode = await proc.exited;

      return { exitCode, stdout, stderr };
    },

    executeSync(
      cmd: string,
      args: string[],
      options: ShellOptions = {}
    ): ShellResult {
      const result = Bun.spawnSync([cmd, ...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdin: options.stdin === "inherit" ? "inherit" : "pipe",
        stdout: options.stdout === "inherit" ? "inherit" : "pipe",
        stderr: options.stderr === "inherit" ? "inherit" : "pipe",
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
      };
    },

    which(cmd: string): string | null {
      return Bun.which(cmd);
    },

    spawn(
      cmd: string,
      args: string[],
      options: ShellOptions = {}
    ): SpawnedProcess {
      const proc = Bun.spawn([cmd, ...args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : undefined,
        stdin: options.stdin === "inherit" ? "inherit" : "pipe",
        stdout: options.stdout === "inherit" ? "inherit" : "pipe",
        stderr: options.stderr === "inherit" ? "inherit" : "pipe",
      });

      return {
        exited: proc.exited,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal?: string) => proc.kill(signal as NodeJS.Signals),
        _process: proc,
      };
    },
  };

  network: Network = {
    async fetch(url: string, options?: RequestInit): Promise<Response> {
      return fetch(url, options);
    },
  };
}

/**
 * InMemoryFile - Represents a file in the virtual file system
 */
interface InMemoryFile {
  content: string;
  /** Binary content for binary file testing */
  binaryContent?: Uint8Array;
}

/**
 * MockShellCommand - Predefined response for a shell command
 */
export interface MockShellCommand {
  /** Exit code to return */
  exitCode: number;
  /** Stdout content */
  stdout: string;
  /** Stderr content */
  stderr: string;
}

/**
 * MockFetchResponse - Predefined response for a fetch request
 */
export interface MockFetchResponse {
  /** HTTP status code */
  status: number;
  /** Response body */
  body: string;
  /** Response headers */
  headers?: Record<string, string>;
}

/**
 * InMemorySystemEnvironment - Virtual implementation for testing
 *
 * Provides an in-memory file system, mock shell execution, and mock network
 * responses. This allows tests to run without touching the real file system
 * or making network requests.
 */
export class InMemorySystemEnvironment implements SystemEnvironment {
  /** Virtual file system storage */
  private files: Map<string, InMemoryFile> = new Map();

  /** Mock shell command responses */
  private shellCommands: Map<string, MockShellCommand> = new Map();

  /** Mock fetch responses */
  private fetchResponses: Map<string, MockFetchResponse> = new Map();

  /** Commands that were executed (for assertions) */
  public executedCommands: Array<{ cmd: string; args: string[]; options?: ShellOptions }> = [];

  /** URLs that were fetched (for assertions) */
  public fetchedUrls: Array<{ url: string; options?: RequestInit }> = [];

  /**
   * Add a file to the virtual file system
   */
  addFile(path: string, content: string): void {
    this.files.set(path, { content });
  }

  /**
   * Add a binary file to the virtual file system
   */
  addBinaryFile(path: string, content: Uint8Array): void {
    this.files.set(path, { content: "", binaryContent: content });
  }

  /**
   * Remove a file from the virtual file system
   */
  removeFile(path: string): void {
    this.files.delete(path);
  }

  /**
   * Get all files in the virtual file system
   */
  getFiles(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [path, file] of this.files) {
      result.set(path, file.content);
    }
    return result;
  }

  /**
   * Register a mock shell command response
   * @param pattern - Command pattern (command + args joined by space)
   */
  mockCommand(pattern: string, response: MockShellCommand): void {
    this.shellCommands.set(pattern, response);
  }

  /**
   * Register a mock fetch response
   */
  mockFetch(url: string, response: MockFetchResponse): void {
    this.fetchResponses.set(url, response);
  }

  /**
   * Clear all recorded commands and fetches (for test isolation)
   */
  clearRecords(): void {
    this.executedCommands = [];
    this.fetchedUrls = [];
  }

  fs: FileSystem = {
    readText: async (path: string): Promise<string> => {
      const file = this.files.get(path);
      if (!file) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return file.content;
    },

    readBytes: async (path: string, start: number, end: number): Promise<Uint8Array> => {
      const file = this.files.get(path);
      if (!file) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      if (file.binaryContent) {
        return file.binaryContent.slice(start, end);
      }
      // Convert string content to bytes
      const encoder = new TextEncoder();
      const bytes = encoder.encode(file.content);
      return bytes.slice(start, end);
    },

    exists: async (path: string): Promise<boolean> => {
      return this.files.has(path);
    },

    size: async (path: string): Promise<number> => {
      const file = this.files.get(path);
      if (!file) {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      }
      if (file.binaryContent) {
        return file.binaryContent.length;
      }
      return new TextEncoder().encode(file.content).length;
    },

    glob: async function* (
      pattern: string,
      options: { cwd: string; absolute: boolean; onlyFiles: boolean }
    ): AsyncIterable<string> {
      // Simple glob implementation for testing
      // Supports basic * and ** patterns
      const regex = globToRegex(pattern, options.cwd);

      for (const path of this.files.keys()) {
        if (regex.test(path)) {
          yield options.absolute ? path : path.replace(options.cwd + "/", "");
        }
      }
    }.bind(this),

    write: async (path: string, content: string): Promise<void> => {
      this.files.set(path, { content });
    },

    unlink: async (path: string): Promise<void> => {
      if (!this.files.has(path)) {
        throw new Error(`ENOENT: no such file or directory, unlink '${path}'`);
      }
      this.files.delete(path);
    },
  };

  shell: Shell = {
    execute: async (
      cmd: string,
      args: string[],
      options?: ShellOptions
    ): Promise<ShellResult> => {
      this.executedCommands.push({ cmd, args, options });

      // Look for mock command
      const pattern = [cmd, ...args].join(" ");
      const mock = this.shellCommands.get(pattern) || this.shellCommands.get(cmd);

      if (mock) {
        return mock;
      }

      // Default: command not found
      return {
        exitCode: 127,
        stdout: "",
        stderr: `command not found: ${cmd}`,
      };
    },

    executeSync: (
      cmd: string,
      args: string[],
      options?: ShellOptions
    ): ShellResult => {
      this.executedCommands.push({ cmd, args, options });

      const pattern = [cmd, ...args].join(" ");
      const mock = this.shellCommands.get(pattern) || this.shellCommands.get(cmd);

      if (mock) {
        return mock;
      }

      return {
        exitCode: 127,
        stdout: "",
        stderr: `command not found: ${cmd}`,
      };
    },

    which: (cmd: string): string | null => {
      // Check if we have a mock for this command
      for (const pattern of this.shellCommands.keys()) {
        if (pattern === cmd || pattern.startsWith(cmd + " ")) {
          return `/usr/bin/${cmd}`;
        }
      }
      return null;
    },

    spawn: (
      cmd: string,
      args: string[],
      options?: ShellOptions
    ): SpawnedProcess => {
      this.executedCommands.push({ cmd, args, options });

      const pattern = [cmd, ...args].join(" ");
      const mock = this.shellCommands.get(pattern) || this.shellCommands.get(cmd);

      const result = mock || {
        exitCode: 127,
        stdout: "",
        stderr: `command not found: ${cmd}`,
      };

      // Create readable streams from mock data
      const stdoutStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.stdout));
          controller.close();
        },
      });

      const stderrStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.stderr));
          controller.close();
        },
      });

      return {
        exited: Promise.resolve(result.exitCode),
        stdout: stdoutStream,
        stderr: stderrStream,
        kill: () => {},
      };
    },
  };

  network: Network = {
    fetch: async (url: string, options?: RequestInit): Promise<Response> => {
      this.fetchedUrls.push({ url, options });

      const mock = this.fetchResponses.get(url);

      if (mock) {
        return new Response(mock.body, {
          status: mock.status,
          headers: mock.headers,
        });
      }

      // Default: 404
      return new Response("Not Found", { status: 404 });
    },
  };
}

/**
 * Convert a glob pattern to a regular expression
 * Simple implementation for testing purposes
 */
function globToRegex(pattern: string, cwd: string): RegExp {
  // Normalize the pattern with cwd
  const fullPattern = pattern.startsWith("/") ? pattern : `${cwd}/${pattern}`;

  // Escape special regex chars except * and ?
  let regexStr = fullPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    // ** matches any path segment
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    // * matches anything except /
    .replace(/\*/g, "[^/]*")
    // ? matches single char except /
    .replace(/\?/g, "[^/]")
    // Restore globstar
    .replace(/<<<GLOBSTAR>>>/g, ".*");

  return new RegExp(`^${regexStr}$`);
}

/**
 * Default system environment instance (uses real Bun APIs)
 */
let defaultEnvironment: SystemEnvironment = new BunSystemEnvironment();

/**
 * Get the current system environment
 */
export function getSystemEnvironment(): SystemEnvironment {
  return defaultEnvironment;
}

/**
 * Set the system environment (for dependency injection in tests)
 */
export function setSystemEnvironment(env: SystemEnvironment): void {
  defaultEnvironment = env;
}

/**
 * Reset to the default Bun environment
 */
export function resetSystemEnvironment(): void {
  defaultEnvironment = new BunSystemEnvironment();
}

/**
 * Create a new InMemorySystemEnvironment for testing
 */
export function createTestEnvironment(): InMemorySystemEnvironment {
  return new InMemorySystemEnvironment();
}
