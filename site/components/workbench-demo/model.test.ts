import { describe, expect, it } from 'bun:test';
import { QUICK_CREATE_INTENT } from './fixtures';
import {
    allDemoFlows,
    canContinueSample,
    canNextBeat,
    canPreviousBeat,
    canResetGateResult,
    compileStory,
    currentBeat,
    currentPhase,
    currentRun,
    demoReducer,
    flowFromIntent,
    hasGateOutcome,
    initialDemoState,
    rebuildAtBeat,
    shellQuote,
    slugifyIntent,
    STORIES,
    storyFor,
    type DemoState,
    type StoryId,
} from './model';

function runStory(storyId: StoryId): DemoState {
    let state = initialDemoState(storyId, true);
    let remaining = 500;
    while (currentPhase(state) && remaining-- > 0) {
        state = demoReducer(state, { type: 'ADVANCE_PHASE', ...currentRun(state) });
    }
    expect(remaining).toBeGreaterThan(0);
    return state;
}

function nextBeat(state: DemoState): DemoState {
    const { storyId, runToken } = currentRun(state);
    return demoReducer(state, { type: 'NEXT_BEAT', storyId, runToken });
}

function previousBeat(state: DemoState): DemoState {
    const { storyId, runToken } = currentRun(state);
    return demoReducer(state, { type: 'PREVIOUS_BEAT', storyId, runToken });
}

function checkpoint(state: DemoState) {
    return {
        screen: state.screen,
        projectStage: state.projectStage,
        projectSelection: state.projectSelection,
        quickStage: state.quickStage,
        createIntent: state.createIntent,
        evolveStage: state.evolveStage,
        feedbackText: state.feedbackText,
        feedbackSaved: state.feedbackSaved,
        proposalFixtureLoaded: state.proposalFixtureLoaded,
        personalStage: state.personalStage,
        personalIntent: state.personalIntent,
        gate: state.gate,
        caption: state.caption,
        presentation: state.presentation,
        cueIndex: state.playback.cueIndex,
        phaseIndex: state.playback.phaseIndex,
    };
}

describe('semantic story compiler', () => {
    it('keeps the four stories in onboarding order with unique semantic beats and one final gate', () => {
        expect(STORIES.map((story) => story.id)).toEqual([
            'quick-create',
            'project-setup',
            'evolve-safely',
            'personal-flows',
        ]);
        for (const story of STORIES) {
            expect(new Set(story.beats.map((beat) => beat.id)).size).toBe(story.beats.length);
            const gated = story.beats.filter((beat) => beat.gate || beat.stop);
            expect(gated).toHaveLength(1);
            expect(gated[0]).toBe(story.beats.at(-1));
            expect(gated[0]?.gate).toBeDefined();
            expect(gated[0]?.stop).toBe(true);
        }
    });

    it('compiles deterministically with contiguous indexes and an exact derived duration', () => {
        for (const story of STORIES) {
            const first = compileStory(story);
            const second = compileStory(story);
            expect(first).toEqual(second);
            expect(first.map((phase) => phase.phaseIndex)).toEqual(first.map((_, index) => index));
            expect(first.reduce((total, phase) => total + phase.durationMs, 0)).toBe(story.durationMs);
            expect(first.at(-1)?.stop).toBe(true);
            expect(first.at(-1)?.gate).toBe(story.beats.at(-1)?.gate);
        }
    });

    it('uses restrained bounded pacing and only commits safe story setters', () => {
        for (const story of STORIES) {
            for (const phase of compileStory(story)) {
                if (phase.kind === 'focus') {
                    expect(phase.durationMs).toBeGreaterThanOrEqual(160);
                    expect(phase.durationMs).toBeLessThanOrEqual(240);
                } else if (phase.kind === 'dwell') {
                    expect(phase.durationMs).toBeGreaterThanOrEqual(450);
                    expect(phase.durationMs).toBeLessThanOrEqual(1_300);
                } else if (phase.kind === 'type') {
                    expect(phase.durationMs).toBeGreaterThanOrEqual(70);
                    expect(phase.durationMs).toBeLessThanOrEqual(110);
                    expect(phase.typingActive).toBe(true);
                } else if (phase.kind === 'settle') {
                    expect(phase.durationMs).toBeGreaterThanOrEqual(180);
                    expect(phase.durationMs).toBeLessThanOrEqual(320);
                } else {
                    expect(phase.kind).toBe('commit');
                    expect(phase.durationMs).toBe(0);
                }
                expect(phase.action === undefined || phase.kind === 'commit').toBe(true);
                expect(phase.gate === undefined || phase.completesBeat).toBe(true);
            }
        }
    });

    it('gives every focused target a human reading dwell before moving on', () => {
        for (const story of STORIES) {
            const phases = compileStory(story);
            for (const beat of story.beats) {
                const beatPhases = phases.filter((phase) => phase.beatId === beat.id);
                const focusPhases = beatPhases.filter((phase) => phase.kind === 'focus');
                expect(focusPhases.map((phase) => phase.focus)).toEqual(beat.focusPath ?? []);
                for (const focus of focusPhases) {
                    const index = beatPhases.findIndex((phase) => phase.id === focus.id);
                    expect(beatPhases[index + 1]).toMatchObject({
                        kind: 'dwell',
                        focus: focus.focus,
                    });
                }
            }
        }
    });

    it('reveals typing in bounded deterministic grapheme chunks and never gates a write action', () => {
        for (const story of STORIES) {
            const phases = compileStory(story);
            for (const beat of story.beats) {
                const typing = phases.filter((phase) => phase.beatId === beat.id && phase.kind === 'type');
                if (!beat.typing) {
                    expect(typing).toHaveLength(0);
                    continue;
                }
                let previous = '';
                for (const phase of typing) {
                    expect(phase.typingText.startsWith(previous)).toBe(true);
                    const added = Array.from(phase.typingText).length - Array.from(previous).length;
                    expect(added).toBeGreaterThanOrEqual(1);
                    expect(added).toBeLessThanOrEqual(4);
                    previous = phase.typingText;
                }
                expect(previous).toBe(beat.typing.text);
                const duration = typing.reduce((total, phase) => total + phase.durationMs, 0);
                expect(duration).toBeGreaterThanOrEqual(800);
                expect(duration).toBeLessThanOrEqual(2_000);
            }
            const gate = phases.at(-1)!;
            expect(gate.action).toBeUndefined();
            expect(gate.kind).toBe('settle');
        }
    });
});

describe('phase playback and semantic navigation', () => {
    it('autoplays every story through human phases and stops immediately before its gate', () => {
        const expected = {
            'project-setup': 'project-go',
            'quick-create': 'quick-create-enter',
            'evolve-safely': 'evolve-apply',
            'personal-flows': 'personal-create-enter',
        } as const;
        for (const story of STORIES) {
            const stopped = runStory(story.id);
            expect(stopped.gate).toBe(expected[story.id]);
            expect(stopped.playback.status).toBe('complete');
            expect(stopped.playback.cueIndex).toBe(story.beats.length);
            expect(currentPhase(stopped)).toBeUndefined();
            expect(currentBeat(stopped)).toBeUndefined();
            expect(hasGateOutcome(stopped)).toBe(false);
        }
    });

    it('manual Next completes one whole beat while Previous reconstructs one checkpoint', () => {
        let state = initialDemoState('quick-create');
        expect(currentBeat(state)?.id).toBe('quick-empty');
        state = nextBeat(state);
        expect(state.playback.cueIndex).toBe(1);
        expect(state.playback.status).toBe('paused');
        expect(state.playback.takenOver).toBe(true);
        expect(currentBeat(state)?.id).toBe('quick-command');

        const afterFirst = checkpoint(state);
        state = nextBeat(state);
        expect(state.playback.cueIndex).toBe(2);
        state = previousBeat(state);
        expect(checkpoint(state)).toEqual(afterFirst);
    });

    it('round-trips every checkpoint of all four stories through Previous and Next', () => {
        for (const story of STORIES) {
            let state = initialDemoState(story.id);
            const checkpoints: DemoState[] = [state];
            while (canNextBeat(state)) {
                state = nextBeat(state);
                checkpoints.push(state);
            }
            for (let index = checkpoints.length - 1; index > 0; index -= 1) {
                const prior = previousBeat(checkpoints[index]!);
                expect(checkpoint(prior)).toEqual(checkpoint(checkpoints[index - 1]!));
                const forward = nextBeat(prior);
                expect(checkpoint(forward)).toEqual(checkpoint(checkpoints[index]!));
            }
        }
    });

    it('rejects stale story, token, beat, and phase tuples', () => {
        const state = initialDemoState('project-setup', true);
        const run = currentRun(state);
        const variants = [
            { ...run, storyId: 'quick-create' as const },
            { ...run, runToken: run.runToken + 1 },
            { ...run, cueIndex: run.cueIndex + 1 },
            { ...run, phaseIndex: run.phaseIndex + 1 },
        ];
        for (const stale of variants) {
            expect(demoReducer(state, { type: 'ADVANCE_PHASE', ...stale })).toEqual(state);
        }

        const selected = demoReducer(state, { type: 'SELECT_STORY', storyId: 'quick-create' });
        expect(demoReducer(selected, { type: 'NEXT_BEAT', storyId: run.storyId, runToken: run.runToken })).toEqual(selected);
        expect(demoReducer(selected, { type: 'PREVIOUS_BEAT', storyId: run.storyId, runToken: run.runToken })).toEqual(selected);
    });

    it('exposes the full scheduler tuple including reducer-owned phaseIndex', () => {
        const state = initialDemoState('project-setup', true);
        expect(currentRun(state)).toEqual({
            storyId: 'project-setup',
            runToken: 1,
            cueIndex: 0,
            phaseIndex: 0,
        });
        const advanced = demoReducer(state, { type: 'ADVANCE_PHASE', ...currentRun(state) });
        expect(advanced.playback.phaseIndex).toBe(1);
        expect(advanced.playback.cueIndex).toBe(0);
    });
});

describe('draft preservation and hard write boundaries', () => {
    it('preserves user drafts across rewind and scripted forward movement, but Restart clears them', () => {
        let state = initialDemoState('quick-create');
        state = demoReducer(state, { type: 'SET_CREATE_INTENT', intent: 'My custom release ritual' });
        state = nextBeat(nextBeat(nextBeat(nextBeat(state))));
        expect(state.createIntent).toBe('My custom release ritual');

        state = previousBeat(previousBeat(state));
        expect(state.quickStage).toBe('command');
        expect(state.createIntent).toBe('My custom release ritual');
        state = nextBeat(nextBeat(state));
        expect(state.createIntent).toBe('My custom release ritual');
        expect(state.presentation.typingActive).toBe(false);

        state = demoReducer(state, { type: 'RESTART' });
        expect(state.createIntent).toBe('');
        expect(state.createIntentEdited).toBe(false);
        expect(state.playback.cueIndex).toBe(0);
        expect(state.playback.phaseIndex).toBe(0);
    });

    it('rebuildAtBeat is pure and keeps all user-authored fields as a hidden overlay', () => {
        const drafts = {
            createIntent: 'Custom project draft',
            createIntentEdited: true,
            personalIntent: 'Custom personal draft',
            personalIntentEdited: true,
            feedbackText: 'Custom evidence',
            feedbackEdited: true,
        };
        expect(rebuildAtBeat('quick-create', 1, drafts, 9)).toEqual(rebuildAtBeat('quick-create', 1, drafts, 9));
        const early = rebuildAtBeat('quick-create', 1, drafts, 9);
        expect(early.quickStage).toBe('empty');
        expect(early.createIntent).toBe('Custom project draft');
        expect(early.createIntentEdited).toBe(true);
    });

    it('disables rewind after a gate outcome and requires an explicit stale-guarded reset', () => {
        let state = runStory('quick-create');
        state = demoReducer(state, { type: 'CONTINUE_SAMPLE', ...currentRun(state) });
        expect(state.createSaved).toBe(true);
        expect(hasGateOutcome(state)).toBe(true);
        expect(canPreviousBeat(state)).toBe(false);
        expect(canResetGateResult(state)).toBe(true);

        const before = state;
        state = demoReducer(state, {
            type: 'PREVIOUS_BEAT',
            storyId: state.storyId,
            runToken: state.playback.runToken,
        });
        expect(state).toEqual(before);
        state = demoReducer(state, {
            type: 'RESET_GATE_RESULT',
            storyId: state.storyId,
            runToken: state.playback.runToken + 1,
        });
        expect(state).toEqual(before);

        state = demoReducer(state, { type: 'RESET_GATE_RESULT', ...currentRun(state) });
        expect(state.createSaved).toBe(false);
        expect(state.savedFlow).toBeNull();
        expect(state.quickStage).toBe('enter-boundary');
        expect(state.gate).toBe('quick-create-enter');
        expect(state.playback.status).toBe('complete');
        expect(canPreviousBeat(state)).toBe(true);
    });

    it('stops setup/create/personal before writes and gives new flows no fake proof', () => {
        const project = runStory('project-setup');
        expect(canContinueSample(project)).toBe(true);
        expect(demoReducer(project, { type: 'CONTINUE_SAMPLE', ...currentRun(project) }).projectStage).toBe('receipt');

        const quick = demoReducer(runStory('quick-create'), {
            type: 'CONTINUE_SAMPLE',
            ...currentRun(runStory('quick-create')),
        });
        expect(quick.savedFlow).toMatchObject({
            slug: slugifyIntent(QUICK_CREATE_INTENT),
            evidence: 'no feedback yet',
            evaluation: 'not evaluated',
            scope: 'project',
        });

        const personalStopped = runStory('personal-flows');
        const personal = demoReducer(personalStopped, {
            type: 'CONTINUE_SAMPLE',
            ...currentRun(personalStopped),
        });
        expect(personal.savedPersonalFlow).toMatchObject({ scope: 'personal', evaluation: 'not evaluated' });
        expect(personal.presentation.focus).toBe('personal-resolution');
        expect(allDemoFlows(personal).at(-1)?.scope).toBe('personal');
    });

    it('keeps apply and rollback behind explicit confirmation and reset returns to the decision gate', () => {
        let state = runStory('evolve-safely');
        expect(state.evolveStage).toBe('decision');
        expect(state.gate).toBe('evolve-apply');
        expect(canContinueSample(state)).toBe(false);
        state = demoReducer(state, { type: 'REQUEST_APPLY' });
        state = demoReducer(state, { type: 'APPLY_FIXTURE' });
        expect(state.evolveStage).toBe('applied');
        expect(canPreviousBeat(state)).toBe(false);
        state = demoReducer(state, { type: 'RESET_GATE_RESULT', ...currentRun(state) });
        expect(state.evolveStage).toBe('decision');
        expect(state.gate).toBe('evolve-apply');
        expect(state.confirmAction).toBeNull();
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
