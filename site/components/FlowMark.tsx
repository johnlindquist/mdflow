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
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
    >
        <g stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
            <path data-flow-mark-path="1" data-flow-mark-chevron="trail" className="flow-mark-chevron flow-mark-chevron-trail" d="m2.5 4.5 3.5 3.5-3.5 3.5" opacity={0.3} />
            <path data-flow-mark-path="2" data-flow-mark-chevron="middle" className="flow-mark-chevron flow-mark-chevron-middle" d="m6.5 4.5 3.5 3.5-3.5 3.5" opacity={0.6} />
            <path data-flow-mark-path="3" data-flow-mark-chevron="lead" className="flow-mark-chevron flow-mark-chevron-lead" d="m10.5 4.5 3.5 3.5-3.5 3.5" />
        </g>
    </svg>
);
