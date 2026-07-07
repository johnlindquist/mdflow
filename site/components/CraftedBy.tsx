import React, { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { Zap, ArrowRight } from 'lucide-react';
import { EggoInteractive, StretchName } from './EggoInteractive';

/**
 * Prominent maker credit. [data-shader-credit] gives the block its own
 * glyph-mask region: aurora flows inside the lettering, while the eggo mark
 * (data-shader-egg, red channel) gets the living-organism layer plus golden
 * yolk rays radiating behind it.
 *
 * The workshop CTA — not the container — is the shader attention target, so
 * spark dots fly past the card edge and land on the button itself, pulled by
 * a gravity well slightly stronger than the hero's npm button
 * (data-shader-gravity). The eggo and the name are physical bodies
 * (data-shader-bounce): dots ricochet off them on the way in.
 */
const TRACK_TEXT = 'Tickets are Limited. Join Now!';

export const CraftedBy: React.FC = () => {
    const btnRef = useRef<HTMLAnchorElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);

    // "Tickets are Limited. Join Now!" circles the button like a train on a
    // track. The track sits BELOW the button in z-order and scales with
    // cursor proximity: far away it shrinks under the button's footprint
    // (the train hides behind the button), and as the cursor closes in the
    // whole ring slides out from behind it. Styles are driven directly (no
    // re-renders), one rAF per pointer frame.
    useEffect(() => {
        const fine = window.matchMedia('(pointer: fine)').matches;
        let raf = 0;
        let lastEased = -1;
        // no work at all while the card is scrolled away
        let onScreen = false;
        const io = new IntersectionObserver(
            entries => {
                onScreen = entries[0].isIntersecting;
                // scroll-driven mode: recompute the moment the card enters
                // view (a lone programmatic scroll may already have passed)
                if (onScreen && !fine) onScroll();
            },
            { rootMargin: '100px' },
        );
        if (btnRef.current) io.observe(btnRef.current);
        // fully tucked = invisible anyway, so stop paying for the 30
        // offset-path char animations (they run on the main thread)
        const setTucked = (on: boolean) => {
            const track = trackRef.current;
            if (!track || (track.dataset.tucked === '1') === on) return;
            track.dataset.tucked = on ? '1' : '0';
            track.style.visibility = on ? 'hidden' : '';
            for (let i = 0; i < track.children.length; i++) {
                (track.children[i] as HTMLElement).style.animationPlayState =
                    on ? 'paused' : 'running';
            }
        };
        setTucked(true);
        // proximity from a point — the cursor on desktop, the viewport's
        // focal point on touch (so scrolling the button toward center
        // brings the train out and starts the eggo dancing)
        const update = (px: number, py: number) => {
            const btn = btnRef.current;
            const track = trackRef.current;
            if (!btn || !track) return;
            const r = btn.getBoundingClientRect();
            const d = Math.hypot(
                px - (r.left + r.width / 2),
                py - (r.top + r.height / 2),
            );
            // fully tucked away past ~450px, fully out within ~70px
            const p = Math.max(0, Math.min(1, 1 - (d - 70) / 380));
            const eased = p * p * (3 - 2 * p);
            // skip style writes + events while the value isn't moving
            if (Math.abs(eased - lastEased) < 0.002) return;
            lastEased = eased;
            track.style.transform = `scale(${(0.45 + 0.55 * eased).toFixed(4)})`;
            setTucked(eased < 0.03);
            // the eggo eavesdrops on this and starts dancing
            window.dispatchEvent(new CustomEvent('mdflow:workshop-prox', {
                detail: { p: eased },
            }));
        };
        const onMove = (e: PointerEvent) => {
            if (raf || !onScreen) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                update(e.clientX, e.clientY);
            });
        };
        const onScroll = () => {
            if (raf || !onScreen) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                update(window.innerWidth / 2, window.innerHeight * 0.42);
            });
        };
        if (fine) {
            window.addEventListener('pointermove', onMove, { passive: true });
        } else {
            window.addEventListener('scroll', onScroll, { passive: true });
            window.addEventListener('resize', onScroll);
            onScroll();
        }
        return () => {
            io.disconnect();
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
            if (raf) cancelAnimationFrame(raf);
        };
    }, []);

    // Lay the track: every character is a train car on a rounded-rect
    // offset-path hugging the button, spaced by a staggered negative
    // animation-delay so the string reads in order as it rolls. Rebuilt
    // whenever the button changes size (font swap-in, breakpoint) so the
    // ring always closes around the real button.
    useEffect(() => {
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        // old engines without offset-path would pile the cars in a corner
        if (!CSS.supports?.('offset-path', "path('M 0 0 H 10')")) {
            if (trackRef.current) trackRef.current.style.display = 'none';
            return;
        }
        const build = () => {
            const track = trackRef.current;
            if (!track) return;
            const w = track.offsetWidth;
            const h = track.offsetHeight;
            if (w < 20 || h < 20) return;
            const r = Math.min(24, h / 2 - 1);
            const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} `
                + `V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} `
                + `A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
            const perim = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
            const dur = perim / 90; // ~90 px/s crawl
            const charW = 8;        // mono car length incl. coupling
            const cars = track.children;
            // the animation shorthand resets play-state, so re-apply the
            // current tuck state after a rebuild
            const paused = track.dataset.tucked === '1';
            for (let i = 0; i < cars.length; i++) {
                const s = (cars[i] as HTMLElement).style;
                s.setProperty('offset-path', `path('${path}')`);
                s.setProperty('offset-rotate', 'auto');
                s.animation = `cta-march ${dur}s linear infinite`;
                // later cars sit further along the path: the text reads
                // left-to-right along the direction of travel
                s.animationDelay = `${-(i * charW / perim) * dur}s`;
                if (paused) s.animationPlayState = 'paused';
            }
        };
        build();
        document.fonts?.ready.then(build).catch(() => {});
        const ro = new ResizeObserver(build);
        if (trackRef.current) ro.observe(trackRef.current);
        window.addEventListener('resize', build);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', build);
        };
    }, []);

    return (
        <section className="relative py-28 px-6">
            <motion.div
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.6 }}
                data-shader-credit
                className="select-none max-w-3xl mx-auto flex flex-col sm:flex-row items-center gap-10 rounded-2xl border border-orange-500/15 bg-[#0a0a0c]/70 backdrop-blur-sm p-10 sm:p-12 shadow-[0_0_50px_-12px_rgba(249,115,22,0.3),0_0_120px_-30px_rgba(249,115,22,0.2)]"
            >
                {/* grabbable rubber-sheet eggo — stretch it, it snaps back;
                    dots treat it as a round bumper */}
                <div data-shader-bounce="circle" className="shrink-0">
                    <EggoInteractive />
                </div>
                <div className="text-center sm:text-left">
                    <div className="text-xs font-mono uppercase tracking-[0.3em] text-zinc-500 mb-2">
                        Crafted by
                    </div>
                    {/* the name is a stretchy sheet too (no link — pure toy);
                        each LETTER is its own bumper, so dots ricochet off
                        single glyphs or slip between them */}
                    <StretchName
                        text="John Lindquist"
                        className="mx-auto sm:mx-0"
                    />
                    <p className="mt-3 text-zinc-400 leading-relaxed">
                        <span className="block">
                            Co-founder of{' '}
                            <a
                                href="https://egghead.io"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-orange-400 hover:text-orange-300 transition-colors font-semibold"
                            >
                                egghead.io
                            </a>
                        </span>
                        <span className="block">Teaching developers to build with agents.</span>
                    </p>
                    <div className="relative mt-6 inline-block">
                        <style>{'@keyframes cta-march { from { offset-distance: 0%; } to { offset-distance: 100%; } }'}</style>
                        {/* proximity teaser: a character train circling the
                            button's rounded-rect track — cyan so it reads
                            against the orange pulsing outline. It stacks
                            UNDER the button (which is z-10) and scales down
                            when the cursor leaves, so the train physically
                            slides behind the button instead of fading */}
                        <div
                            ref={trackRef}
                            aria-hidden
                            className="absolute -inset-x-4 -top-3 -bottom-4 pointer-events-none will-change-transform"
                            style={{ transform: 'scale(0.45)' }}
                        >
                            {TRACK_TEXT.split('').map((ch, i) => (
                                <span
                                    key={i}
                                    className="absolute font-mono text-[11px] font-bold uppercase text-cyan-300"
                                    style={{ textShadow: '0 0 3px rgba(0,0,0,0.95), 0 0 7px rgba(34,211,238,0.8)' }}
                                >
                                    {ch === ' ' ? ' ' : ch}
                                </span>
                            ))}
                        </div>
                        <a
                            ref={btnRef}
                            href="https://egghead.io/workshop/software-factory"
                            target="_blank"
                            rel="noopener noreferrer"
                            data-shader-target="workshop"
                            data-shader-priority="1"
                            data-shader-gravity="1.3"
                            className="group relative z-10 inline-flex items-center gap-3 px-6 py-3.5 rounded-lg bg-white text-black font-mono font-bold text-sm hover:scale-105 active:scale-95 transition-all duration-200 shadow-[0_0_20px_rgba(255,255,255,0.25)] hover:shadow-[0_0_25px_rgba(255,255,255,0.5),0_0_50px_rgba(249,115,22,0.7),0_0_100px_rgba(249,115,22,0.35)]"
                        >
                            {/* the bolt gets its own stage: an orange chip
                                with a slow radar ping behind a filled,
                                glowing Zap — the eye lands here first */}
                            <span aria-hidden className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500/15 ring-1 ring-orange-500/40">
                                <span className="absolute inset-0 rounded-full bg-orange-500/25 animate-ping [animation-duration:2.2s]" />
                                <Zap size={15} strokeWidth={2.5} className="relative text-orange-600 fill-orange-500 drop-shadow-[0_0_6px_rgba(249,115,22,0.9)]" />
                            </span>
                            Agentic Software Factory Workshop
                            <ArrowRight aria-hidden size={16} strokeWidth={2.5} className="text-orange-500 transition-transform duration-200 group-hover:translate-x-1" />
                        </a>
                    </div>
                </div>
            </motion.div>
        </section>
    );
};
