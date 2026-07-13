export const STORY_IDS = [
    'quick-create',
    'project-setup',
    'evolve-safely',
    'personal-flows',
] as const;

export type StoryId = (typeof STORY_IDS)[number];

export type ProjectSetupStage =
    | 'command'
    | 'consent'
    | 'inspection'
    | 'suggestions'
    | 'selection'
    | 'approval'
    | 'receipt';

export type QuickCreateStage = 'empty' | 'command' | 'question' | 'answer' | 'enter-boundary' | 'receipt';
export type EvolveStage =
    | 'sample-result'
    | 'feedback'
    | 'feedback-saved'
    | 'plan'
    | 'proposal'
    | 'diff'
    | 'decision'
    | 'applied'
    | 'rolled-back';
export type PersonalFlowStage =
    | 'command'
    | 'question'
    | 'answer'
    | 'enter-boundary'
    | 'cross-project';

export type StoryGate = 'project-go' | 'quick-create-enter' | 'evolve-apply' | 'personal-create-enter';

export type FocusTarget =
    | 'shell-command'
    | 'consent-agent'
    | 'consent-launch'
    | `suggestion-${1 | 2 | 3 | 4}`
    | 'selection-reply'
    | 'intent-input'
    | 'sample-result'
    | 'feedback-input'
    | 'plan'
    | 'proposal'
    | 'diff'
    | 'decision'
    | 'confirmation'
    | 'personal-resolution'
    | 'write-gate';

export type TypingField = 'createIntent' | 'personalIntent' | 'feedbackText';
export type BeatPacing = 'scan' | 'read' | 'type' | 'settle';
export type PhaseKind = 'focus' | 'dwell' | 'type' | 'commit' | 'settle';

/** Safe, absolute setters that may be committed by a compiled autoplay phase. */
export type StoryCueAction =
    | { type: 'SET_PROJECT_STAGE'; stage: ProjectSetupStage }
    | { type: 'SET_PROJECT_SELECTION'; selected: readonly number[] }
    | { type: 'SET_QUICK_STAGE'; stage: QuickCreateStage }
    | { type: 'SET_CREATE_INTENT'; intent: string }
    | { type: 'SET_EVOLVE_STAGE'; stage: EvolveStage }
    | { type: 'SET_FEEDBACK'; feedback: string }
    | { type: 'SET_PERSONAL_STAGE'; stage: PersonalFlowStage }
    | { type: 'SET_PERSONAL_INTENT'; intent: string };

export interface StoryBeat {
    /** Stable semantic checkpoint used by controls, screenshots, and recording. */
    id: string;
    caption: string;
    action?: StoryCueAction;
    focusPath?: readonly FocusTarget[];
    pacing?: BeatPacing;
    typing?: {
        field: TypingField;
        text: string;
    };
    /** A gate is descriptive only: compiling it can never perform the gated write. */
    gate?: StoryGate;
    stop?: boolean;
}

export interface CompiledPhase {
    id: string;
    beatId: string;
    beatIndex: number;
    /** Absolute phase cursor within the compiled story. */
    phaseIndex: number;
    kind: PhaseKind;
    focus: FocusTarget | null;
    durationMs: number;
    typingField: TypingField | null;
    typingText: string;
    typingActive: boolean;
    /** Only commit phases carry a safe domain action. */
    action?: StoryCueAction;
    /** Captions and gates appear only at semantic beat completion. */
    caption?: string;
    completesBeat: boolean;
    stop?: boolean;
    gate?: StoryGate;
}

export interface StoryDefinition {
    id: StoryId;
    number: string;
    title: string;
    shortTitle: string;
    summary: string;
    keyHint: string;
    /** Deterministic sum of compiled phase durations. */
    durationMs: number;
    startCaption: string;
    continueLabel?: string;
    beats: readonly StoryBeat[];
}

type StorySource = Omit<StoryDefinition, 'durationMs'>;

function stableNumber(value: string): number {
    let result = 0;
    for (const character of value) result = (result * 31 + character.codePointAt(0)!) >>> 0;
    return result;
}

function boundedFromId(id: string, minimum: number, maximum: number): number {
    return minimum + (stableNumber(id) % (maximum - minimum + 1));
}

function dwellDuration(beat: StoryBeat): number {
    const words = beat.caption.trim().split(/\s+/).filter(Boolean).length;
    if (beat.pacing === 'scan') return Math.min(1_300, Math.max(900, 820 + words * 22));
    if (beat.pacing === 'settle') return 0;
    return Math.min(800, Math.max(450, 390 + words * 18));
}

function typingChunks(text: string): string[] {
    const graphemes = Array.from(text);
    const chunks: string[] = [];
    const chunkSize = graphemes.length > 42 ? 4 : 3;
    for (let end = chunkSize; end < graphemes.length; end += chunkSize) {
        chunks.push(graphemes.slice(0, end).join(''));
    }
    if (graphemes.length) chunks.push(graphemes.join(''));
    return chunks;
}

/**
 * Expand semantic beats into the only autoplay timeline.
 * Pure by construction: content and stable IDs are its only timing inputs.
 */
export function compileStory(story: Pick<StoryDefinition, 'id' | 'beats'>): CompiledPhase[] {
    const phases: CompiledPhase[] = [];

    story.beats.forEach((beat, beatIndex) => {
        let focus: FocusTarget | null = null;
        let typingField: TypingField | null = null;
        let typingText = '';
        const append = (phase: Omit<CompiledPhase, 'id' | 'beatId' | 'beatIndex' | 'phaseIndex'>) => {
            const phaseIndex = phases.length;
            phases.push({
                ...phase,
                id: `${beat.id}:${phase.kind}:${phaseIndex}`,
                beatId: beat.id,
                beatIndex,
                phaseIndex,
            });
        };

        // Stage setters paint the screen before its semantic rows receive focus.
        // Text setters wait until presentation-only typing has finished.
        if (beat.action && !beat.typing) {
            append({
                kind: 'commit',
                focus,
                durationMs: 0,
                typingField,
                typingText,
                typingActive: false,
                action: beat.action,
                completesBeat: false,
            });
        }

        const focusPath = beat.focusPath ?? [];
        for (const target of focusPath) {
            focus = target;
            append({
                kind: 'focus',
                focus,
                durationMs: boundedFromId(`${story.id}:${beat.id}:${target}`, 160, 240),
                typingField: null,
                typingText: '',
                typingActive: false,
                completesBeat: false,
            });

            // A person does not merely sweep a highlight across rows: each
            // focused target gets a bounded reading pause. Dense scans dwell
            // longer per row; typing beats pause once before the first glyph.
            if (!beat.typing || target === focusPath.at(-1)) {
                append({
                    kind: 'dwell',
                    focus,
                    durationMs: beat.typing
                        ? boundedFromId(`${story.id}:${beat.id}:typing-dwell`, 450, 650)
                        : dwellDuration(beat),
                    typingField: null,
                    typingText: '',
                    typingActive: false,
                    completesBeat: false,
                });
            }
        }

        if (!beat.typing) {
            if (focusPath.length === 0) {
                const durationMs = dwellDuration(beat);
                if (durationMs > 0) {
                    append({
                        kind: 'dwell',
                        focus,
                        durationMs,
                        typingField: null,
                        typingText: '',
                        typingActive: false,
                        completesBeat: false,
                    });
                }
            }
        } else {
            if (focusPath.length === 0) {
                append({
                    kind: 'dwell',
                    focus,
                    durationMs: boundedFromId(`${story.id}:${beat.id}:typing-dwell`, 450, 650),
                    typingField: null,
                    typingText: '',
                    typingActive: false,
                    completesBeat: false,
                });
            }
            typingField = beat.typing.field;
            const chunks = typingChunks(beat.typing.text);
            const cadence = Math.min(110, Math.max(70, Math.round(1_200 / Math.max(chunks.length, 1))));
            for (const chunk of chunks) {
                typingText = chunk;
                append({
                    kind: 'type',
                    focus,
                    durationMs: cadence,
                    typingField,
                    typingText,
                    typingActive: true,
                    completesBeat: false,
                });
            }
        }

        if (beat.action && beat.typing) {
            append({
                kind: 'commit',
                focus,
                durationMs: 0,
                typingField,
                typingText,
                typingActive: false,
                action: beat.action,
                completesBeat: false,
            });
        }

        append({
            kind: 'settle',
            focus,
            durationMs: boundedFromId(`${story.id}:${beat.id}:settle`, 180, 320),
            typingField,
            typingText,
            typingActive: false,
            caption: beat.caption,
            completesBeat: true,
            stop: beat.stop,
            gate: beat.gate,
        });
    });

    return phases;
}

function defineStory(source: StorySource): StoryDefinition {
    const provisional = { ...source, durationMs: 0 };
    const durationMs = compileStory(provisional).reduce((total, phase) => total + phase.durationMs, 0);
    return { ...provisional, durationMs };
}

const projectSetup = defineStory({
    id: 'project-setup',
    number: '02',
    title: 'Add flows to your project',
    shortTitle: 'Project setup',
    summary: 'Let a guided session inspect the repo, suggest a numbered roster, and wait for your approval.',
    keyHint: 'md init --guided',
    startCaption: 'A browser fixture shows the guided setup contract. No repository is being inspected.',
    continueLabel: 'Say “go” in sample',
    beats: [
        {
            id: 'project-command',
            action: { type: 'SET_PROJECT_STAGE', stage: 'command' },
            focusPath: ['shell-command'],
            pacing: 'read',
            caption: 'Start the project-aware setup from the repository root.',
        },
        {
            id: 'project-consent',
            action: { type: 'SET_PROJECT_STAGE', stage: 'consent' },
            focusPath: ['consent-agent', 'consent-launch'],
            pacing: 'read',
            caption: 'The real CLI asks before launching the selected engine. The browser does not launch it.',
        },
        {
            id: 'project-inspection',
            action: { type: 'SET_PROJECT_STAGE', stage: 'inspection' },
            focusPath: ['shell-command'],
            pacing: 'scan',
            caption: 'A real guided session uses the chosen engine to inspect the repository. This is fixture data.',
        },
        {
            id: 'project-suggestions',
            action: { type: 'SET_PROJECT_STAGE', stage: 'suggestions' },
            focusPath: ['suggestion-1', 'suggestion-2', 'suggestion-3', 'suggestion-4'],
            pacing: 'scan',
            caption: 'The guide scans a numbered, repo-specific roster instead of silently writing generic flows.',
        },
        {
            id: 'project-selection',
            action: { type: 'SET_PROJECT_SELECTION', selected: [1, 3] },
            focusPath: ['selection-reply'],
            pacing: 'read',
            caption: 'Keep, drop, or change suggestions before anything is written.',
        },
        {
            id: 'project-approval',
            action: { type: 'SET_PROJECT_STAGE', stage: 'approval' },
            focusPath: ['write-gate'],
            pacing: 'read',
            caption: 'Autoplay stops before go. Continue the sample yourself to see a mock receipt and free plan.',
            stop: true,
            gate: 'project-go',
        },
    ],
});

const quickCreate = defineStory({
    id: 'quick-create',
    number: '01',
    title: 'Create one in seconds',
    shortTitle: 'Quick create',
    summary: 'Answer one question and create one project flow.',
    keyHint: 'md create',
    startCaption: 'The shortest path begins in an empty terminal with md create.',
    continueLabel: 'Press Enter in sample',
    beats: [
        {
            id: 'quick-empty',
            action: { type: 'SET_QUICK_STAGE', stage: 'empty' },
            pacing: 'settle',
            caption: 'Start with an empty terminal in any project.',
        },
        {
            id: 'quick-command',
            action: { type: 'SET_QUICK_STAGE', stage: 'command' },
            focusPath: ['shell-command'],
            pacing: 'read',
            caption: 'Type md create with no flags or intent.',
        },
        {
            id: 'quick-question',
            action: { type: 'SET_QUICK_STAGE', stage: 'question' },
            focusPath: ['intent-input'],
            pacing: 'read',
            caption: 'The real prompt is: What should this flow do?',
        },
        {
            id: 'quick-answer',
            action: { type: 'SET_CREATE_INTENT', intent: 'Draft release notes from this branch' },
            focusPath: ['intent-input'],
            pacing: 'type',
            typing: { field: 'createIntent', text: 'Draft release notes from this branch' },
            caption: 'Describe the repeatable outcome in plain language.',
        },
        {
            id: 'quick-enter-gate',
            action: { type: 'SET_QUICK_STAGE', stage: 'enter-boundary' },
            focusPath: ['write-gate'],
            pacing: 'read',
            caption: 'Autoplay stops before Enter because creation is a local write.',
            stop: true,
            gate: 'quick-create-enter',
        },
    ],
});

const evolveSafely = defineStory({
    id: 'evolve-safely',
    number: '03',
    title: 'Evolve from evidence',
    shortTitle: 'Evolve safely',
    summary: 'Capture a miss, inspect the free plan, review a proposal and diff, then own the apply decision.',
    keyHint: 'F · P · O · A · R',
    startCaption: 'A labeled sample result gives the evolution walkthrough a concrete miss to record.',
    beats: [
        {
            id: 'evolve-result',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'sample-result' },
            focusPath: ['sample-result'],
            pacing: 'read',
            caption: 'The sample finding is fixture data, not an engine result produced by this browser.',
        },
        {
            id: 'evolve-feedback-open',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'feedback' },
            focusPath: ['feedback-input'],
            pacing: 'read',
            caption: 'F opens feedback so an observed miss can become durable evidence.',
        },
        {
            id: 'evolve-feedback-type',
            action: { type: 'SET_FEEDBACK', feedback: 'Missed the logout / refresh race' },
            focusPath: ['feedback-input'],
            pacing: 'type',
            typing: { field: 'feedbackText', text: 'Missed the logout / refresh race' },
            caption: 'Feedback describes a failure; it does not prove a fix.',
        },
        {
            id: 'evolve-feedback-saved',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'feedback-saved' },
            focusPath: ['feedback-input'],
            pacing: 'read',
            caption: 'The walkthrough records feedback in browser memory only.',
        },
        {
            id: 'evolve-plan',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'plan' },
            focusPath: ['plan'],
            pacing: 'scan',
            caption: 'P is free: it previews readiness, cases, cost, and writes without invoking an engine.',
        },
        {
            id: 'evolve-proposal',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'proposal' },
            focusPath: ['proposal'],
            pacing: 'read',
            caption: 'O would invoke an engine. The browser loads a clearly labeled precomputed proposal fixture.',
        },
        {
            id: 'evolve-diff',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'diff' },
            focusPath: ['diff'],
            pacing: 'scan',
            caption: 'Review the proposed Markdown diff and verification receipt before deciding.',
        },
        {
            id: 'evolve-apply-gate',
            action: { type: 'SET_EVOLVE_STAGE', stage: 'decision' },
            focusPath: ['decision', 'write-gate'],
            pacing: 'read',
            caption: 'Autoplay stops before A. Apply and rollback always require manual confirmation.',
            stop: true,
            gate: 'evolve-apply',
        },
    ],
});

const personalFlows = defineStory({
    id: 'personal-flows',
    number: '04',
    title: 'Use a flow everywhere',
    shortTitle: 'Personal flows',
    summary: 'Create a personal flow in ~/.mdflow and resolve it across projects.',
    keyHint: 'md create --global',
    startCaption: 'Personal flows are ordinary Markdown files in ~/.mdflow, available across projects.',
    continueLabel: 'Press Enter in sample',
    beats: [
        {
            id: 'personal-command',
            action: { type: 'SET_PERSONAL_STAGE', stage: 'command' },
            focusPath: ['shell-command'],
            pacing: 'read',
            caption: 'The --global create location targets your personal ~/.mdflow directory directly.',
        },
        {
            id: 'personal-question',
            action: { type: 'SET_PERSONAL_STAGE', stage: 'question' },
            focusPath: ['intent-input'],
            pacing: 'read',
            caption: 'It uses the same one-question create path.',
        },
        {
            id: 'personal-answer',
            action: { type: 'SET_PERSONAL_INTENT', intent: 'Turn my notes into a daily plan' },
            focusPath: ['intent-input'],
            pacing: 'type',
            typing: { field: 'personalIntent', text: 'Turn my notes into a daily plan' },
            caption: 'This general-use flow is not coupled to a single repository.',
        },
        {
            id: 'personal-enter-gate',
            action: { type: 'SET_PERSONAL_STAGE', stage: 'enter-boundary' },
            focusPath: ['write-gate'],
            pacing: 'read',
            caption: 'Autoplay stops before Enter. Continue to see a mock receipt and cross-project dry-run.',
            stop: true,
            gate: 'personal-create-enter',
        },
    ],
});

export const STORIES: readonly StoryDefinition[] = [
    quickCreate,
    projectSetup,
    evolveSafely,
    personalFlows,
] as const;

export const STORY_BY_ID: Readonly<Record<StoryId, StoryDefinition>> = Object.freeze(
    Object.fromEntries(STORIES.map((story) => [story.id, story])) as Record<StoryId, StoryDefinition>,
);

export function storyFor(id: StoryId): StoryDefinition {
    return STORY_BY_ID[id];
}
