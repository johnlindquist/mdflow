import React, { useState } from 'react';
import { Hero } from './components/Hero';
import { SplitSection } from './components/SplitSection';
import { Editor } from './components/Editor';
import { Terminal } from './components/Terminal';
import { ManPage } from './components/ManPage';
import { AgentPrompts } from './components/AgentPrompts';
import { FlowsRoster } from './components/FlowsRoster';
import { Evolve } from './components/Evolve';
import { ShaderGuide } from './components/ShaderGuide';
import { ShaderHints } from './components/ShaderHints';
import { CraftedBy } from './components/CraftedBy';
import { EasterEggs } from './components/EasterEggs';
import { shaderAudio } from './components/shaderAudio';
import { Terminal as TerminalIcon, Zap, Volume2, VolumeX } from 'lucide-react';

/** The X (formerly Twitter) brand mark — lucide has no X logo. */
const XLogo: React.FC<{ size?: number }> = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644Z" />
    </svg>
);

/** The classic GitHub octocat mark (lucide's Github icon is deprecated). */
const GithubMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
);

// Demo Data for Split Sections - v3 features first, then composition
const DEMOS = [
    {
        title: "The Engine Ladder",
        subtitle: "v3 · No Filename Ceremony",
        description: "The engine is environment, not filename ceremony. Bare review.md runs on your default engine (pi, bridging your Codex login automatically). Pin one per file, per shell, or per project. The ladder resolves it and tells you which rung won.",
        left: (
            <Editor
                filename="review.md"
                content={`---\ndescription: review staged changes\n---\n\nReview this diff for bugs.\nBe terse, cite file:line.\n\n!\`git diff --cached\``}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md review.md' },
                    { id: '2', type: 'info', content: 'review.md → pi (engine: default)' },
                    { id: '3', type: 'output', content: 'src/auth.ts:42 token never expires...' },
                    { id: '4', type: 'input', content: 'MDFLOW_ENGINE=claude md review.md' },
                    { id: '5', type: 'info', content: 'review.md → claude (engine: env)' },
                    { id: '6', type: 'output', content: 'Same flow, different brain.' }
                ]}
            />
        )
    },
    {
        title: "Evals: Prove It",
        subtitle: "v3 · Trust Ledger",
        description: "If a guardrail isn't covered by an eval, it's a wish. Colocate review.eval.ts with your flow. Each case runs in a hermetic sandbox. The cost is printed before a single turn is spent. Clean runs are stamped in the trust ledger.",
        left: (
            <Editor
                filename="review.eval.ts"
                content={`const cases = [{\n  name: "flags the planted bug",\n  setup: (dir) => plantBug(dir),\n  check: ({ stdout }) =>\n    /auth\\.ts:\\d+/.test(stdout)\n      ? null\n      : "missed the planted bug",\n}];\n\nexport default cases;`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md eval review.md' },
                    { id: '2', type: 'info', content: 'review.md: 1 case × 1 flow run each = 1 engine turn' },
                    { id: '3', type: 'output', content: '  ✓ flags the planted bug' },
                    { id: '4', type: 'output', content: '1/1 passed' },
                    { id: '5', type: 'info', content: 'clean run recorded in trust ledger' }
                ]}
            />
        )
    },
    {
        title: "Parallel Analysis",
        subtitle: "Multi-Agent",
        description: "Spawn sub-agents to analyze different parts of your codebase in parallel. Each expert focuses on their domain. The parent synthesizes insights and prioritizes action.",
        left: (
            <Editor
                filename="audit.claude.md"
                content={`---\nmodel: sonnet\n---\n\nAnalyze codebase for improvements:\n\n## Security\n!\`md scan-security.agy.md\`\n\n## Performance\n!\`md scan-perf.codex.md\`\n\n## Complexity\n!\`md scan-complexity.copilot.md\`\n\nPrioritize top 5 changes by impact.`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md audit.claude.md' },
                    { id: '2', type: 'info', content: '→ Spawning: scan-security.agy.md' },
                    { id: '3', type: 'info', content: '→ Spawning: scan-perf.codex.md' },
                    { id: '4', type: 'info', content: '→ Spawning: scan-complexity.copilot.md' },
                    { id: '5', type: 'info', content: '→ 3 analyses complete, synthesizing...' },
                    { id: '6', type: 'output', content: 'Top 5 changes identified by impact...' }
                ]}
            />
        )
    },
    {
        title: "Agent Pipelines",
        subtitle: "Chain Agents",
        description: "Pipe agents together. Research flows into planning flows into implementation. Each agent's output becomes the next agent's input.",
        left: (
            <Editor
                filename="implement.codex.md"
                content={`---\nmodel: gpt-5.5-codex-max\nfull-auto: true\n---\n\nImplement this plan:\n{{ _stdin }}\n\nWrite clean, tested code.`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md research.agy.md \\' },
                    { id: '2', type: 'input', content: '  | md plan.claude.md \\' },
                    { id: '3', type: 'input', content: '  | md implement.codex.md' },
                    { id: '4', type: 'info', content: '→ research → plan → implement' },
                    { id: '5', type: 'output', content: 'Feature implemented with tests...' }
                ]}
            />
        )
    },
    {
        title: "Orchestrated Workflows",
        subtitle: "Sub-Agents",
        description: "Parent agents spawn children, wait for results, then continue. Build release pipelines, review workflows, or any multi-step process.",
        left: (
            <Editor
                filename="release.claude.md"
                content={`---\nmodel: sonnet\n---\n\nPrepare release {{ _version }}:\n\n## Tests\n!\`md run-tests.codex.md\`\n\n## Changelog\n!\`md changelog.agy.md\`\n\nGenerate release notes from above.`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md release.claude.md --_version "2.0.0"' },
                    { id: '2', type: 'info', content: '→ Spawning: run-tests.codex.md' },
                    { id: '3', type: 'info', content: '→ Spawning: changelog.agy.md' },
                    { id: '4', type: 'info', content: '→ Sub-agents complete, resuming...' },
                    { id: '5', type: 'output', content: 'Release notes for v2.0.0 ready' }
                ]}
            />
        )
    },
    {
        title: "File Imports",
        subtitle: "@ References",
        description: "Pull in files, globs, line ranges, or URLs. Import conventions, examples, or entire directories. The agent sees exactly what it needs.",
        left: (
            <Editor
                filename="review.claude.md"
                content={`---\nmodel: sonnet\n---\n\nReview this PR:\n\n@./src/api/**/*.ts\n@./src/types/index.ts:1-50\n\nFollow:\n@./CONVENTIONS.md\n@https://style.company.com/api`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md review.claude.md' },
                    { id: '2', type: 'info', content: '→ Glob: src/api/**/*.ts (12 files)' },
                    { id: '3', type: 'info', content: '→ Range: types/index.ts:1-50' },
                    { id: '4', type: 'info', content: '→ Import: CONVENTIONS.md' },
                    { id: '5', type: 'output', content: '3 issues found, 2 suggestions...' }
                ]}
            />
        )
    },
    {
        title: "Any AI, One Syntax",
        subtitle: "Multi-Provider",
        description: "Same template, any AI. Pin an engine in the filename (task.claude.md, task.agy.md), the frontmatter (engine: codex), or nowhere at all. The ladder resolves it. Portable keys like model translate per engine.",
        left: (
            <Editor
                filename="refactor.agy.md"
                content={`---\nmodel: gemini-3.1-pro\ndangerously-skip-permissions: true\n---\n\nRefactor to async/await:\n@./src/{{ _target }}.ts\n\n{% if _strict %}\nNo any types.\n{% endif %}`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md refactor.agy.md --_target "api"' },
                    { id: '2', type: 'info', content: 'refactor.agy.md → agy (engine: filename)' },
                    { id: '3', type: 'info', content: '→ Model: pro' },
                    { id: '4', type: 'output', content: 'Refactored api.ts to async/await' }
                ]}
            />
        )
    },
    {
        title: "Interactive Mode",
        subtitle: ".i. Sessions",
        description: "Add .i. to the filename for a live conversation. Debug issues, explore ideas, iterate on solutions, without re-running the agent.",
        left: (
            <Editor
                filename="debug.i.claude.md"
                content={`---\nmodel: sonnet\nadd-dir: ./src\n---\n\nHelp me debug: {{ _bug }}\n\n@./src/auth/**/*.ts`}
            />
        ),
        right: (
            <Terminal
                title="zsh"
                lines={[
                    { id: '1', type: 'input', content: 'md debug.i.claude.md --_bug "token expires"' },
                    { id: '2', type: 'info', content: '→ Mode: interactive (from .i.)' },
                    { id: '3', type: 'info', content: '→ Starting claude session...' },
                    { id: '4', type: 'output', content: "Let's trace the token flow..." }
                ]}
            />
        )
    }
];

export default function App() {
  const [muted, setMuted] = useState(true);
  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans selection:bg-orange-500/30">
      
      {/* Global Background Elements */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute inset-0 bg-grid opacity-20"></div>
        <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-blue-900/10 to-transparent"></div>
      </div>

      {/* Mouse-reactive shader that guides the eye to install + getting started */}
      <ShaderGuide />
      <ShaderHints
        muted={muted}
        onUnmute={() => { shaderAudio.setMuted(false); setMuted(false); }}
      />

      {/* 22 hidden easter eggs + the five-star secret puzzle */}
      <EasterEggs />

      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-[#050505]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <div data-egg="logo" className="flex items-center gap-2 text-white font-display font-bold tracking-tighter text-2xl group cursor-pointer">
                <div className="relative">
                    <div className="absolute inset-0 bg-orange-500 blur-lg opacity-40 group-hover:opacity-60 transition-opacity"></div>
                    <TerminalIcon size={24} className="relative z-10 text-white" />
                </div>
                <span className="bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400 group-hover:to-white transition-all">mdflow</span>
            </div>
            <div className="flex items-center gap-6 text-sm font-medium text-zinc-400">
                <a href="https://github.com/johnlindquist/mdflow" target="_blank" rel="noreferrer" className="hover:text-white transition-colors flex items-center gap-2 hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]">
                    <GithubMark size={18} />
                    <span className="hidden sm:inline">GitHub</span>
                </a>
                <a href="https://x.com/johnlindquist" target="_blank" rel="noreferrer" aria-label="X (formerly Twitter)" className="hover:text-white transition-colors hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]">
                    <XLogo size={16} />
                </a>
                <button
                    data-egg="volume"
                    onClick={() => setMuted(shaderAudio.toggle())}
                    aria-label={muted ? 'Unmute reactive soundtrack' : 'Mute reactive soundtrack'}
                    title={muted ? 'Sound: off — click for a reactive soundtrack' : 'Sound: on'}
                    className={`transition-colors hover:drop-shadow-[0_0_8px_rgba(249,115,22,0.6)] ${muted ? 'text-zinc-500 hover:text-white' : 'text-orange-400 hover:text-orange-300'}`}
                >
                    {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                </button>
            </div>
        </div>
      </nav>

      <main className="relative z-10">
        <Hero />

        {/* Maker credit + Software Factory workshop (full shader treatment) */}
        <CraftedBy />

        {/* The concrete mental model: ./flows is your repo's agent roster */}
        <FlowsRoster />

        {/* The hero's promise, mechanized: evidence-gated auto-evolution */}
        <Evolve />

        {/* Agent-first: copy/paste prompts are the primary onboarding */}
        <AgentPrompts />

        {/* Synopsis (ManPage) */}
        <ManPage />

        <div id="features" className="relative">
            {/* Connecting line through sections */}
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-orange-500/30 to-transparent hidden lg:block"></div>

            {DEMOS.map((demo, index) => (
                <SplitSection
                    key={index}
                    index={index}
                    title={demo.title}
                    subtitle={demo.subtitle}
                    description={demo.description}
                    leftContent={demo.left}
                    rightContent={demo.right}
                    reversed={index % 2 !== 0}
                />
            ))}
        </div>
      </main>

      <footer className="py-16 border-t border-white/10 text-center relative overflow-hidden bg-zinc-950">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,rgba(249,115,22,0.1),transparent_50%)]"></div>
        <div className="relative z-10">
            <div className="flex justify-center mb-6">
                <span data-egg="zap" className="cursor-pointer">
                    <Zap className="text-orange-500 animate-pulse" />
                </span>
            </div>
            <p className="font-display text-zinc-400 text-sm tracking-wide">
                CRAFTED FOR THE <span className="text-zinc-200 font-bold">TERMINAL NATIVE</span>
            </p>
            <p className="mt-4 text-xs text-zinc-600 font-mono">
                MIT License &copy; {new Date().getFullYear()} mdflow.dev
            </p>
        </div>
      </footer>
    </div>
  );
}