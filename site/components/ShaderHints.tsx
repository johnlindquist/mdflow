import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/**
 * Discoverability layer for the shader playground. Both affordances wait
 * for the first click (proof the visitor is exploring), then:
 *  - a nudge chip under the nav's mute toggle reveals that the page has a
 *    reactive soundtrack (clicking it unmutes directly)
 *  - a one-line gesture legend at the bottom teaches the hidden mechanics
 * Everything self-dismisses after a few seconds and never comes back.
 */
export const ShaderHints: React.FC<{ muted: boolean; onUnmute: () => void }> = ({ muted, onUnmute }) => {
    const [interacted, setInteracted] = useState(false);
    const [hintsGone, setHintsGone] = useState(false);
    const [nudgeGone, setNudgeGone] = useState(false);

    useEffect(() => {
        const onDown = () => setInteracted(true);
        window.addEventListener('pointerdown', onDown, { once: true, passive: true });
        return () => window.removeEventListener('pointerdown', onDown);
    }, []);

    useEffect(() => {
        if (!interacted) return;
        const t1 = window.setTimeout(() => setNudgeGone(true), 11000);
        const t2 = window.setTimeout(() => setHintsGone(true), 16000);
        return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
    }, [interacted]);

    // the shader bails on reduced motion — so do we (touch devices play)
    if (typeof window !== 'undefined'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        return null;
    }
    const coarse = typeof window !== 'undefined'
        && !window.matchMedia('(pointer: fine)').matches;

    return (
        <AnimatePresence>
            {interacted && muted && !nudgeGone && (
                <motion.button
                    key="nudge"
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.4 }}
                    onClick={() => { setNudgeGone(true); onUnmute(); }}
                    className="fixed top-20 right-5 z-40 flex items-center gap-2 px-4 py-2 rounded-full border border-orange-500/50 bg-black/80 backdrop-blur-md text-orange-300 text-xs font-mono shadow-[0_0_18px_rgba(249,115,22,0.25)] hover:bg-orange-950/60 hover:text-orange-200 transition-colors"
                >
                    <span className="animate-pulse">♪</span>
                    this page plays music — turn it on
                </motion.button>
            )}
            {interacted && !hintsGone && (
                <motion.div
                    key="legend"
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.5, delay: 0.6 }}
                    className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none select-none px-4 py-1.5 rounded-full bg-black/60 backdrop-blur-sm text-[11px] font-mono tracking-wide text-zinc-500"
                >
                    {coarse
                        ? 'tap · hold to charge · hold then drag to sling · two-finger tap to draw walls'
                        : 'click · hold to charge · drag to sling · shift+click to draw walls'}
                </motion.div>
            )}
        </AnimatePresence>
    );
};
