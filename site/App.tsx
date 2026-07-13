import React, { useState } from 'react';
import { Zap, Volume2, VolumeX } from 'lucide-react';
import { Hero } from './components/Hero';
import { SplitSection } from './components/SplitSection';
import { Editor } from './components/Editor';
import { Terminal } from './components/Terminal';
import { ManPage } from './components/ManPage';
import { AgentPrompts } from './components/AgentPrompts';
import { FlowsRoster } from './components/FlowsRoster';
import { FlowWorkbenchDemo } from './components/FlowWorkbenchDemo';
import { Evolve } from './components/Evolve';
import { ShaderGuide } from './components/ShaderGuide';
import { ShaderHints } from './components/ShaderHints';
import { CraftedBy } from './components/CraftedBy';
import { EasterEggs } from './components/EasterEggs';
import { AlienDefense } from './components/AlienDefense';
import { shaderAudio } from './components/shaderAudio';
import { FlowMark } from './components/FlowMark';
import facts from './src/facts.json';

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

// The learning path starts with one flow, then adds context, proof, composition, and interaction.
const DEMOS = [
    {
        title: 'Choose the Engine, Keep the Flow',
        subtitle: 'Engine Resolution · One Markdown Contract',
        description: 'The job stays in review.md while the engine can come from project config, the environment, the filename, or a flag. mdflow announces which rung won before the agent starts.',
        left: (
            <Editor
                filename="review.md"
                content={`---\ndescription: review staged changes\n---\n\nReview this diff for bugs.\nBe terse, cite file:line.\n\n!\`git diff --cached\``}
            />
        ),
        right: (
            <Terminal
                title="engine resolution"
                illustrative
                caption="Two commands run the same review flow with different resolved engines"
                lines={[
                    { id: '1', type: 'input', content: 'md review', ariaLabel: 'Command: ' },
                    { id: '2', type: 'info', content: `review.md → ${facts.defaultEngine} (engine: config)`, ariaLabel: 'Resolved engine: ' },
                    { id: '3', type: 'input', content: 'MDFLOW_ENGINE=claude md review', ariaLabel: 'Command: ' },
                    { id: '4', type: 'info', content: 'review.md → claude (engine: env)', ariaLabel: 'Resolved engine: ' },
                ]}
            />
        ),
    },
    {
        title: 'Bring Only the Context It Needs',
        subtitle: '@ References · Inspectable Inputs',
        description: 'Keep the prompt readable and reference the project context it needs. Imports can target files, globs, line ranges, symbols, command output, or supported URLs.',
        left: (
            <Editor
                filename="review.md"
                content={`---\ndescription: review the API boundary\n---\n\nReview these handlers for correctness:\n@./src/api/**/*.ts\n\nFollow the project rules in:\n@./CONVENTIONS.md`}
            />
        ),
        right: (
            <Terminal
                title="context preview"
                illustrative
                caption="Condensed example of previewing a flow's imported context without running an engine"
                lines={[
                    { id: '1', type: 'input', content: 'md explain review.md', ariaLabel: 'Command: ' },
                    { id: '2', type: 'label', content: 'CONDENSED FREE PREVIEW' },
                    { id: '3', type: 'info', content: 'glob · src/api/**/*.ts' },
                    { id: '4', type: 'info', content: 'file · CONVENTIONS.md' },
                    { id: '5', type: 'output', content: 'resolved prompt + config · no engine call' },
                ]}
            />
        ),
    },
    {
        title: 'Prove Declared Behavior',
        subtitle: 'Evals · Plan Before Spend',
        description: 'Colocate a behavioral suite with the flow. Preview cases and cost for free, then make the paid run explicit. Clean results bind to the exact flow and suite bytes.',
        left: (
            <Editor
                filename="answer.eval.ts"
                content={`import type { EvalCase } from "mdflow/src/evals";\n\nconst cases: EvalCase[] = [{\n  name: "returns one word",\n  check: ({ stdout }) =>\n    stdout.trim() === "GREEN"\n      ? null\n      : "expected exactly GREEN",\n}];\n\nexport default cases;`}
            />
        ),
        right: (
            <Terminal
                title="eval plan and run"
                illustrative
                caption="Condensed eval transcript showing a free plan before an explicit paid run"
                lines={[
                    { id: '1', type: 'input', content: 'md eval answer.md --plan', ariaLabel: 'Free command: ' },
                    { id: '2', type: 'label', content: 'CONDENSED FREE PLAN' },
                    { id: '3', type: 'output', content: '1 case · 1 planned invocation · no engine call' },
                    { id: '4', type: 'input', content: 'md eval answer.md --yes', ariaLabel: 'Paid command: ' },
                    { id: '5', type: 'output', content: '✓ returns one word' },
                    { id: '6', type: 'output', content: '1/1 passed' },
                ]}
            />
        ),
    },
    {
        title: 'Compose with Pipes',
        subtitle: 'stdout → _stdin · Unix-Shaped Agents',
        description: 'A flow can consume piped output through _stdin. Each file still owns one clear job, so the composed command stays inspectable and every stage can run alone.',
        left: (
            <Editor
                filename="plan.md"
                content={`---\ndescription: turn research into a plan\n---\n\nCreate a concrete implementation plan\nfrom this research:\n\n{{ _stdin }}`}
            />
        ),
        right: (
            <Terminal
                title="agent pipeline"
                illustrative
                caption="One shell pipeline where each flow's output becomes the next flow's stdin"
                lines={[
                    { id: '1', type: 'input', content: 'md research \\', ariaLabel: 'Command: ' },
                    { id: '2', type: 'continuation', content: '| md plan \\', ariaLabel: 'Command continuation: ' },
                    { id: '3', type: 'continuation', content: '| md summarize', ariaLabel: 'Command continuation: ' },
                    { id: '4', type: 'label', content: 'DATA FLOW' },
                    { id: '5', type: 'info', content: 'stdout → {{ _stdin }} → stdout → {{ _stdin }}' },
                ]}
            />
        ),
    },
    {
        title: 'Open a Live Session',
        subtitle: '.i. Filename Marker · Engine-Native TUI',
        description: 'Add .i. to the filename when the job needs a conversation instead of one printed result. mdflow resolves the flow, then hands control to the engine’s own interactive interface.',
        left: (
            <Editor
                filename="debug.i.claude.md"
                content={`---\ndescription: debug auth interactively\n---\n\nTrace the authentication flow with me.\n@./src/auth.ts`}
            />
        ),
        right: (
            <Terminal
                title="interactive handoff"
                illustrative
                caption="An interactive flow handing control to the configured engine interface"
                lines={[
                    { id: '1', type: 'input', content: 'md debug.i.claude.md', ariaLabel: 'Command: ' },
                    { id: '2', type: 'label', content: 'ILLUSTRATIVE HANDOFF' },
                    { id: '3', type: 'output', content: "the configured engine's interactive UI takes over" },
                ]}
            />
        ),
    },
];

export default function App() {
  const [muted, setMuted] = useState(true);
  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans selection:bg-orange-500/30">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div data-egg-grid className="absolute inset-0 bg-grid opacity-20"></div>
        <div className="absolute top-0 left-0 w-full h-[500px] bg-gradient-to-b from-blue-900/10 to-transparent"></div>
      </div>

      <ShaderGuide />
      <ShaderHints
        muted={muted}
        onUnmute={() => { shaderAudio.setMuted(false); setMuted(false); }}
      />
      <EasterEggs />
      <AlienDefense />

      <nav className="fixed top-0 w-full z-50 border-b border-white/5 bg-[#050505]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <button
                type="button"
                data-egg="logo"
                aria-label="mdflow brand mark"
                className="egg-focus flex items-center gap-2 rounded-md text-white font-display font-bold tracking-tighter text-2xl group cursor-pointer"
            >
                <span className="relative">
                    <span className="absolute inset-0 bg-orange-500 blur-lg opacity-40 group-hover:opacity-60 transition-opacity"></span>
                    <FlowMark size={24} className="relative z-10 text-white" />
                </span>
                <span data-egg-wordmark className="bg-clip-text text-transparent bg-gradient-to-r from-white via-orange-200 to-zinc-400 bg-[length:200%_100%] group-hover:to-white transition-all">mdflow</span>
            </button>
            <div className="flex items-center gap-6 text-sm font-medium text-zinc-400">
                <a href="https://github.com/johnlindquist/mdflow" target="_blank" rel="noreferrer" className="hover:text-white transition-colors flex items-center gap-2 hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]">
                    <GithubMark size={18} />
                    <span className="hidden sm:inline">GitHub</span>
                </a>
                <a href="https://x.com/johnlindquist" target="_blank" rel="noreferrer" aria-label="X (formerly Twitter)" className="hover:text-white transition-colors hover:drop-shadow-[0_0_8px_rgba(249,115,22,0.6)]">
                    <XLogo size={16} />
                </a>
                <button
                    type="button"
                    data-egg="volume"
                    onClick={() => setMuted(shaderAudio.toggle())}
                    aria-label={muted ? 'Unmute reactive soundtrack' : 'Mute reactive soundtrack'}
                    aria-pressed={!muted}
                    title={muted ? 'Sound: off — click for a reactive soundtrack' : 'Sound: on'}
                    className={`egg-focus rounded-md p-1 transition-colors hover:drop-shadow-[0_0_8px_rgba(249,115,22,0.6)] ${muted ? 'text-zinc-500 hover:text-white' : 'text-orange-400 hover:text-orange-300'}`}
                >
                    <span className="egg-volume-glyph" aria-hidden="true">
                        {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                    </span>
                </button>
            </div>
        </div>
      </nav>

      <main className="relative z-10">
        <Hero />
        <FlowsRoster />
        <FlowWorkbenchDemo />
        <Evolve />

        <div id="features" className="relative">
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-orange-500/30 to-transparent hidden lg:block"></div>
            {DEMOS.map((demo, index) => (
                <SplitSection
                    key={demo.title}
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

        <AgentPrompts />
        <ManPage />
        <CraftedBy />
      </main>

      <footer className="py-16 border-t border-white/10 text-center relative overflow-hidden bg-zinc-950">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_100%,rgba(249,115,22,0.1),transparent_50%)]"></div>
        <div className="relative z-10">
            <div className="flex justify-center mb-6">
                <button
                    type="button"
                    data-egg="zap"
                    aria-label="Charge the footer connector"
                    className="egg-focus rounded-md p-2 text-orange-500"
                >
                    <Zap aria-hidden="true" className="animate-pulse" />
                </button>
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
