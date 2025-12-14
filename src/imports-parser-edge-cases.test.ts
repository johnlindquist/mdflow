/**
 * Edge case tests for the import parser
 *
 * Tests for nested fences, weird backticks, indented fences, and other
 * markdown edge cases that could cause parsing issues.
 */

import { describe, it, expect } from 'bun:test';
import {
  parseImports,
  findSafeRanges,
  isGlobPattern,
  parseLineRange,
  parseSymbolExtraction,
} from './imports-parser';

describe('nested backtick edge cases', () => {
  it('handles nested single backticks correctly', () => {
    const cases = [
      '`@./path.md`',
      '``@./path.md``',
      '```\n@./path.md\n```',
      '`code with @./path.md inside`',
      'text `@./path.md` more text',
    ];

    for (const input of cases) {
      const result = parseImports(input);
      expect(result).toHaveLength(0);
    }
  });

  it('handles mismatched backticks gracefully', () => {
    const cases = [
      '`unclosed',
      '```unclosed',
      '` ` `',
      '`` ` ``',
      '``` ` ```',
      '`````',
    ];

    for (const input of cases) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('handles triple backticks with varying lengths', () => {
    const inputs = [
      '```\ncode\n```',
      '````\ncode\n````',
      '`````\ncode\n`````',
      '```\ncode\n````',
      '````\ncode\n```',
      '``` \ncode\n```',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });
});

describe('indented code fence handling', () => {
  it('handles 4-space indented code blocks (CommonMark spec)', () => {
    const input = '    @./file.md\n    more code';
    const result = parseImports(input);
    expect(result).toHaveLength(0);
  });

  it('handles mixed indentation levels', () => {
    const inputs = [
      '  @./file.md',
      '   @./file.md',
      '    @./file.md',
      '\t@./file.md',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('handles indented fences', () => {
    const inputs = [
      ' ```\n@./file.md\n ```',
      '  ```\n@./file.md\n  ```',
      '   ```\n@./file.md\n   ```',
      '    ```\n@./file.md\n    ```',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });
});

describe('special markdown edge cases', () => {
  it('handles HTML comments with imports', () => {
    const inputs = [
      '<!-- @./file.md -->',
      '<!-- !`command` -->',
      '<!--\n@./file.md\n-->',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('handles frontmatter-like content', () => {
    const inputs = [
      '---\ntitle: test\n---\n@./file.md',
      '---\n@./in-frontmatter.md\n---',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('handles blockquotes with imports', () => {
    const inputs = [
      '> @./file.md',
      '>> @./nested.md',
      '> Block quote\n> @./file.md',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('handles lists with imports', () => {
    const inputs = [
      '- @./file.md',
      '* @./file.md',
      '1. @./file.md',
      '   - Nested @./file.md',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe('command directive edge cases', () => {
  it('handles commands with backticks inside', () => {
    const inputs = [
      '!`echo hello`',
      "!``echo `nested` ``",
      "!```echo ``double nested`` ```",
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      const commands = result.filter(r => r.type === 'command');
      expect(commands.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('handles malformed command syntax gracefully', () => {
    const inputs = [
      '!`unclosed',
      '!``',
      '!```',
      '! `space before backtick`',
      '!`\nmultiline\n`',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      expect(Array.isArray(result)).toBe(true);
    }
  });
});

describe('file import edge cases', () => {
  it('handles line range edge cases', () => {
    const cases = [
      { input: './file.ts:1-1', expected: { start: 1, end: 1 } },
      { input: './file.ts:10-5', expected: { start: 10, end: 5 } },
      { input: './file.ts:999999-1000000', expected: { start: 999999, end: 1000000 } },
      { input: './file.ts:-1-10', expected: { start: undefined } },
      { input: './file.ts:abc-def', expected: { start: undefined } },
    ];

    for (const { input, expected } of cases) {
      const result = parseLineRange(input);
      if (expected.start !== undefined) {
        expect(result.start).toBe(expected.start);
        expect(result.end).toBe(expected.end);
      } else {
        expect(result.start).toBeUndefined();
      }
    }
  });

  it('handles symbol extraction edge cases', () => {
    const cases = [
      { input: './file.ts#', expected: false },
      { input: './file.ts##Symbol', expected: true }, // Extracts "Symbol" from the last #
      { input: './file.ts#123', expected: false }, // Symbols can't start with numbers
      { input: './file.ts#valid_symbol', expected: true },
      { input: './file.ts#$dollarSymbol', expected: true },
      { input: './file.ts#_underscore', expected: true },
      { input: './file.ts#CamelCase', expected: true },
    ];

    for (const { input, expected } of cases) {
      const result = parseSymbolExtraction(input);
      if (expected) {
        expect(result.symbol).toBeDefined();
      } else {
        expect(result.symbol).toBeUndefined();
      }
    }
  });
});

describe('glob pattern detection edge cases', () => {
  it('correctly identifies glob patterns', () => {
    const cases = [
      { input: './src/*.ts', expected: true },
      { input: './src/**/*.ts', expected: true },
      { input: './file?.ts', expected: true },
      { input: './[abc].ts', expected: true },
      { input: './file.ts', expected: false },
      { input: './src/file.ts', expected: false },
      { input: './**/deep/**/*.ts', expected: true },
      { input: './[!abc].ts', expected: true },
      { input: './file[0-9].ts', expected: true },
    ];

    for (const { input, expected } of cases) {
      expect(isGlobPattern(input)).toBe(expected);
    }
  });
});

describe('URL import edge cases', () => {
  it('handles various URL formats', () => {
    const validUrls = [
      '@https://example.com',
      '@http://localhost:3000',
      '@https://api.github.com/repos/user/repo',
      '@https://example.com/path?query=value&other=123',
      '@https://example.com/path#anchor',
      '@http://192.168.1.1:8080/api',
    ];

    for (const url of validUrls) {
      const result = parseImports(url);
      expect(result.length).toBe(1);
      expect(result[0]!.type).toBe('url');
    }
  });

  it('does NOT match email-like patterns as URLs', () => {
    const emails = [
      'user@example.com',
      'user.name@domain.org',
      'admin@localhost',
      'test@test.test.com',
    ];

    for (const email of emails) {
      const result = parseImports(email);
      expect(result).toHaveLength(0);
    }
  });
});

describe('executable code fence edge cases', () => {
  it('handles shebangs with various interpreters', () => {
    const shebangs = [
      '#!/bin/bash',
      '#!/usr/bin/env bun',
      '#!/usr/bin/env node',
      '#!/usr/bin/python3',
      '#!python',
      '#!/bin/sh -e',
    ];

    for (const shebang of shebangs) {
      const input = `\`\`\`sh\n${shebang}\necho hello\n\`\`\``;
      const result = parseImports(input);
      const execFences = result.filter(r => r.type === 'executable_code_fence');
      expect(execFences.length).toBe(1);
    }
  });

  it('does NOT match code fence without shebang as executable', () => {
    const inputs = [
      '```sh\necho hello\n```',
      '```ts\nconsole.log("hi")\n```',
      '```\nno language\n```',
    ];

    for (const input of inputs) {
      const result = parseImports(input);
      const execFences = result.filter(r => r.type === 'executable_code_fence');
      expect(execFences).toHaveLength(0);
    }
  });

  it('handles nested code fences in documentation', () => {
    const input = `
\`\`\`\`md
Here's an example:
\`\`\`sh
#!/bin/bash
echo hello
\`\`\`
\`\`\`\`
`;
    const result = parseImports(input);
    const execFences = result.filter(r => r.type === 'executable_code_fence');
    expect(execFences).toHaveLength(0);
  });
});

describe('stress tests', () => {
  it('handles deeply nested code fences', () => {
    let input = '@./level0.md\n';
    for (let i = 1; i <= 10; i++) {
      input += '`'.repeat(3 + i) + `\n@./level${i}.md\n` + '`'.repeat(3 + i) + '\n';
    }
    input += '@./levelEnd.md';

    const result = parseImports(input);
    const fileImports = result.filter(r => r.type === 'file');
    expect(fileImports.length).toBe(2);
  });

  it('handles many inline code spans', () => {
    const parts = [];
    for (let i = 0; i < 100; i++) {
      parts.push(`\`code${i}\``);
      parts.push(`@./file${i}.md`);
    }
    const input = parts.join(' ');

    const result = parseImports(input);
    expect(result.length).toBe(100);
  });

  it('handles alternating code and text', () => {
    let input = '';
    for (let i = 0; i < 50; i++) {
      input += `@./before${i}.md\n`;
      input += '```\n@./inside.md\n```\n';
      input += `@./after${i}.md\n`;
    }

    const result = parseImports(input);
    const fileImports = result.filter(r => r.type === 'file');
    expect(fileImports.length).toBe(100);
  });
});
