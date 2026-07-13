import React, { forwardRef } from 'react';
import { ArrowRight, Zap } from 'lucide-react';

export const WORKSHOP_URL = 'https://egghead.io/workshop/software-factory';
export const WORKSHOP_TITLE = 'Agentic Software Factory Workshop';

interface WorkshopCTAProps {
    variant: 'hero' | 'full';
    className?: string;
    shaderTarget?: string;
    shaderPriority?: number;
    shaderGravity?: number;
}

export const WorkshopCTA = forwardRef<HTMLAnchorElement, WorkshopCTAProps>(({
    variant,
    className = '',
    shaderTarget,
    shaderPriority,
    shaderGravity,
}, ref) => {
    const full = variant === 'full';

    return (
        <a
            ref={ref}
            href={WORKSHOP_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-marketing-cta="workshop"
            data-workshop-placement={variant}
            data-shader-target={shaderTarget}
            data-shader-priority={shaderPriority}
            data-shader-gravity={shaderGravity}
            aria-label={`Buy tickets for John Lindquist's ${WORKSHOP_TITLE} (opens in a new tab)`}
            className={full
                ? `group relative z-10 inline-flex min-h-11 max-w-full items-center gap-2.5 rounded-lg bg-white px-4 py-3 font-mono text-xs font-bold text-black shadow-[0_0_20px_rgba(255,255,255,0.25)] transition-all duration-200 hover:scale-105 hover:shadow-[0_0_25px_rgba(255,255,255,0.5),0_0_50px_rgba(249,115,22,0.7),0_0_100px_rgba(249,115,22,0.35)] active:scale-95 motion-reduce:transform-none sm:gap-3 sm:px-6 sm:py-3.5 sm:text-sm ${className}`
                : `group inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-orange-300/35 bg-orange-400/10 px-4 py-2.5 font-mono text-sm font-bold text-orange-100 transition-colors hover:border-orange-200/60 hover:bg-orange-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 sm:w-auto ${className}`}
        >
            <span aria-hidden="true" className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-500/15 ring-1 ring-orange-500/40">
                {full && (
                    <span className="absolute inset-0 animate-ping rounded-full bg-orange-500/25 [animation-duration:2.2s] motion-reduce:animate-none" />
                )}
                <Zap size={15} strokeWidth={2.5} className="relative fill-orange-500 text-orange-500 drop-shadow-[0_0_6px_rgba(249,115,22,0.9)]" />
            </span>
            <span>{full ? WORKSHOP_TITLE : 'Buy workshop tickets'}</span>
            <ArrowRight aria-hidden="true" size={16} strokeWidth={2.5} className="shrink-0 text-orange-500 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transform-none" />
        </a>
    );
});

WorkshopCTA.displayName = 'WorkshopCTA';
