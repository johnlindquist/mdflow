import React from 'react';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { Hero } from './Hero';
import { WorkshopCTA, WORKSHOP_URL } from './WorkshopCTA';

const APP_SOURCE = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const CRAFTED_BY_SOURCE = readFileSync(new URL('./CraftedBy.tsx', import.meta.url), 'utf8');

function visibleText(markup: string): string {
    return markup
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

describe('primary marketing invariants', () => {
    it('renders the evolve-first promise as the Hero h1', () => {
        const markup = renderToStaticMarkup(React.createElement(Hero));
        const heading = markup.match(
            /<h1\b[^>]*data-marketing-invariant="evolve-first"[^>]*>([\s\S]*?)<\/h1>/,
        );

        expect(heading).toBeTruthy();
        expect(visibleText(heading?.[1] ?? '')).toBe('MARKDOWN AGENTS THAT EVOLVE.');
        expect(markup).toContain('One Markdown file → one repeatable command');
    });

    it('keeps product install primary and the playful workshop pitch directly after Hero', () => {
        const markup = renderToStaticMarkup(React.createElement(Hero));
        const hero = APP_SOURCE.indexOf('<Hero />');
        const workshop = APP_SOURCE.indexOf('<CraftedBy />');
        const roster = APP_SOURCE.indexOf('<FlowsRoster />');

        expect(markup).toContain('data-marketing-cta="install"');
        expect(hero).toBeGreaterThan(-1);
        expect(workshop).toBeGreaterThan(hero);
        expect(workshop).toBeLessThan(roster);
    });

    it('explains evolution before the generic feature tour', () => {
        const workbench = APP_SOURCE.indexOf('<FlowWorkbenchDemo />');
        const evolve = APP_SOURCE.indexOf('<Evolve />');
        const features = APP_SOURCE.indexOf('<div id="features"');

        expect(evolve).toBeGreaterThan(workbench);
        expect(evolve).toBeLessThan(features);
    });

    it('keeps the full maker section on the shared workshop destination', () => {
        const markup = renderToStaticMarkup(React.createElement(WorkshopCTA));

        expect(CRAFTED_BY_SOURCE).toContain('<WorkshopCTA');
        expect(markup).toContain(`href="${WORKSHOP_URL}"`);
        expect(markup).toContain('data-workshop-placement="full"');
        expect(markup).toContain('Buy tickets for John Lindquist');
    });
});
