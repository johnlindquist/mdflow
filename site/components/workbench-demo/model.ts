import {
    EVOLUTION_FIXTURE,
    MOCK_FLOWS,
    PERSONAL_CREATE_INTENT,
    QUICK_CREATE_INTENT,
    type DemoFlow,
} from './fixtures';
import {
    storyFor,
    type EvolveStage,
    type PersonalFlowStage,
    type ProjectSetupStage,
    type QuickCreateStage,
    type StoryCueAction,
    type StoryGate,
    type StoryId,
    type TimelineCue,
} from './stories';

export type { DemoFlow } from './fixtures';
export type {
    EvolveStage,
    PersonalFlowStage,
    ProjectSetupStage,
    QuickCreateStage,
    StoryDefinition,
    StoryGate,
    StoryId,
    TimelineCue,
} from './stories';
export { MOCK_FLOWS } from './fixtures';
export { STORIES, STORY_BY_ID, STORY_IDS, storyFor } from './stories';

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
    playback: {
        status: PlaybackStatus;
        cueIndex: number;
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
        playback: {
            status: play ? 'playing' : 'idle',
            cueIndex: 0,
            takenOver: false,
            runToken,
        },
    };
}

export function initialDemoState(storyId: StoryId = 'project-setup', play = false): DemoState {
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
    | { type: 'TIMELINE_CUE'; storyId: StoryId; runToken: number; cueIndex: number }
    | { type: 'STEP_CUE'; storyId: StoryId; runToken: number; cueIndex: number }
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
            };
        case 'SAVE_FEEDBACK':
            return state.feedbackText.trim()
                ? {
                    ...state,
                    evolveStage: 'feedback-saved',
                    feedbackSaved: true,
                    caption: 'Feedback saved to browser memory only. P previews readiness for free.',
                }
                : state;
        case 'CANCEL_FEEDBACK':
            return state.evolveStage === 'feedback'
                ? {
                    ...state,
                    evolveStage: state.proposalFixtureLoaded ? 'decision' : 'sample-result',
                    feedbackText: '',
                    feedbackSaved: false,
                    caption: 'Feedback cancelled. No evidence was recorded.',
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
            };
        case 'SHOW_DIFF':
            return state.proposalFixtureLoaded
                ? { ...state, evolveStage: 'diff', confirmAction: null }
                : state;
        case 'SHOW_DECISION':
            return state.proposalFixtureLoaded
                ? { ...state, evolveStage: 'decision', confirmAction: null }
                : state;
        case 'REQUEST_APPLY':
            return state.proposalFixtureLoaded && ['proposal', 'diff', 'decision'].includes(state.evolveStage)
                ? {
                    ...state,
                    evolveStage: 'decision',
                    confirmAction: 'apply',
                    caption: 'Apply confirmation open. Enter or C confirms; Escape cancels.',
                }
                : state;
        case 'REQUEST_ROLLBACK':
            return state.evolveStage === 'applied'
                ? {
                    ...state,
                    confirmAction: 'rollback',
                    caption: 'Rollback confirmation open. Enter or C confirms; Escape cancels.',
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
                }
                : state;
        case 'ROLLBACK_FIXTURE':
            return state.confirmAction === 'rollback'
                ? {
                    ...state,
                    evolveStage: 'rolled-back',
                    confirmAction: null,
                    caption: 'Rolled back in browser memory only. No source file changed.',
                }
                : state;
        case 'CANCEL_CONFIRM':
            return state.confirmAction
                ? {
                    ...state,
                    confirmAction: null,
                    caption: 'Local-write confirmation cancelled. Demo state is unchanged.',
                }
                : state;
    }
}

function applyCue(state: DemoState, cue: TimelineCue, manual: boolean): DemoState {
    const next = reduceStoryAction(state, cue.action, true);
    return {
        ...next,
        gate: cue.gate ?? null,
        caption: cue.caption ?? state.caption,
        playback: {
            ...state.playback,
            cueIndex: state.playback.cueIndex + 1,
            status: cue.stop ? 'complete' : manual ? state.playback.status : 'playing',
            takenOver: manual || state.playback.takenOver,
        },
    };
}

function matchingRun(
    state: DemoState,
    action: { storyId: StoryId; runToken: number; cueIndex?: number },
): boolean {
    return action.storyId === state.storyId
        && action.runToken === state.playback.runToken
        && (action.cueIndex === undefined || action.cueIndex === state.playback.cueIndex);
}

export function currentCue(state: DemoState): TimelineCue | undefined {
    return storyFor(state.storyId).cues[state.playback.cueIndex];
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
            return state.playback.status === 'complete'
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
        case 'TIMELINE_CUE': {
            if (state.playback.status !== 'playing' || !matchingRun(state, action)) return state;
            const cue = currentCue(state);
            return cue ? applyCue(state, cue, false) : state;
        }
        case 'STEP_CUE': {
            if (state.playback.status === 'playing' || state.playback.status === 'complete' || !matchingRun(state, action)) {
                return state;
            }
            const cue = currentCue(state);
            return cue ? applyCue(state, cue, true) : state;
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
export function currentRun(state: DemoState): Pick<DemoState, 'storyId'> & { runToken: number; cueIndex: number } {
    return {
        storyId: state.storyId,
        runToken: state.playback.runToken,
        cueIndex: state.playback.cueIndex,
    };
}

/** The proposal fixture is exported indirectly through state/rendering; this guards accidental drift in tests. */
export const DEMO_PROPOSAL_ID = EVOLUTION_FIXTURE.proposalId;
