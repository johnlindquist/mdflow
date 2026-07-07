import React, { useEffect, useState } from 'react';
import { TerminalLine } from '../types';
import { Terminal } from './Terminal';
import { Editor } from './Editor';
import { ArrowDown, Copy, Check, Zap, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';

const HERO_MD = `---
description: research a feature
---

Research {{ _feature }} thoroughly.

Consider:
- Prior art and alternatives
- Implementation patterns
- Edge cases and pitfalls

Output a structured summary.`;

const HERO_OUTPUT: TerminalLine[] = [
    { id: '1', type: 'input', content: 'md research.md --_feature "auth" | md plan.md | md code.codex.md' },
    { id: '2', type: 'info', content: 'research.md → pi (engine: default)' },
    { id: '3', type: 'info', content: '→ researching auth patterns...' },
    { id: '4', type: 'info', content: '→ codex: writing code...' },
    { id: '5', type: 'output', content: 'JWT refresh with rotation implemented ✓' },
];

export const Hero: React.FC = () => {
    const [lines, setLines] = useState<TerminalLine[]>([]);
    const [copied, setCopied] = useState(false);
    const [editorInFront, setEditorInFront] = useState(false);

    useEffect(() => {
        let currentIndex = 0;
        const interval = setInterval(() => {
            if (currentIndex < HERO_OUTPUT.length) {
                setLines(prev => [...prev, HERO_OUTPUT[currentIndex]]);
                currentIndex++;
            } else {
                clearInterval(interval);
            }
        }, 800);
        return () => clearInterval(interval);
    }, []);

    const copyInstall = (e: React.MouseEvent<HTMLButtonElement>) => {
        navigator.clipboard.writeText('npx mdflow init');
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        const r = e.currentTarget.getBoundingClientRect();
        window.dispatchEvent(new CustomEvent('mdflow:copied', {
            detail: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        }));
    };

    return (
        <div className="relative min-h-screen flex flex-col pt-32 lg:pt-40 pb-24 px-6 overflow-hidden">
            {/* Dynamic Background */}
            <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-orange-600/20 blur-[150px] rounded-full pointer-events-none mix-blend-screen animate-pulse-slow" />
            <div className="absolute bottom-[-10%] right-[-10%] w-[800px] h-[800px] bg-blue-600/20 blur-[150px] rounded-full pointer-events-none mix-blend-screen animate-pulse-slow" />

            <div className="max-w-7xl mx-auto w-full z-10 grid grid-cols-1 lg:grid-cols-12 gap-16 items-center">

                {/* Text Content */}
                <div className="lg:col-span-6 flex flex-col justify-center space-y-8">
                    <motion.div
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                        className="select-none"
                    >
                        <div className="flex items-center gap-3 mb-8">
                            <div data-egg="v3" className="inline-flex items-center px-4 py-1.5 rounded-full border border-orange-500/50 bg-orange-950/30 text-xs font-mono text-orange-200 backdrop-blur-md shadow-[0_0_15px_rgba(249,115,22,0.3)] cursor-pointer">
                                <Zap size={12} className="mr-2 text-orange-400 fill-orange-400" />
                                <span className="font-bold tracking-wider">V3.0.0 LIVE</span>
                            </div>
                            <a
                                href="https://github.com/johnlindquist/mdflow"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center px-4 py-1.5 rounded-full border border-pink-500/50 bg-pink-950/30 text-xs font-mono text-pink-200 backdrop-blur-md shadow-[0_0_15px_rgba(236,72,153,0.3)] hover:bg-pink-900/40 transition-colors"
                            >
                                <span className="font-bold tracking-wider">OPEN SOURCE ❤️</span>
                            </a>
                        </div>

                        {/* Scaled down text for mobile */}
                        <h1 data-shader-headline className="select-none text-5xl lg:text-8xl font-display font-bold tracking-tighter text-white leading-[0.9] text-glow">
                            <span className="text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-200 to-white">MARKDOWN AGENTS</span><br/>
                            {/* evolve-live turns these glyphs into translucent
                                windows (only while .shader-fx is on <html>) so the
                                glyph-masked aurora behind the content paints the
                                word. data-shader-evolve tags it in the mask. */}
                            THAT{' '}
                            <a href="#evolve" className="hover:opacity-90 transition-opacity">
                                <span className="evolve-live" data-shader-evolve>EVOLVE.</span>
                            </a>
                        </h1>

                        <p className="mt-8 text-lg lg:text-xl text-zinc-300 leading-relaxed font-light border-l-4 border-orange-500/50 pl-6">
                            One file per <span className="text-white font-semibold">agent</span>. Any engine.<br/>
                            <span className="text-white font-semibold">Evals</span> that prove behavior.<br/>
                            Every run makes them better.
                        </p>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.5, duration: 0.6 }}
                        className="select-none flex flex-col sm:flex-row gap-5 items-start sm:items-center pt-4"
                    >
                        <button
                            onClick={copyInstall}
                            data-shader-target="install"
                            data-shader-priority="1"
                            className="group relative flex items-center gap-4 px-8 py-5 bg-white text-black font-mono font-bold rounded-lg transition-all hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(255,255,255,0.3)] hover:shadow-[0_0_30px_rgba(255,255,255,0.5)] overflow-hidden w-full sm:w-auto"
                        >
                            <span className="text-orange-600 font-bold text-xl">$</span>
                            <span className="tracking-tight text-lg">npx mdflow init</span>
                            <div className="absolute right-0 top-0 bottom-0 w-16 bg-gradient-to-l from-white to-transparent"></div>
                            <div className="ml-4 pl-4 border-l border-zinc-200 text-zinc-400 group-hover:text-black transition-colors z-10">
                                {copied ? <Check size={20} className="text-green-600" /> : <Copy size={20} />}
                            </div>
                        </button>

                        <a href="#agent-first" data-shader-target="agent-first-link" data-shader-priority="0.45" className="px-6 py-4 text-zinc-400 hover:text-white transition-colors font-medium flex items-center gap-2 group">
                            Or paste a prompt into your agent <ChevronRight size={16} className="group-hover:translate-x-1 transition-transform" />
                        </a>
                    </motion.div>

                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.7, duration: 0.6 }}
                        className="select-none text-sm text-zinc-500 font-light -mt-2"
                    >
                        No install needed. It finds your agent CLI (claude, codex, cursor-agent, agy, …)
                        and opens it pre-loaded with the setup guide: the agent explores your repo, proposes
                        a flow roster tailored to <em className="text-zinc-300 not-italic">your</em> project,
                        writes <span className="font-mono text-zinc-300">./flows</span> + <span className="font-mono text-zinc-300">.mdflow.yaml</span> once
                        you approve, and proves every flow with free dry runs.
                        Scripting? <span className="font-mono text-zinc-300">--yes</span> scaffolds the starter roster with zero engine turns.
                    </motion.p>
                </div>

                {/* Hero Demo - Hidden on small mobile, visible on desktop */}
                <div className="lg:col-span-6 h-[600px] relative hidden lg:block perspective-1000">
                    <motion.div
                        animate={{
                            rotateY: [0, -5, 0],
                            rotateX: [0, 5, 0],
                            y: [0, -20, 0]
                        }}
                        transition={{
                            duration: 8,
                            repeat: Infinity,
                            ease: "easeInOut"
                        }}
                        className="relative w-full h-full preserve-3d"
                    >
                        {/* Editor Window */}
                        <motion.div
                            className="absolute w-[70%] h-[70%] shadow-[0_20px_50px_rgba(0,0,0,0.5)] border border-white/10 rounded-xl bg-[#0d1117] cursor-pointer overflow-hidden"
                            initial={false}
                            animate={{
                                x: editorInFront ? 180 : -40,
                                y: editorInFront ? 60 : 40,
                                z: editorInFront ? 50 : 0,
                                zIndex: editorInFront ? 30 : 20,
                                scale: editorInFront ? 1.02 : 0.95,
                            }}
                            transition={{
                                duration: 0.6,
                                ease: [0.4, 0, 0.2, 1],
                                zIndex: { delay: 0.3 }
                            }}
                            onClick={() => !editorInFront && setEditorInFront(true)}
                            whileHover={!editorInFront ? { scale: 0.97, transition: { duration: 0.2 } } : {}}
                        >
                            <Editor filename="research.md" content={HERO_MD} />
                            <div className="absolute inset-0 -z-10 bg-orange-500/20 blur-xl rounded-xl"></div>
                        </motion.div>

                        {/* Terminal Window */}
                        <motion.div
                            className="absolute w-[70%] h-[70%] shadow-[0_20px_50px_rgba(0,0,0,0.5)] border border-white/10 rounded-xl bg-[#09090b] cursor-pointer overflow-hidden"
                            initial={false}
                            animate={{
                                x: editorInFront ? -40 : 120,
                                y: editorInFront ? 40 : 100,
                                z: editorInFront ? 0 : 50,
                                zIndex: editorInFront ? 20 : 30,
                                scale: editorInFront ? 0.95 : 1.02,
                            }}
                            transition={{
                                duration: 0.6,
                                ease: [0.4, 0, 0.2, 1],
                                zIndex: { delay: 0.3 }
                            }}
                            onClick={() => editorInFront && setEditorInFront(false)}
                            whileHover={editorInFront ? { scale: 0.97, transition: { duration: 0.2 } } : {}}
                        >
                            <Terminal lines={lines} title="mdflow-cli" isLive={true} />
                            <div className="absolute inset-0 -z-10 bg-blue-500/20 blur-xl rounded-xl"></div>
                        </motion.div>

                        {/* Connecting Line Visualization */}
                        <svg className="absolute inset-0 w-full h-full pointer-events-none z-25 drop-shadow-[0_0_8px_rgba(255,255,255,0.5)]">
                            <path
                                d="M 220 250 C 220 350, 400 350, 450 450"
                                stroke="url(#gradient-line)"
                                strokeWidth="2"
                                fill="none"
                                strokeDasharray="10 10"
                            >
                                <animate attributeName="stroke-dashoffset" from="100" to="0" dur="2s" repeatCount="indefinite" />
                            </path>
                            <defs>
                                <linearGradient id="gradient-line" x1="0%" y1="0%" x2="100%" y2="0%">
                                    <stop offset="0%" stopColor="#f97316" />
                                    <stop offset="100%" stopColor="#3b82f6" />
                                </linearGradient>
                            </defs>
                        </svg>
                    </motion.div>
                </div>
            </div>
        </div>
    );
};
