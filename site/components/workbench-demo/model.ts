import {
    EVOLUTION_FIXTURE,
    MOCK_FLOWS,
    PERSONAL_CREATE_INTENT,
    QUICK_CREATE_INTENT,
    type DemoFlow,
} from './fixtures';
import {
    compileStory,
    STORY_IDS,
    storyFor,
    type CompiledPhase,
    type EvolveStage,
    type FocusTarget,
    type PersonalFlowStage,
    type ProjectSetupStage,
    type QuickCreateStage,
    type StoryBeat,
    type StoryCueAction,
    type StoryGate,
    type StoryId,
    type TypingField,
} from './stories';

export type { DemoFlow } from './fixtures';
export type {
    EvolveStage,
    FocusTarget,
    PersonalFlowStage,
    ProjectSetupStage,
    QuickCreateStage,
    CompiledPhase,
    StoryBeat,
    StoryDefinition,
    StoryGate,
    StoryId,
    TypingField,
} from './stories';
export { MOCK_FLOWS } from './fixtures';
export { compileStory, STORIES, STORY_BY_ID, STORY_IDS, storyFor } from './stories';

export type DemoScreen = 'project-setup' | 'quick-create' | 'improve' | 'personal-flows';
export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'complete';

export interface DemoState {
    storyId: StoryId;
    screen: DemoScreen;
    projectStage: ProjectSetupStage;
    projectSelection: number[];
    quickStage: QuickCreateStage;
    createIntent: string;
    createIntentEdited: boolean;
    createSaved: boolean;
    evolveStage: EvolveStage;
    feedbackText: string;
    feedbackEdited: boolean;
    feedbackSaved: boolean;
    proposalFixtureLoaded: boolean;
    confirmAction: 'apply' | 'rollback' | null;
    personalStage: PersonalFlowStage;
    personalIntent: string;
    personalIntentEdited: boolean;
    personalSaved: boolean;
    savedFlow: DemoFlow | null;
    savedPersonalFlow: DemoFlow | null;
    gate: StoryGate | null;
    caption: string;
    /** Presentation is reducer-owned so timing, rewind, and screenshots agree. */
    presentation: {
        focus: FocusTarget | null;
        typingField: TypingField | null;
        typingText: string;
        typingActive: boolean;
    };
    playback: {
        status: PlaybackStatus;
        /** Number of fully completed semantic beats. */
        cueIndex: number;
        /** Absolute cursor into the story's compiled phase array. */
        phaseIndex: number;
        takenOver: boolean;
        /** Changes whenever a timer from a prior run must become invalid. */
        runToken: number;
    };
}

function screenForStory(storyId: StoryId): DemoScreen {
    if (storyId === 'evolve-safely') return 'improve';
    return storyId;
}

function baseState(storyId: StoryId, play: boolean, runToken: number): DemoState {
    return {
        storyId,
        screen: screenForStory(storyId),
        projectStage: 'command',
        projectSelection: [],
        quickStage: 'empty',
        createIntent: '',
        createIntentEdited: false,
        createSaved: false,
        evolveStage: 'sample-result',
        feedbackText: '',
        feedbackEdited: false,
        feedbackSaved: false,
        proposalFixtureLoaded: false,
        confirmAction: null,
        personalStage: 'command',
        personalIntent: '',
        personalIntentEdited: false,
        personalSaved: false,
        savedFlow: null,
        savedPersonalFlow: null,
        gate: null,
        caption: play
            ? storyFor(storyId).startCaption
            : `${storyFor(storyId).shortTitle} ready. Use Play or step through it manually.`,
        presentation: {
            focus: null,
            typingField: null,
            typingText: '',
            typingActive: false,
        },
        playback: {
            status: play ? 'playing' : 'idle',
            cueIndex: 0,
            phaseIndex: 0,
            takenOver: false,
            runToken,
        },
    };
}

export function initialDemoState(storyId: StoryId = 'quick-create', play = false): DemoState {
    return baseState(storyId, play, 1);
}

export function slugifyIntent(value: string): string {
    const normalized = value
        .normalize('NFKD')
        .replace(/\p{Mark}/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56)
        .replace(/-+$/g, '');
    const slug = normalized || 'new-flow';
    return slug === 'readme' ? 'readme-flow' : slug;
}

/** Match the real Workbench's POSIX-safe command display quoting. */
export function shellQuote(value: string): string {
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function flowFromIntent(intent: string, scope: 'project' | 'personal' = 'project'): DemoFlow {
    return {
        slug: slugifyIntent(intent),
        description: intent.trim(),
        engine: scope === 'personal' ? 'engine ladder / project config where run' : 'project default',
        evidence: 'no feedback yet',
        evaluation: 'not evaluated',
        scope,
    };
}

export function allDemoFlows(state: DemoState): DemoFlow[] {
    return [
        ...MOCK_FLOWS,
        ...(state.savedFlow ? [state.savedFlow] : []),
        ...(state.savedPersonalFlow ? [state.savedPersonalFlow] : []),
    ];
}

export type ManualDomainAction =
    | { type: 'SHOW_FEEDBACK' }
    | { type: 'SAVE_FEEDBACK' }
    | { type: 'CANCEL_FEEDBACK' }
    | { type: 'PLAN' }
    | { type: 'LOAD_PROPOSAL_FIXTURE' }
    | { type: 'SHOW_DIFF' }
    | { type: 'SHOW_DECISION' }
    | { type: 'REQUEST_APPLY' }
    | { type: 'REQUEST_ROLLBACK' }
    | { type: 'APPLY_FIXTURE' }
    | { type: 'ROLLBACK_FIXTURE' }
    | { type: 'CANCEL_CONFIRM' };

export type DemoAction =
    | StoryCueAction
    | ManualDomainAction
    | { type: 'SELECT_STORY'; storyId: StoryId }
    | { type: 'TAKE_OVER' }
    | { type: 'PLAY' }
    | { type: 'PAUSE' }
    | { type: 'RESTART'; play?: boolean }
    | {
        type: 'ADVANCE_PHASE';
        storyId: StoryId;
        runToken: number;
        cueIndex: number;
        phaseIndex: number;
    }
    | { type: 'NEXT_BEAT'; storyId: StoryId; runToken: number }
    | { type: 'PREVIOUS_BEAT'; storyId: StoryId; runToken: number }
    | { type: 'RESET_GATE_RESULT'; storyId: StoryId; runToken: number }
    | { type: 'CONTINUE_SAMPLE'; storyId: StoryId; runToken: number };

function reduceStoryAction(state: DemoState, action: StoryCueAction, fromCue = false): DemoState {
    switch (action.type) {
        case 'SET_PROJECT_STAGE':
            return {
                ...state,
                screen: 'project-setup',
                projectStage: action.stage,
            };
        case 'SET_PROJECT_SELECTION':
            return {
                ...state,
                screen: 'project-setup',
                projectStage: 'selection',
                projectSelection: [...action.selected],
            };
        case 'SET_QUICK_STAGE':
            return {
                ...state,
                screen: 'quick-create',
                quickStage: action.stage,
            };
        case 'SET_CREATE_INTENT':
            return {
                ...state,
                screen: 'quick-create',
                quickStage: 'answer',
                createIntent: fromCue && state.createIntentEdited
                    ? state.createIntent
                    : action.intent.slice(0, 120),
                createIntentEdited: fromCue ? state.createIntentEdited : true,
                createSaved: false,
                presentation: fromCue
                    ? state.presentation
                    : { focus: 'intent-input', typingField: null, typingText: '', typingActive: false },
            };
        case 'SET_EVOLVE_STAGE':
            return {
                ...state,
                screen: 'improve',
                evolveStage: action.stage,
                feedbackSaved: action.stage === 'feedback-saved' || state.feedbackSaved,
                proposalFixtureLoaded: ['proposal', 'diff', 'decision'].includes(action.stage)
                    || state.proposalFixtureLoaded,
                confirmAction: null,
            };
        case 'SET_FEEDBACK':
            return {
                ...state,
                screen: 'improve',
                evolveStage: 'feedback',
                feedbackText: fromCue && state.feedbackEdited
                    ? state.feedbackText
                    : action.feedback.slice(0, 160),
                feedbackEdited: fromCue ? state.feedbackEdited : true,
                feedbackSaved: false,
                presentation: fromCue
                    ? state.presentation
                    : { focus: 'feedback-input', typingField: null, typingText: '', typingActive: false },
            };
        case 'SET_PERSONAL_STAGE':
            return {
                ...state,
                screen: 'personal-flows',
                personalStage: action.stage,
            };
        case 'SET_PERSONAL_INTENT':
            return {
                ...state,
                screen: 'personal-flows',
                personalStage: 'answer',
                personalIntent: fromCue && state.personalIntentEdited
                    ? state.personalIntent
                    : action.intent.slice(0, 120),
                personalIntentEdited: fromCue ? state.personalIntentEdited : true,
                personalSaved: false,
                presentation: fromCue
                    ? state.presentation
                    : { focus: 'intent-input', typingField: null, typingText: '', typingActive: false },
            };
    }
}

function reduceManualAction(state: DemoState, action: ManualDomainAction): DemoState {
    switch (action.type) {
        case 'SHOW_FEEDBACK':
            return {
                ...state,
                storyId: 'evolve-safely',
                screen: 'improve',
                evolveStage: 'feedback',
                feedbackSaved: false,
                confirmAction: null,
                caption: 'F opened feedback. Describe an observed miss; evidence is not proof.',
                presentation: { focus: 'feedback-input', typingField: null, typingText: '', typingActive: false },
            };
        case 'SAVE_FEEDBACK':
            return state.feedbackText.trim()
                ? {
                    ...state,
                    evolveStage: 'feedback-saved',
                    feedbackSaved: true,
                    caption: 'Feedback saved to browser memory only. P previews readiness for free.',
                    presentation: { focus: 'feedback-input', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'CANCEL_FEEDBACK':
            return state.evolveStage === 'feedback'
                ? {
                    ...state,
                    evolveStage: state.proposalFixtureLoaded ? 'decision' : 'sample-result',
                    feedbackText: '',
                    feedbackEdited: false,
                    feedbackSaved: false,
                    caption: 'Feedback cancelled. No evidence was recorded.',
                    presentation: {
                        focus: state.proposalFixtureLoaded ? 'decision' : 'sample-result',
                        typingField: null,
                        typingText: '',
                        typingActive: false,
                    },
                }
                : state;
        case 'PLAN':
            return {
                ...state,
                storyId: 'evolve-safely',
                screen: 'improve',
                evolveStage: 'plan',
                confirmAction: null,
                caption: 'P opened the free readiness plan. No engine ran and no source changed.',
                presentation: { focus: 'plan', typingField: null, typingText: '', typingActive: false },
            };
        case 'LOAD_PROPOSAL_FIXTURE':
            return {
                ...state,
                storyId: 'evolve-safely',
                screen: 'improve',
                evolveStage: 'proposal',
                proposalFixtureLoaded: true,
                confirmAction: null,
                caption: 'O loaded a precomputed proposal fixture. The browser did not run or verify it.',
                presentation: { focus: 'proposal', typingField: null, typingText: '', typingActive: false },
            };
        case 'SHOW_DIFF':
            return state.proposalFixtureLoaded
                ? {
                    ...state,
                    evolveStage: 'diff',
                    confirmAction: null,
                    presentation: { focus: 'diff', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'SHOW_DECISION':
            return state.proposalFixtureLoaded
                ? {
                    ...state,
                    evolveStage: 'decision',
                    confirmAction: null,
                    presentation: { focus: 'decision', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'REQUEST_APPLY':
            return state.proposalFixtureLoaded && ['proposal', 'diff', 'decision'].includes(state.evolveStage)
                ? {
                    ...state,
                    evolveStage: 'decision',
                    confirmAction: 'apply',
                    caption: 'Apply confirmation open. Enter or C confirms; Escape cancels.',
                    presentation: { focus: 'confirmation', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'REQUEST_ROLLBACK':
            return state.evolveStage === 'applied'
                ? {
                    ...state,
                    confirmAction: 'rollback',
                    caption: 'Rollback confirmation open. Enter or C confirms; Escape cancels.',
                    presentation: { focus: 'confirmation', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'APPLY_FIXTURE':
            return state.confirmAction === 'apply'
                ? {
                    ...state,
                    evolveStage: 'applied',
                    confirmAction: null,
                    gate: null,
                    caption: 'Applied in browser memory only. No source file changed.',
                    presentation: { focus: 'confirmation', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'ROLLBACK_FIXTURE':
            return state.confirmAction === 'rollback'
                ? {
                    ...state,
                    evolveStage: 'rolled-back',
                    confirmAction: null,
                    caption: 'Rolled back in browser memory only. No source file changed.',
                    presentation: { focus: 'confirmation', typingField: null, typingText: '', typingActive: false },
                }
                : state;
        case 'CANCEL_CONFIRM':
            return state.confirmAction
                ? {
                    ...state,
                    confirmAction: null,
                    caption: 'Local-write confirmation cancelled. Demo state is unchanged.',
                    presentation: { focus: 'decision', typingField: null, typingText: '', typingActive: false },
                }
                : state;
    }
}

const COMPILED_STORIES = Object.fromEntries(
    STORY_IDS.map((storyId) => [storyId, compileStory(storyFor(storyId))]),
) as Record<StoryId, CompiledPhase[]>;

export interface UserDrafts {
    createIntent: string;
    createIntentEdited: boolean;
    personalIntent: string;
    personalIntentEdited: boolean;
    feedbackText: string;
    feedbackEdited: boolean;
}

function draftsFrom(state: DemoState): UserDrafts {
    return {
        createIntent: state.createIntent,
        createIntentEdited: state.createIntentEdited,
        personalIntent: state.personalIntent,
        personalIntentEdited: state.personalIntentEdited,
        feedbackText: state.feedbackText,
        feedbackEdited: state.feedbackEdited,
    };
}

function editedDraft(state: DemoState, field: TypingField | null): string | null {
    if (field === 'createIntent' && state.createIntentEdited) return state.createIntent;
    if (field === 'personalIntent' && state.personalIntentEdited) return state.personalIntent;
    if (field === 'feedbackText' && state.feedbackEdited) return state.feedbackText;
    return null;
}

function applyPhase(state: DemoState, phase: CompiledPhase): DemoState {
    const withAction = phase.action ? reduceStoryAction(state, phase.action, true) : state;
    const draft = editedDraft(withAction, phase.typingField);
    return {
        ...withAction,
        gate: phase.gate ?? withAction.gate,
        caption: phase.caption ?? withAction.caption,
        presentation: {
            focus: phase.focus,
            typingField: phase.typingField,
            typingText: draft ?? phase.typingText,
            typingActive: draft === null && phase.typingActive,
        },
        playback: {
            ...withAction.playback,
            cueIndex: withAction.playback.cueIndex + (phase.completesBeat ? 1 : 0),
            phaseIndex: withAction.playback.phaseIndex + 1,
            status: phase.stop ? 'complete' : withAction.playback.status,
        },
    };
}

function phasesThroughBeat(storyId: StoryId, completedBeatCount: number): number {
    const phases = COMPILED_STORIES[storyId];
    let phaseCount = 0;
    for (const phase of phases) {
        if (phase.beatIndex >= completedBeatCount) break;
        phaseCount += 1;
    }
    return phaseCount;
}

/** Reconstruct a semantic checkpoint from absolute safe setters, never inverse actions. */
export function rebuildAtBeat(
    storyId: StoryId,
    completedBeatCount: number,
    drafts: UserDrafts,
    runToken: number,
): DemoState {
    const story = storyFor(storyId);
    const target = Math.max(0, Math.min(completedBeatCount, story.beats.length));
    let rebuilt = baseState(storyId, false, runToken);
    const phaseCount = phasesThroughBeat(storyId, target);
    for (let index = 0; index < phaseCount; index += 1) {
        rebuilt = applyPhase(rebuilt, COMPILED_STORIES[storyId][index]!);
    }

    rebuilt = {
        ...rebuilt,
        createIntent: drafts.createIntentEdited ? drafts.createIntent : rebuilt.createIntent,
        createIntentEdited: drafts.createIntentEdited,
        personalIntent: drafts.personalIntentEdited ? drafts.personalIntent : rebuilt.personalIntent,
        personalIntentEdited: drafts.personalIntentEdited,
        feedbackText: drafts.feedbackEdited ? drafts.feedbackText : rebuilt.feedbackText,
        feedbackEdited: drafts.feedbackEdited,
        presentation: {
            ...rebuilt.presentation,
            typingText: rebuilt.presentation.typingField === 'createIntent' && drafts.createIntentEdited
                ? drafts.createIntent
                : rebuilt.presentation.typingField === 'personalIntent' && drafts.personalIntentEdited
                    ? drafts.personalIntent
                    : rebuilt.presentation.typingField === 'feedbackText' && drafts.feedbackEdited
                        ? drafts.feedbackText
                        : rebuilt.presentation.typingText,
            typingActive: false,
        },
        playback: {
            ...rebuilt.playback,
            status: rebuilt.gate ? 'complete' : 'paused',
            takenOver: true,
        },
    };
    return rebuilt;
}

function matchingRun(
    state: DemoState,
    action: { storyId: StoryId; runToken: number; cueIndex?: number; phaseIndex?: number },
): boolean {
    return action.storyId === state.storyId
        && action.runToken === state.playback.runToken
        && (action.cueIndex === undefined || action.cueIndex === state.playback.cueIndex)
        && (action.phaseIndex === undefined || action.phaseIndex === state.playback.phaseIndex);
}

export function currentPhase(state: DemoState): CompiledPhase | undefined {
    return COMPILED_STORIES[state.storyId][state.playback.phaseIndex];
}

export function currentBeat(state: DemoState): StoryBeat | undefined {
    return storyFor(state.storyId).beats[state.playback.cueIndex];
}

/** Compatibility name: a cue is now one semantic beat, not a timer frame. */
export const currentCue = currentBeat;

export function hasGateOutcome(state: DemoState): boolean {
    return state.projectStage === 'receipt'
        || state.createSaved
        || state.personalSaved
        || state.evolveStage === 'applied'
        || state.evolveStage === 'rolled-back';
}

export function canPreviousBeat(state: DemoState): boolean {
    return !hasGateOutcome(state) && !state.confirmAction && state.playback.cueIndex > 0;
}

export function canNextBeat(state: DemoState): boolean {
    return !hasGateOutcome(state)
        && !state.confirmAction
        && !state.gate
        && state.playback.cueIndex < storyFor(state.storyId).beats.length;
}

export function canResetGateResult(state: DemoState): boolean {
    return hasGateOutcome(state);
}

export function canContinueSample(state: DemoState): boolean {
    return state.gate === 'project-go'
        || state.gate === 'quick-create-enter'
        || state.gate === 'personal-create-enter';
}

function continueSample(state: DemoState): DemoState {
    if (state.gate === 'project-go') {
        return {
            ...state,
            projectStage: 'receipt',
            gate: null,
            caption: 'Sample continued after your click: mock receipt plus a free verification plan.',
            presentation: { focus: 'write-gate', typingField: null, typingText: '', typingActive: false },
        };
    }
    if (state.gate === 'quick-create-enter') {
        const intent = state.createIntent.trim() || QUICK_CREATE_INTENT;
        return {
            ...state,
            quickStage: 'receipt',
            createIntent: intent,
            createSaved: true,
            savedFlow: flowFromIntent(intent),
            gate: null,
            caption: 'Enter simulated a create-only project write in browser memory. The flow is not evaluated.',
            presentation: { focus: 'intent-input', typingField: null, typingText: '', typingActive: false },
        };
    }
    if (state.gate === 'personal-create-enter') {
        const intent = state.personalIntent.trim() || PERSONAL_CREATE_INTENT;
        return {
            ...state,
            personalStage: 'cross-project',
            personalIntent: intent,
            personalSaved: true,
            savedPersonalFlow: flowFromIntent(intent, 'personal'),
            gate: null,
            caption: 'Enter simulated a personal create, then a free resolution plan from another mock project.',
            presentation: { focus: 'personal-resolution', typingField: null, typingText: '', typingActive: false },
        };
    }
    return state;
}

export function demoReducer(state: DemoState, action: DemoAction): DemoState {
    switch (action.type) {
        case 'SELECT_STORY': {
            const next = baseState(action.storyId, false, state.playback.runToken + 1);
            return {
                ...next,
                playback: { ...next.playback, takenOver: true },
                caption: `${storyFor(action.storyId).shortTitle} selected. Press Play or Next step.`,
            };
        }
        case 'TAKE_OVER':
            return {
                ...state,
                playback: {
                    ...state.playback,
                    status: state.playback.status === 'complete' ? 'complete' : 'paused',
                    takenOver: true,
                },
                caption: state.playback.status === 'playing'
                    ? 'Autoplay paused. It will not resume unless you press Play.'
                    : state.caption,
            };
        case 'PLAY':
            return state.playback.status === 'complete' || !currentPhase(state)
                ? state
                : {
                    ...state,
                    gate: null,
                    caption: `${storyFor(state.storyId).shortTitle} playing. Interact to take over.`,
                    playback: { ...state.playback, status: 'playing' },
                };
        case 'PAUSE':
            return {
                ...state,
                caption: 'Walkthrough paused. Press Play when you want it to continue.',
                playback: { ...state.playback, status: 'paused' },
            };
        case 'RESTART': {
            const next = baseState(state.storyId, Boolean(action.play), state.playback.runToken + 1);
            return {
                ...next,
                playback: { ...next.playback, takenOver: !action.play },
                caption: action.play
                    ? `${storyFor(state.storyId).shortTitle} replay started.`
                    : `${storyFor(state.storyId).shortTitle} restarted. Press Play or Next step.`,
            };
        }
        case 'ADVANCE_PHASE': {
            if (state.playback.status !== 'playing' || !matchingRun(state, action)) return state;
            const phase = currentPhase(state);
            return phase ? applyPhase(state, phase) : state;
        }
        case 'NEXT_BEAT': {
            if (!matchingRun(state, action) || !canNextBeat(state)) return state;
            return rebuildAtBeat(
                state.storyId,
                state.playback.cueIndex + 1,
                draftsFrom(state),
                state.playback.runToken + 1,
            );
        }
        case 'PREVIOUS_BEAT': {
            if (!matchingRun(state, action) || !canPreviousBeat(state)) return state;
            return rebuildAtBeat(
                state.storyId,
                state.playback.cueIndex - 1,
                draftsFrom(state),
                state.playback.runToken + 1,
            );
        }
        case 'RESET_GATE_RESULT': {
            if (!matchingRun(state, action) || !canResetGateResult(state)) return state;
            const gateIndex = storyFor(state.storyId).beats.findIndex((beat) => beat.gate);
            const reset = rebuildAtBeat(
                state.storyId,
                Math.max(0, gateIndex + 1),
                draftsFrom(state),
                state.playback.runToken + 1,
            );
            return {
                ...reset,
                caption: 'Demo result reset. The write boundary is ready for a fresh decision.',
            };
        }
        case 'CONTINUE_SAMPLE':
            return matchingRun(state, action) ? continueSample(state) : state;
        case 'SHOW_FEEDBACK':
        case 'SAVE_FEEDBACK':
        case 'CANCEL_FEEDBACK':
        case 'PLAN':
        case 'LOAD_PROPOSAL_FIXTURE':
        case 'SHOW_DIFF':
        case 'SHOW_DECISION':
        case 'REQUEST_APPLY':
        case 'REQUEST_ROLLBACK':
        case 'APPLY_FIXTURE':
        case 'ROLLBACK_FIXTURE':
        case 'CANCEL_CONFIRM':
            return reduceManualAction(state, action);
        default:
            return reduceStoryAction(state, action);
    }
}

/** Useful for controls that dispatch metadata without reaching into state shape. */
export function currentRun(state: DemoState): Pick<DemoState, 'storyId'> & {
    runToken: number;
    cueIndex: number;
    phaseIndex: number;
} {
    return {
        storyId: state.storyId,
        runToken: state.playback.runToken,
        cueIndex: state.playback.cueIndex,
        phaseIndex: state.playback.phaseIndex,
    };
}

/** The proposal fixture is exported indirectly through state/rendering; this guards accidental drift in tests. */
export const DEMO_PROPOSAL_ID = EVOLUTION_FIXTURE.proposalId;
