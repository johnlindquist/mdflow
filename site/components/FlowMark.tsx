import React from 'react';

/**
 * The mdflow brand mark: three chevrons accelerating out of a fade —
 * a flow gathering momentum. Shared with Script Kit's launcher, where
 * every flow row renders the same glyph (script-kit-gpui
 * assets/icons/flow.svg); keep the geometry in sync if it changes.
 */
export const FlowMark: React.FC<{ size?: number; className?: string }> = ({ size = 24, className }) => (
    <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className={className}
        aria-hidden="true"
    >
        <g stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 7 5 5-5 5" opacity={0.3} />
            <path d="m10 7 5 5-5 5" opacity={0.6} />
            <path d="m16 7 5 5-5 5" />
        </g>
    </svg>
);
