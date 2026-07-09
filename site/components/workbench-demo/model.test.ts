import { describe, expect, it } from 'bun:test';
import { QUICK_CREATE_INTENT } from './fixtures';
import {
    allDemoFlows,
    canContinueSample,
    currentCue,
    currentRun,
    demoReducer,
    flowFromIntent,
    initialDemoState,
    shellQuote,
    slugifyIntent,
    STORIES,
    storyFor,
    type DemoState,
    type StoryId,
} from './model';

function runStory(storyId: StoryId): DemoState {
    let state = initialDemoState(storyId, true);
    for (const _cue of storyFor(storyId).cues) {
        state = demoReducer(state, { type: 'TIMELINE_CUE', ...currentRun(state) });
    }
    return state;
}

describe('four-story definitions', () => {
    it('has the four stories in the intended onboarding order', () => {
        expect(STORIES.map((story) => story.id)).toEqual([
            'project-setup',
            'quick-create',
            'evolve-safely',
            'personal-flows',
        ]);
    });

    it('uses the Fusion-approved durations, monotonic cues, and one final gate', () => {
        expect(STORIES.map((story) => story.durationMs)).toEqual([28_000, 18_000, 30_000, 23_000]);
        for (const story of STORIES) {
            for (let index = 1; index < story.cues.length; index += 1) {
                expect(story.cues[index]!.at).toBeGreaterThan(story.cues[index - 1]!.at);
            }
            const last = story.cues.at(-1)!;
            expect(last.at).toBe(story.durationMs);
            expect(last.stop).toBe(true);
            expect(last.gate).toBeDefined();
            expect(story.cues.slice(0, -1).every((cue) => !cue.stop && !cue.gate)).toBe(true);
        }
    });

    it('never places a create, apply, rollback, or confirmation action on a timed cue', () => {
        const forbidden = new Set([
            'CONTINUE_SAMPLE',
            'REQUEST_APPLY',
            'REQUEST_ROLLBACK',
            'APPLY_FIXTURE',
            'ROLLBACK_FIXTURE',
        ]);
        for (const story of STORIES) {
            expect(story.cues.every((cue) => !forbidden.has(cue.action.type))).toBe(true);
        }
    });
});

describe('story reducer and safety gates', () => {
    it('stops guided setup before go and continues only after a current-run action', () => {
        const stopped = runStory('project-setup');
        expect(stopped.projectStage).toBe('approval');
        expect(stopped.gate).toBe('project-go');
        expect(stopped.playback.status).toBe('complete');
        expect(canContinueSample(stopped)).toBe(true);

        const continued = demoReducer(stopped, { type: 'CONTINUE_SAMPLE', ...currentRun(stopped) });
        expect(continued.projectStage).toBe('receipt');
        expect(continued.gate).toBeNull();
    });

    it('stops quick create before Enter and gives the continued fixture no fake proof', () => {
        const stopped = runStory('quick-create');
        expect(stopped.quickStage).toBe('enter-boundary');
        expect(stopped.createSaved).toBe(false);
        expect(stopped.savedFlow).toBeNull();
        expect(stopped.gate).toBe('quick-create-enter');

        const continued = demoReducer(stopped, { type: 'CONTINUE_SAMPLE', ...currentRun(stopped) });
        expect(continued.quickStage).toBe('receipt');
        expect(continued.createSaved).toBe(true);
        expect(continued.savedFlow).toMatchObject({
            slug: slugifyIntent(QUICK_CREATE_INTENT),
            evidence: 'no feedback yet',
            evaluation: 'not evaluated',
            scope: 'project',
        });
    });

    it('stops evolution before A and preserves A/R plus Enter/C confirmation gates', () => {
        let state = runStory('evolve-safely');
        expect(state.evolveStage).toBe('decision');
        expect(state.gate).toBe('evolve-apply');
        expect(state.confirmAction).toBeNull();
        expect(canContinueSample(state)).toBe(false);

        state = demoReducer(state, { type: 'CONTINUE_SAMPLE', ...currentRun(state) });
        expect(state.confirmAction).toBeNull();
        state = demoReducer(state, { type: 'REQUEST_APPLY' });
        expect(state.confirmAction).toBe('apply');
        state = demoReducer(state, { type: 'APPLY_FIXTURE' });
        expect(state.evolveStage).toBe('applied');
        state = demoReducer(state, { type: 'REQUEST_ROLLBACK' });
        expect(state.confirmAction).toBe('rollback');
        state = demoReducer(state, { type: 'ROLLBACK_FIXTURE' });
        expect(state.evolveStage).toBe('rolled-back');
    });

    it('lets the feedback editor cancel without recording evidence', () => {
        let state = initialDemoState('evolve-safely');
        state = demoReducer(state, { type: 'SHOW_FEEDBACK' });
        state = demoReducer(state, { type: 'SET_FEEDBACK', feedback: 'draft feedback' });
        state = demoReducer(state, { type: 'CANCEL_FEEDBACK' });

        expect(state.evolveStage).toBe('sample-result');
        expect(state.feedbackText).toBe('');
        expect(state.feedbackSaved).toBe(false);
    });

    it('stops personal creation before Enter, then resolves the personal file in another project', () => {
        const stopped = runStory('personal-flows');
        expect(stopped.personalStage).toBe('enter-boundary');
        expect(stopped.personalSaved).toBe(false);
        expect(stopped.gate).toBe('personal-create-enter');

        const continued = demoReducer(stopped, { type: 'CONTINUE_SAMPLE', ...currentRun(stopped) });
        expect(continued.personalStage).toBe('cross-project');
        expect(continued.savedPersonalFlow).toMatchObject({
            scope: 'personal',
            evaluation: 'not evaluated',
            engine: 'engine ladder / project config where run',
        });
        expect(allDemoFlows(continued).at(-1)?.scope).toBe('personal');
    });

    it('invalidates delayed cues and continue actions when story or run token changes', () => {
        const original = initialDemoState('project-setup', true);
        const stale = currentRun(original);
        const selected = demoReducer(original, { type: 'SELECT_STORY', storyId: 'quick-create' });
        expect(selected.playback.runToken).toBe(stale.runToken + 1);
        expect(selected.playback.status).toBe('idle');
        expect(selected.playback.takenOver).toBe(true);

        expect(demoReducer(selected, { type: 'TIMELINE_CUE', ...stale })).toEqual(selected);
        expect(demoReducer(selected, { type: 'CONTINUE_SAMPLE', ...stale })).toEqual(selected);

        const restarted = demoReducer(selected, { type: 'RESTART', play: true });
        expect(restarted.playback.runToken).toBe(selected.playback.runToken + 1);
        expect(demoReducer(restarted, { type: 'TIMELINE_CUE', ...currentRun(selected) })).toEqual(restarted);
    });

    it('steps exactly one current cue without timers and stops at the story gate', () => {
        let state = initialDemoState('quick-create', false);
        const first = currentCue(state);
        state = demoReducer(state, { type: 'STEP_CUE', ...currentRun(state) });
        expect(first?.action.type).toBe('SET_QUICK_STAGE');
        expect(state.playback.cueIndex).toBe(1);
        expect(state.playback.status).toBe('idle');
        expect(state.playback.takenOver).toBe(true);

        while (state.playback.status !== 'complete') {
            state = demoReducer(state, { type: 'STEP_CUE', ...currentRun(state) });
        }
        expect(state.playback.cueIndex).toBe(storyFor('quick-create').cues.length);
        expect(state.gate).toBe('quick-create-enter');
        const afterGate = demoReducer(state, { type: 'STEP_CUE', ...currentRun(state) });
        expect(afterGate).toEqual(state);
    });

    it('never lets later fixture cues overwrite user-authored quick or personal intent', () => {
        let quick = initialDemoState('quick-create', false);
        quick = demoReducer(quick, { type: 'SET_CREATE_INTENT', intent: 'My custom release ritual' });
        for (let index = 0; index < 5; index += 1) {
            quick = demoReducer(quick, { type: 'STEP_CUE', ...currentRun(quick) });
        }
        expect(quick.createIntent).toBe('My custom release ritual');

        let personal = initialDemoState('personal-flows', false);
        personal = demoReducer(personal, { type: 'SET_PERSONAL_INTENT', intent: 'My cross-project notebook' });
        for (let index = 0; index < 4; index += 1) {
            personal = demoReducer(personal, { type: 'STEP_CUE', ...currentRun(personal) });
        }
        expect(personal.personalIntent).toBe('My cross-project notebook');
    });
});

describe('portable fixture contracts', () => {
    it('protects README and quotes shell display values safely', () => {
        expect(slugifyIntent('README')).toBe('readme-flow');
        expect(slugifyIntent('Read me')).toBe('read-me');
        expect(shellQuote('review')).toBe('review');
        expect(shellQuote("it's ready")).toBe(`'it'"'"'s ready'`);
        expect(shellQuote('spaces and $HOME `pwd` \\')).toBe("'spaces and $HOME `pwd` \\'");
    });

    it('never assigns proof to a newly created flow', () => {
        expect(flowFromIntent('Review database migrations')).toMatchObject({
            evidence: 'no feedback yet',
            evaluation: 'not evaluated',
        });
    });
});
