import React, { useState } from 'react';
import { Copy, Check, Bot } from 'lucide-react';
import { motion } from 'framer-motion';

interface CopyPromptProps {
    title: string;
    description: string;
    prompt: string;
    /** Render as a single shell command instead of an agent prompt. */
    isCommand?: boolean;
    accent?: 'orange' | 'blue' | 'emerald' | 'pink';
    index?: number;
    /** Registers this card as a ShaderGuide attention target. */
    shaderTarget?: string;
    shaderPriority?: number;
}

const ACCENTS = {
    orange: { border: 'hover:border-orange-500/50', glow: 'group-hover:shadow-[0_0_30px_rgba(249,115,22,0.15)]', chip: 'text-orange-300 border-orange-500/40 bg-orange-950/30' },
    blue: { border: 'hover:border-blue-500/50', glow: 'group-hover:shadow-[0_0_30px_rgba(59,130,246,0.15)]', chip: 'text-blue-300 border-blue-500/40 bg-blue-950/30' },
    emerald: { border: 'hover:border-emerald-500/50', glow: 'group-hover:shadow-[0_0_30px_rgba(16,185,129,0.15)]', chip: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/30' },
    pink: { border: 'hover:border-pink-500/50', glow: 'group-hover:shadow-[0_0_30px_rgba(236,72,153,0.15)]', chip: 'text-pink-300 border-pink-500/40 bg-pink-950/30' },
};

export const CopyPrompt: React.FC<CopyPromptProps> = ({ title, description, prompt, isCommand = false, accent = 'orange', index = 0, shaderTarget, shaderPriority }) => {
    const [copied, setCopied] = useState(false);
    const a = ACCENTS[accent];

    const copy = (e: React.MouseEvent<HTMLButtonElement>) => {
        navigator.clipboard.writeText(prompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        const r = e.currentTarget.getBoundingClientRect();
        window.dispatchEvent(new CustomEvent('mdflow:copied', {
            detail: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        }));
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.5, delay: index * 0.08 }}
            data-shader-target={shaderTarget}
            data-shader-priority={shaderPriority}
            className={`group relative border border-zinc-800 bg-[#0a0a0c] rounded-xl overflow-hidden transition-all ${a.border} ${a.glow}`}
        >
            <div className="p-6 pb-4 select-none">
                <div className="flex items-center justify-between gap-4 mb-3">
                    <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full border text-[11px] font-mono uppercase tracking-widest ${a.chip}`}>
                        {isCommand ? <span className="font-bold">$ shell</span> : <><Bot size={12} /> <span className="font-bold">paste into your agent</span></>}
                    </div>
                    <button
                        onClick={copy}
                        aria-label={`Copy: ${title}`}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-black text-xs font-mono font-bold hover:scale-105 active:scale-95 transition-transform shadow-[0_0_15px_rgba(255,255,255,0.2)]"
                    >
                        {copied ? <><Check size={14} className="text-green-600" /> COPIED</> : <><Copy size={14} /> COPY</>}
                    </button>
                </div>
                <h3 className="font-display font-bold text-xl text-white tracking-tight">{title}</h3>
                <p className="mt-1 text-sm text-zinc-400 leading-relaxed">{description}</p>
            </div>
            <div className="border-t border-zinc-800/80 bg-[#050505] px-6 py-5">
                <pre className="font-mono text-[13px] leading-relaxed text-zinc-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{prompt}</pre>
            </div>
        </motion.div>
    );
};
