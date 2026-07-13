import React, { useState } from 'react';
import { Copy, Check, Zap, ChevronRight } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { Editor } from './Editor';
import { Terminal } from './Terminal';
import { TerminalLine } from '../types';
import facts from '../src/facts.json';

const HERO_FLOW = `---
description: review staged changes for bugs
---

Review this diff for bugs.
Be terse, cite file:line.

!\`git diff --cached\``;

const HERO_LINES: TerminalLine[] = [
    {
        id: 'run',
        type: 'input',
        content: 'md review',
        ariaLabel: 'Command: ',
    },
    {
        id: 'engine',
        type: 'info',
        content: 'review.md → pi (engine: config)',
        ariaLabel: 'Resolved engine: ',
    },
    {
        id: 'example-label',
        type: 'label',
        content: 'EXAMPLE AGENT OUTPUT',
        ariaLabel: 'Example agent output label: ',
    },
    {
        id: 'result',
        type: 'output',
        content: 'src/auth.ts:42 — logout leaves the refresh token valid.',
        ariaLabel: 'Example agent output: ',
    },
];

const FLOW_CALLOUTS = [
    ['description', 'The roster label.'],
    ['Markdown body', 'The prompt sent to the engine.'],
    ['!`git diff --cached`', 'Command output inserted before the engine starts.'],
] as const;

export const Hero: React.FC = () => {
    const [copied, setCopied] = useState(false);
    const reducedMotion = useReducedMotion();

    const copyInstall = (event: React.MouseEvent<HTMLButtonElement>) => {
        navigator.clipboard.writeText(facts.install);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        const rect = event.currentTarget.getBoundingClientRect();
        window.dispatchEvent(new CustomEvent('mdflow:copied', {
            detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        }));
    };

    const reveal = reducedMotion ? false : { opacity: 0, y: 24 };

    return (
        <section className="relative min-h-screen overflow-hidden px-4 pb-20 pt-24 sm:px-6 sm:pt-28 lg:flex lg:items-center lg:pb-24 lg:pt-32">
            <div aria-hidden="true" className="hero-ambient absolute left-[-15%] top-[-25%] h-[600px] w-[600px] rounded-full bg-orange-600/20 blur-[150px] mix-blend-screen animate-pulse-slow" />
            <div aria-hidden="true" className="hero-ambient absolute bottom-[-20%] right-[-15%] h-[800px] w-[800px] rounded-full bg-blue-600/20 blur-[150px] mix-blend-screen animate-pulse-slow" />

            <div className="relative z-10 mx-auto grid w-full max-w-7xl grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-10 xl:gap-16">
                <div className="flex flex-col justify-center lg:col-span-6">
                    <motion.div
                        initial={reveal}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: reducedMotion ? 0 : 0.65, ease: 'easeOut' }}
                    >
                        <div className="mb-5 flex flex-wrap items-center gap-3 sm:mb-7">
                            <button
                                type="button"
                                data-egg="version"
                                aria-label={`mdflow version ${facts.versionBase}, live`}
                                className="inline-flex items-center rounded-full border border-orange-500/50 bg-orange-950/30 px-3 py-1.5 font-mono text-xs text-orange-200 shadow-[0_0_15px_rgba(249,115,22,0.3)] backdrop-blur-md sm:px-4"
                            >
                                <Zap size={12} className="mr-2 fill-orange-400 text-orange-400" aria-hidden="true" />
                                <span className="font-bold tracking-wider">{`V${facts.versionBase} LIVE`}</span>
                            </button>
                            <a
                                href="https://github.com/johnlindquist/mdflow"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center rounded-full border border-pink-500/50 bg-pink-950/30 px-3 py-1.5 font-mono text-xs text-pink-200 shadow-[0_0_15px_rgba(236,72,153,0.3)] backdrop-blur-md transition-colors hover:bg-pink-900/40 sm:px-4"
                            >
                                <span className="font-bold tracking-wider">OPEN SOURCE</span>
                            </a>
                        </div>

                        <p className="mb-4 font-mono text-xs font-bold uppercase tracking-[0.24em] text-orange-300">
                            One Markdown file → one repeatable command
                        </p>
                        <h1
                            data-egg="headline"
                            data-shader-headline
                            data-marketing-invariant="evolve-first"
                            className="select-none font-display text-[clamp(2.5rem,11vw,5rem)] font-bold leading-[0.92] tracking-tighter text-white text-glow lg:text-7xl xl:text-8xl"
                        >
                            <span className="bg-gradient-to-r from-orange-400 via-amber-200 to-white bg-clip-text text-transparent">
                                MARKDOWN AGENTS
                            </span>
                            <br />
                            THAT{' '}
                            <span className="evolve-live" data-shader-evolve>EVOLVE.</span>
                        </h1>

                        <p className="mt-6 max-w-2xl border-l-4 border-orange-500/50 pl-5 text-base font-light leading-relaxed text-zinc-300 sm:text-lg lg:text-xl">
                            Each file in <span className="font-mono text-white">./flows</span> defines one repeatable AI job.
                            Frontmatter configures the run. The Markdown body becomes the prompt.{' '}
                            <span className="font-mono font-semibold text-white">md review</span> runs it with the agent CLI you already use.
                        </p>
                        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-zinc-400 sm:text-base">
                            Feedback becomes a capability-checked, eval-gated proposal. The source changes only after you review and explicitly apply it.
                        </p>
                    </motion.div>

                    <motion.div
                        initial={reducedMotion ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: reducedMotion ? 0 : 0.3, duration: reducedMotion ? 0 : 0.5 }}
                        className="pt-7"
                    >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                            <button
                                onClick={copyInstall}
                                data-marketing-cta="install"
                                data-shader-target="install"
                                data-shader-priority="1"
                                className="group inline-flex min-h-12 items-center justify-center gap-2.5 rounded-lg bg-white px-5 font-mono font-semibold text-black shadow-[0_0_20px_rgba(255,255,255,0.25)] transition-all hover:scale-[1.02] hover:shadow-[0_0_30px_rgba(255,255,255,0.45)] active:scale-95 motion-reduce:transform-none"
                            >
                                <span className="text-orange-600">$</span>
                                <span className="tracking-tight">{facts.install}</span>
                                <span className="ml-1 border-l border-zinc-300 pl-3 text-zinc-400 transition-colors group-hover:text-black">
                                    {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                                </span>
                            </button>

                            <a href="#how-it-runs" className="group inline-flex min-h-12 items-center justify-center gap-1.5 rounded-lg border border-white/15 px-5 font-medium text-zinc-300 transition-colors hover:border-white/30 hover:text-white">
                                See one flow run
                                <ChevronRight size={16} className="transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden="true" />
                            </a>
                        </div>

                        <p className="mt-4 max-w-xl text-sm leading-relaxed text-zinc-400">
                            <span className="font-mono text-zinc-200">npx mdflow init</span> creates a starter{' '}
                            <span className="font-mono text-zinc-200">./flows</span> roster without calling an engine.
                            Then run <span className="font-mono text-zinc-200">md</span> to open the Workbench.
                        </p>
                    </motion.div>
                </div>

                <motion.div
                    id="how-it-runs"
                    initial={reducedMotion ? false : { opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: reducedMotion ? 0 : 0.2, duration: reducedMotion ? 0 : 0.65, ease: 'easeOut' }}
                    className="hero-demo-float min-w-0 lg:col-span-6"
                >
                    <div className="rounded-2xl border border-white/10 bg-black/30 p-3 shadow-[0_30px_90px_rgba(0,0,0,0.55)] backdrop-blur-sm sm:p-4">
                        <figure className="h-[260px] sm:h-[280px]">
                            <figcaption className="sr-only">Complete review flow stored in flows/review.md</figcaption>
                            <Editor filename="flows/review.md" content={HERO_FLOW} />
                        </figure>

                        <div className="my-3 flex items-center gap-3 px-1" aria-hidden="true">
                            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-orange-400/50" />
                            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-orange-300">one command</span>
                            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-blue-400/50" />
                        </div>

                        <div className="h-[220px] sm:h-[230px]">
                            <Terminal
                                title="mdflow-cli"
                                lines={HERO_LINES}
                                illustrative
                                caption="One review flow run with its resolved engine and clearly labeled example agent output"
                            />
                        </div>

                        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
                            {FLOW_CALLOUTS.map(([term, description]) => (
                                <div key={term} className="rounded-lg border border-white/8 bg-white/[0.025] px-3 py-2.5">
                                    <dt className="font-mono text-xs text-orange-300">{term}</dt>
                                    <dd className="mt-1 text-xs leading-relaxed text-zinc-400">{description}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </motion.div>
            </div>
        </section>
    );
};
