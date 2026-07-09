export const STORY_IDS = [
    'project-setup',
    'quick-create',
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

/** Actions that may be placed on an autoplay timeline. */
export type StoryCueAction =
    | { type: 'SET_PROJECT_STAGE'; stage: ProjectSetupStage }
    | { type: 'SET_PROJECT_SELECTION'; selected: readonly number[] }
    | { type: 'SET_QUICK_STAGE'; stage: QuickCreateStage }
    | { type: 'SET_CREATE_INTENT'; intent: string }
    | { type: 'SET_EVOLVE_STAGE'; stage: EvolveStage }
    | { type: 'SET_FEEDBACK'; feedback: string }
    | { type: 'SET_PERSONAL_STAGE'; stage: PersonalFlowStage }
    | { type: 'SET_PERSONAL_INTENT'; intent: string };

export interface TimelineCue {
    /** Milliseconds from the beginning of this story. */
    at: number;
    action: StoryCueAction;
    caption?: string;
    /** A stopped cue is always the last timed cue and never performs a write. */
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
    durationMs: number;
    startCaption: string;
    continueLabel?: string;
    cues: readonly TimelineCue[];
}

const projectSetup: StoryDefinition = {
    id: 'project-setup',
    number: '01',
    title: 'Add flows to your project',
    shortTitle: 'Project setup',
    summary: 'Let a guided session inspect the repo, suggest a numbered roster, and wait for your approval.',
    keyHint: 'md init --guided',
    durationMs: 28_000,
    startCaption: 'A browser fixture shows the guided setup contract. No repository is being inspected.',
    continueLabel: 'Say “go” in sample',
    cues: [
        {
            at: 0,
            action: { type: 'SET_PROJECT_STAGE', stage: 'command' },
            caption: 'Start the project-aware setup from the repository root.',
        },
        {
            at: 2_500,
            action: { type: 'SET_PROJECT_STAGE', stage: 'consent' },
            caption: 'The real CLI asks before launching the selected engine. The browser does not launch it.',
        },
        {
            at: 5_000,
            action: { type: 'SET_PROJECT_STAGE', stage: 'inspection' },
            caption: 'A real guided session uses the chosen engine to inspect the repository. This is fixture data.',
        },
        {
            at: 9_000,
            action: { type: 'SET_PROJECT_STAGE', stage: 'suggestions' },
            caption: 'The guide proposes a numbered, repo-specific roster instead of silently writing generic flows.',
        },
        {
            at: 14_000,
            action: { type: 'SET_PROJECT_STAGE', stage: 'selection' },
            caption: 'Choose by number in conversation; this is not a checkbox installer.',
        },
        {
            at: 18_000,
            action: { type: 'SET_PROJECT_SELECTION', selected: [1, 3] },
            caption: 'Keep, drop, or change suggestions before anything is written.',
        },
        {
            at: 23_000,
            action: { type: 'SET_PROJECT_STAGE', stage: 'approval' },
            caption: 'The guide reflects the exact roster and waits for the explicit word go.',
        },
        {
            at: 28_000,
            action: { type: 'SET_PROJECT_STAGE', stage: 'approval' },
            caption: 'Autoplay stops before go. Continue the sample yourself to see a mock receipt and free plan.',
            stop: true,
            gate: 'project-go',
        },
    ],
};

const quickCreate: StoryDefinition = {
    id: 'quick-create',
    number: '02',
    title: 'Create one in seconds',
    shortTitle: 'Quick create',
    summary: 'Answer one question and create one project flow.',
    keyHint: 'md create',
    durationMs: 18_000,
    startCaption: 'The shortest path begins in an empty terminal with md create.',
    continueLabel: 'Press Enter in sample',
    cues: [
        {
            at: 0,
            action: { type: 'SET_QUICK_STAGE', stage: 'empty' },
            caption: 'Start with an empty terminal in any project.',
        },
        {
            at: 2_000,
            action: { type: 'SET_QUICK_STAGE', stage: 'command' },
            caption: 'Type md create with no flags or intent.',
        },
        {
            at: 4_000,
            action: { type: 'SET_QUICK_STAGE', stage: 'question' },
            caption: 'The real prompt is: What should this flow do?',
        },
        {
            at: 8_000,
            action: { type: 'SET_CREATE_INTENT', intent: 'Draft release notes' },
        },
        {
            at: 11_000,
            action: { type: 'SET_CREATE_INTENT', intent: 'Draft release notes from this branch' },
            caption: 'Describe the repeatable outcome in plain language.',
        },
        {
            at: 15_000,
            action: { type: 'SET_QUICK_STAGE', stage: 'enter-boundary' },
            caption: 'There is no hidden preview or second question on this path.',
        },
        {
            at: 18_000,
            action: { type: 'SET_QUICK_STAGE', stage: 'enter-boundary' },
            caption: 'Autoplay stops before Enter because creation is a local write.',
            stop: true,
            gate: 'quick-create-enter',
        },
    ],
};

const evolveSafely: StoryDefinition = {
    id: 'evolve-safely',
    number: '03',
    title: 'Evolve from evidence',
    shortTitle: 'Evolve safely',
    summary: 'Capture a miss, inspect the free plan, review a proposal and diff, then own the apply decision.',
    keyHint: 'F · P · O · A · R',
    durationMs: 30_000,
    startCaption: 'A labeled sample result gives the evolution walkthrough a concrete miss to record.',
    cues: [
        {
            at: 0,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'sample-result' },
            caption: 'The sample finding is fixture data, not an engine result produced by this browser.',
        },
        {
            at: 4_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'feedback' },
            caption: 'F opens feedback so an observed miss can become durable evidence.',
        },
        {
            at: 7_000,
            action: { type: 'SET_FEEDBACK', feedback: 'Missed the logout' },
        },
        {
            at: 10_000,
            action: { type: 'SET_FEEDBACK', feedback: 'Missed the logout / refresh race' },
            caption: 'Feedback describes a failure; it does not prove a fix.',
        },
        {
            at: 13_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'feedback-saved' },
            caption: 'The walkthrough records feedback in browser memory only.',
        },
        {
            at: 17_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'plan' },
            caption: 'P is free: it previews readiness, cases, cost, and writes without invoking an engine.',
        },
        {
            at: 21_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'proposal' },
            caption: 'O would invoke an engine. The browser loads a clearly labeled precomputed proposal fixture.',
        },
        {
            at: 25_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'diff' },
            caption: 'Review the proposed Markdown diff and verification receipt before deciding.',
        },
        {
            at: 28_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'decision' },
            caption: 'The apply boundary is a separate local-write decision.',
        },
        {
            at: 30_000,
            action: { type: 'SET_EVOLVE_STAGE', stage: 'decision' },
            caption: 'Autoplay stops before A. Apply and rollback always require manual confirmation.',
            stop: true,
            gate: 'evolve-apply',
        },
    ],
};

const personalFlows: StoryDefinition = {
    id: 'personal-flows',
    number: '04',
    title: 'Use a flow everywhere',
    shortTitle: 'Personal flows',
    summary: 'Create a personal flow in ~/.mdflow and resolve it across projects.',
    keyHint: 'md create --global',
    durationMs: 23_000,
    startCaption: 'Personal flows are ordinary Markdown files in ~/.mdflow, available across projects.',
    continueLabel: 'Press Enter in sample',
    cues: [
        {
            at: 0,
            action: { type: 'SET_PERSONAL_STAGE', stage: 'command' },
            caption: 'The --global create location targets your personal ~/.mdflow directory directly.',
        },
        {
            at: 4_000,
            action: { type: 'SET_PERSONAL_STAGE', stage: 'question' },
            caption: 'It uses the same one-question create path.',
        },
        {
            at: 8_000,
            action: { type: 'SET_PERSONAL_INTENT', intent: 'Turn my notes' },
        },
        {
            at: 12_000,
            action: { type: 'SET_PERSONAL_INTENT', intent: 'Turn my notes into a daily plan' },
            caption: 'This general-use flow is not coupled to a single repository.',
        },
        {
            at: 18_000,
            action: { type: 'SET_PERSONAL_STAGE', stage: 'enter-boundary' },
            caption: 'The target is ~/.mdflow; this is not a registry install.',
        },
        {
            at: 23_000,
            action: { type: 'SET_PERSONAL_STAGE', stage: 'enter-boundary' },
            caption: 'Autoplay stops before Enter. Continue to see a mock receipt and cross-project dry-run.',
            stop: true,
            gate: 'personal-create-enter',
        },
    ],
};

export const STORIES: readonly StoryDefinition[] = [
    projectSetup,
    quickCreate,
    evolveSafely,
    personalFlows,
] as const;

export const STORY_BY_ID: Readonly<Record<StoryId, StoryDefinition>> = Object.freeze(
    Object.fromEntries(STORIES.map((story) => [story.id, story])) as Record<StoryId, StoryDefinition>,
);

export function storyFor(id: StoryId): StoryDefinition {
    return STORY_BY_ID[id];
}
