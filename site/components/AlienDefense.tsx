import React, { useEffect, useRef, useState } from 'react';

/**
 * The heart HUD for the pixel-monster defense game (bottom-right).
 *
 * ShaderGuide owns every game rule (raids, dart hits, pickups, the taunt
 * dance) and broadcasts 'mdflow:hearts' — this component only renders the
 * consequences. The row carries [data-hearts-anchor] so the raiders in the
 * shader know exactly where to charge, and it stays pointer-events-none so
 * slingshots fired from this corner still work.
 *
 * Hidden until the first alien materializes: readers who never meet a
 * monster never see a HUD.
 */

interface HeartsDetail {
    hearts: number;
    max: number;
    reason: 'show' | 'steal' | 'gain' | 'defeat' | 'reset' | 'boss';
}

export const AlienDefense: React.FC = () => {
    const [state, setState] = useState<HeartsDetail | null>(null);
    const [fx, setFx] = useState<'steal' | 'gain' | null>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const msgTimer = useRef(0);
    const fxTimer = useRef(0);
    const briefed = useRef(false);

    useEffect(() => {
        const say = (text: string, ms: number) => {
            window.clearTimeout(msgTimer.current);
            setMsg(text);
            msgTimer.current = window.setTimeout(() => setMsg(null), ms);
        };
        const onHearts = (ev: Event) => {
            const d = (ev as CustomEvent<HeartsDetail>).detail;
            setState(d);
            if (d.reason === 'steal' || d.reason === 'gain') {
                window.clearTimeout(fxTimer.current);
                setFx(d.reason);
                fxTimer.current = window.setTimeout(() => setFx(null), 700);
            }
            if (d.reason === 'show' && !briefed.current) {
                briefed.current = true;
                say('👾 raiders inbound — sling darts at them before they reach your hearts', 9000);
            } else if (d.reason === 'steal') {
                say(d.hearts <= 1 ? '💔 last heart — stop them!' : '💔 heart stolen!', 4000);
            } else if (d.reason === 'gain') {
                say('❤️ heart restored', 3000);
            } else if (d.reason === 'defeat') {
                say('👾👾👾 the aliens win this round — watch them gloat', 9000);
            } else if (d.reason === 'reset') {
                say('❤️ hearts restored. round two.', 4000);
            } else if (d.reason === 'boss') {
                say('🛸 BOSS INBOUND — five darts, or one touch takes every heart', 8000);
            }
        };
        window.addEventListener('mdflow:hearts', onHearts);
        return () => {
            window.removeEventListener('mdflow:hearts', onHearts);
            window.clearTimeout(msgTimer.current);
            window.clearTimeout(fxTimer.current);
        };
    }, []);

    if (!state) return null;
    return (
        <>
            <style>{`
                @keyframes hud-heart-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes hud-steal-kf {
                    0%, 100% { transform: translateX(0); }
                    20% { transform: translateX(-5px); }
                    40% { transform: translateX(5px); }
                    60% { transform: translateX(-4px); }
                    80% { transform: translateX(3px); }
                }
                @keyframes hud-gain-kf {
                    0% { transform: scale(1); }
                    40% { transform: scale(1.25); }
                    100% { transform: scale(1); }
                }
            `}</style>
            <div
                data-alien-defense-armed="true"
                className="fixed bottom-3 right-3 z-50 flex flex-col items-end gap-1.5 select-none pointer-events-none"
                style={{ animation: 'hud-heart-in 0.4s ease-out' }}
            >
                <div
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    className={msg
                        ? 'max-w-[240px] rounded-lg border border-zinc-700/80 bg-zinc-950/85 px-3 py-2 text-right font-mono text-[11px] leading-snug text-zinc-300 backdrop-blur-md'
                        : 'sr-only'}
                >
                    {msg ?? ''}
                </div>
                <div
                    data-hearts-anchor
                    role="img"
                    aria-label={`Alien defense armed: ${state.hearts} of ${state.max} hearts left`}
                    className="flex items-center gap-1 rounded-full border border-white/10 bg-black/60 px-2.5 py-1 backdrop-blur-md"
                    style={fx === 'steal' ? { animation: 'hud-steal-kf 0.5s ease-in-out' } : undefined}
                >
                    {Array.from({ length: state.max }, (_, i) => {
                        const filled = i < state.hearts;
                        return (
                            <span
                                key={i}
                                aria-hidden="true"
                                className={filled
                                    ? 'text-sm leading-none text-rose-500 drop-shadow-[0_0_5px_rgba(244,63,94,0.9)]'
                                    : 'text-sm leading-none text-zinc-700'}
                                style={fx === 'gain' && i === state.hearts - 1
                                    ? { animation: 'hud-gain-kf 0.6s ease-out' }
                                    : undefined}
                            >
                                ♥
                            </span>
                        );
                    })}
                </div>
            </div>
        </>
    );
};
