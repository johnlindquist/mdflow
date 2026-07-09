/**
 * Honest, deterministic data for the browser-only terminal walkthroughs.
 * Nothing in this module is presented as output produced by a live engine.
 */

export interface DemoFlow {
    slug: string;
    description: string;
    engine: string;
    evidence: string;
    evaluation: string;
    scope: 'project' | 'personal';
}

export interface SuggestedProjectFlow {
    number: number;
    slug: string;
    description: string;
    context: string;
}

export const PROJECT_FIXTURE = {
    cwd: '~/dev/atlas-web',
    otherCwd: '~/dev/harbor-api',
    engine: 'codex',
    stack: 'TypeScript · React · Vitest · GitHub Actions',
} as const;

export const PROJECT_SUGGESTIONS: readonly SuggestedProjectFlow[] = [
    {
        number: 1,
        slug: 'review-changes',
        description: 'Review staged changes against this repo\'s conventions.',
        context: 'git diff + package scripts + CONTRIBUTING.md',
    },
    {
        number: 2,
        slug: 'release-check',
        description: 'Check versioning, tests, and release-note readiness.',
        context: 'package.json + CI + recent commits',
    },
    {
        number: 3,
        slug: 'issue-triage',
        description: 'Turn a bug report into a repo-specific investigation.',
        context: 'issue text + source tree + test commands',
    },
    {
        number: 4,
        slug: 'dependency-upgrade',
        description: 'Plan dependency upgrades against this repo\'s CI matrix.',
        context: 'package manifest + lockfile + CI workflows',
    },
] as const;

export const QUICK_CREATE_INTENT = 'Draft release notes from this branch';
export const PERSONAL_CREATE_INTENT = 'Turn my notes into a daily plan';

export const MOCK_FLOWS: readonly DemoFlow[] = [
    {
        slug: 'review-changes',
        description: 'Review staged changes for bugs and cite file:line.',
        engine: 'codex',
        evidence: '1 open feedback',
        evaluation: '1 linked eval · current 0/1',
        scope: 'project',
    },
    {
        slug: 'release-check',
        description: 'Check this branch before a release.',
        engine: 'codex',
        evidence: 'no open feedback',
        evaluation: 'no eval suite',
        scope: 'project',
    },
] as const;

export const EVOLUTION_FIXTURE = {
    flow: 'review-changes',
    feedbackId: 'fb_demo_01',
    feedback: 'Missed the logout / refresh race',
    proposalId: 'evr_demo_01',
    currentScore: '0/1',
    candidateScore: '1/1',
    diff: [
        '- Review the staged diff for correctness.',
        '+ Review the staged diff for correctness and async state races.',
        '+ Trace logout, refresh, and server-session invalidation together.',
    ],
} as const;
