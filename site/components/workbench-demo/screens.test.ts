import { describe, expect, it } from 'bun:test';
import {
    allDemoFlows,
    currentRun,
    demoReducer,
    initialDemoState,
    storyFor,
    type DemoState,
    type StoryId,
} from './model';
import { stripAnsi, terminalScreen } from './screens';

function plainScreen(state: DemoState, cols = 92): string {
    return stripAnsi(terminalScreen(state, allDemoFlows(state), cols, 26, false));
}

function runStory(storyId: StoryId): DemoState {
    let state = initialDemoState(storyId, true);
    for (const _cue of storyFor(storyId).cues) {
        state = demoReducer(state, { type: 'TIMELINE_CUE', ...currentRun(state) });
    }
    return state;
}

describe('project setup story', () => {
    it('shows real launch consent and persistent browser-fixture honesty', () => {
        let state = initialDemoState('project-setup', true);
        state = demoReducer(state, { type: 'TIMELINE_CUE', ...currentRun(state) });
        state = demoReducer(state, { type: 'TIMELINE_CUE', ...currentRun(state) });
        const screen = plainScreen(state);
        expect(screen).toContain('Launch codex?');
        expect(screen).toContain('[ENGINE]');
        expect(screen).toContain('browser did not launch codex');
        expect(screen).toContain('BROWSER SIMULATION · NO FILES / ENGINES');
    });

    it('uses a numbered 4-flow conversation and no checkbox language', () => {
        let state = initialDemoState('project-setup');
        state = demoReducer(state, { type: 'SET_PROJECT_STAGE', stage: 'selection' });
        state = demoReducer(state, { type: 'SET_PROJECT_SELECTION', selected: [1, 3] });
        const screen = plainScreen(state);
        expect(screen).toContain('1. review-changes');
        expect(screen).toContain('4. dependency-upgrade');
        expect(screen).toContain('Keep 1 and 3. Drop 2 and 4. Default engine: codex.');
        expect(screen).not.toMatch(/[☐☑]/);
        expect(screen).not.toContain('[x]');
    });

    it('stops before go, then shows only a mock receipt and free plan', () => {
        const stopped = runStory('project-setup');
        expect(plainScreen(stopped)).toContain('Type go to approve this exact roster');
        expect(plainScreen(stopped)).toContain('Nothing is written');
        expect(plainScreen(stopped)).not.toContain('You › go');

        const continued = demoReducer(stopped, { type: 'CONTINUE_SAMPLE', ...currentRun(stopped) });
        const receipt = plainScreen(continued);
        expect(receipt).toContain('You › go');
        expect(receipt).toContain('SAMPLE RECEIPT AFTER EXPLICIT go');
        expect(receipt).toContain('[FREE] md review-changes --_dry-run');
        expect(receipt).toContain('No repository files were written');
        expect(receipt).not.toContain('behavioral proof achieved');
    });
});

describe('quick create story', () => {
    it('asks the exact one question and does not invent a preview or confirmation step', () => {
        let state = initialDemoState('quick-create');
        state = demoReducer(state, { type: 'SET_QUICK_STAGE', stage: 'question' });
        const screen = plainScreen(state);
        expect(screen).toContain('What should this flow do?');
        expect(screen.toLowerCase()).not.toContain('preview');
        expect(screen.toLowerCase()).not.toContain('confirm');
    });

    it('does not show a created file until the explicit continued Enter fixture', () => {
        const stopped = runStory('quick-create');
        expect(plainScreen(stopped)).toContain('Autoplay stopped before Enter');
        expect(plainScreen(stopped)).not.toContain('Created flow:');

        const continued = demoReducer(stopped, { type: 'CONTINUE_SAMPLE', ...currentRun(stopped) });
        const receipt = plainScreen(continued);
        expect(receipt).toContain('Created flow: ~/dev/atlas-web/flows/draft-release-notes-from-this-branch.md');
        expect(receipt).toContain('not evaluated');
        expect(receipt).toContain('Browser memory only');
    });
});

describe('safe evolution story', () => {
    it('labels proposal claims as fixture data and stops before A', () => {
        const stopped = runStory('evolve-safely');
        const screen = plainScreen(stopped);
        expect(screen).toContain('DECISION BOUNDARY');
        expect(screen).toContain('Autoplay never presses A');
        expect(screen).toContain('A open apply confirmation');
        expect(screen).not.toContain('APPLIED · DEMO STATE');
    });

    it('shows the exact A/R confirmation controls and shell commands', () => {
        let state = runStory('evolve-safely');
        state = demoReducer(state, { type: 'REQUEST_APPLY' });
        let screen = plainScreen(state);
        expect(screen).toContain('Shell: md evolve apply evr_demo_01');
        expect(screen).toContain('Enter / C confirm');

        state = demoReducer(state, { type: 'APPLY_FIXTURE' });
        state = demoReducer(state, { type: 'REQUEST_ROLLBACK' });
        screen = plainScreen(state);
        expect(screen).toContain('Shell: md evolve rollback evr_demo_01');
        expect(screen).toContain('Enter / C confirm');
    });
});

describe('personal flow story', () => {
    it('creates in ~/.mdflow and does not present a registry installation', () => {
        const stopped = runStory('personal-flows');
        const screen = plainScreen(stopped);
        expect(screen).toContain('md create --global');
        expect(screen).toContain('~/.mdflow/turn-my-notes-into-a-daily-plan.md');
        expect(screen).toContain('not a registry install');
        expect(screen).not.toContain('Installed flow');
    });

    it('continues with another-project dry-run, user resolution, and project shadowing', () => {
        const stopped = runStory('personal-flows');
        const continued = demoReducer(stopped, { type: 'CONTINUE_SAMPLE', ...currentRun(stopped) });
        const screen = plainScreen(continued);
        expect(screen).toContain('cd ~/dev/harbor-api');
        expect(screen).toContain('[FREE] Resolved: ~/.mdflow/turn-my-notes-into-a-daily-plan.md');
        expect(screen).toContain('project flows/turn-my-notes-into-a-daily-plan.md would shadow');
        expect(screen).toContain('No engine invoked');
        expect(screen).toContain('not behavioral quality');
    });
});

describe('terminal rendering safety', () => {
    it('uses green FREE, yellow ENGINE, and blue LOCAL WRITE labels', () => {
        let free = initialDemoState('evolve-safely');
        free = demoReducer(free, { type: 'PLAN' });
        expect(terminalScreen(free, allDemoFlows(free), 92, 26, false)).toContain('\u001b[38;2;52;211;153m[FREE]');

        let engine = initialDemoState('evolve-safely');
        engine = demoReducer(engine, { type: 'LOAD_PROPOSAL_FIXTURE' });
        expect(terminalScreen(engine, allDemoFlows(engine), 92, 26, false)).toContain('\u001b[38;2;251;191;36m[ENGINE]');

        engine = demoReducer(engine, { type: 'SHOW_DECISION' });
        expect(terminalScreen(engine, allDemoFlows(engine), 92, 26, false)).toContain('\u001b[38;2;96;165;250m[LOCAL WRITE]');
    });

    it('clips every ANSI-rendered line to narrow terminal columns', () => {
        let state = initialDemoState('project-setup');
        state = demoReducer(state, { type: 'SET_PROJECT_STAGE', stage: 'suggestions' });
        const rendered = terminalScreen(state, allDemoFlows(state), 38, 22, false);
        const visibleLines = stripAnsi(rendered)
            .replace(/\u001b\[[?0-9;]*[A-Za-z]/g, '')
            .split(/\r?\n/);
        expect(Math.max(...visibleLines.map((line) => Array.from(line).length))).toBeLessThanOrEqual(38);
    });

    it('hides the terminal cursor when reduced motion is requested', () => {
        const state = demoReducer(initialDemoState('quick-create'), { type: 'SET_QUICK_STAGE', stage: 'question' });
        const rendered = terminalScreen(state, allDemoFlows(state), 92, 26, true);
        expect(rendered).toContain('\u001b[?25l');
        expect(rendered).not.toContain('\u001b[?25h');
    });
});
