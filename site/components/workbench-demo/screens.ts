import {
    EVOLUTION_FIXTURE,
    PROJECT_FIXTURE,
    PROJECT_SUGGESTIONS,
    type DemoFlow,
} from './fixtures';
import type { DemoState } from './model';
import { shellQuote, slugifyIntent } from './model';

const ESC = '\u001b[';
const ANSI = {
    clear: `${ESC}2J${ESC}H`,
    cursorOn: `${ESC}?25h`,
    cursorOff: `${ESC}?25l`,
    reset: `${ESC}0m`,
    orange: `${ESC}38;2;251;146;60m`,
    yellow: `${ESC}38;2;251;191;36m`,
    green: `${ESC}38;2;52;211;153m`,
    cyan: `${ESC}38;2;103;232;249m`,
    blue: `${ESC}38;2;96;165;250m`,
    white: `${ESC}38;2;250;250;250m`,
    zinc: `${ESC}38;2;161;161;170m`,
    dim: `${ESC}38;2;82;82;91m`,
    red: `${ESC}38;2;251;113;133m`,
};

const paint = (color: string, value: string) => `${color}${value}${ANSI.reset}`;
const characters = (value: string) => Array.from(value);
const SGR_CODES = /\u001b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
    return value.replace(SGR_CODES, '');
}

/** Clip a styled line without slicing through an SGR escape sequence. */
export function clipAnsi(value: string, width: number): string {
    if (width <= 0) return '';
    if (characters(stripAnsi(value)).length <= width) return value;

    let visible = 0;
    let index = 0;
    const target = Math.max(0, width - 1);
    while (index < value.length && visible < target) {
        if (value[index] === '\u001b') {
            const end = value.indexOf('m', index);
            if (end === -1) break;
            index = end + 1;
            continue;
        }
        const codePoint = value.codePointAt(index);
        if (codePoint === undefined) break;
        visible += 1;
        index += codePoint > 0xffff ? 2 : 1;
    }
    return `${value.slice(0, index)}…${ANSI.reset}`;
}

function clip(value: string, width: number): string {
    if (width <= 0) return '';
    const units = characters(value);
    if (units.length <= width) return value;
    if (width === 1) return '…';
    return `${units.slice(0, width - 1).join('')}…`;
}

function rule(width: number, glyph = '─'): string {
    return paint(ANSI.dim, glyph.repeat(Math.max(1, width)));
}

function sides(
    left: string,
    right: string,
    width: number,
    leftColor = ANSI.white,
    rightColor = ANSI.dim,
): string {
    const safeRight = clip(right, Math.max(8, Math.floor(width * 0.55)));
    const maxLeft = Math.max(1, width - characters(safeRight).length - 2);
    const safeLeft = clip(left, maxLeft);
    const gap = ' '.repeat(Math.max(1, width - characters(safeLeft).length - characters(safeRight).length));
    return `${paint(leftColor, safeLeft)}${gap}${paint(rightColor, safeRight)}`;
}

function label(kind: 'FREE' | 'ENGINE' | 'LOCAL WRITE'): string {
    const colors = {
        FREE: ANSI.green,
        ENGINE: ANSI.yellow,
        'LOCAL WRITE': ANSI.blue,
    } as const;
    return paint(colors[kind], `[${kind}]`);
}

function header(title: string, width: number): string[] {
    return [
        sides(` md · ${title}`, 'BROWSER SIMULATION · NO FILES / ENGINES', width, ANSI.orange, ANSI.dim),
        rule(width),
    ];
}

function promptLine(intent: string, placeholder: string): string {
    return `${paint(ANSI.orange, '?')} ${paint(ANSI.white, 'What should this flow do?')}  ${paint(
        intent ? ANSI.white : ANSI.dim,
        intent || placeholder,
    )}`;
}

function projectSetupScreen(state: DemoState, width: number): string[] {
    const lines = header('guided project setup', width);
    lines.push(sides(PROJECT_FIXTURE.cwd, 'SAMPLE TRANSCRIPT · FIXTURE', width, ANSI.zinc, ANSI.yellow));
    lines.push('');

    if (state.projectStage === 'command') {
        lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.white, 'md init --guided')}`);
        lines.push('');
        lines.push(paint(ANSI.white, 'Project-aware setup proposes a roster before it writes.'));
        lines.push(paint(ANSI.zinc, 'The real command first asks permission to launch your selected engine.'));
        lines.push('');
        lines.push(`${label('ENGINE')} guided inspection happens only after consent`);
        return lines;
    }

    if (state.projectStage === 'consent') {
        lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.white, 'md init --guided')}`);
        lines.push(`${paint(ANSI.orange, '?')} Which agent should guide your setup? ${paint(ANSI.white, '› codex')}`);
        lines.push('');
        lines.push(paint(ANSI.white, 'This launches codex interactively in this repo.'));
        lines.push(`${paint(ANSI.orange, '?')} Launch codex? ${paint(ANSI.zinc, '(Y/n)')} ${paint(ANSI.white, '› y')}`);
        lines.push('');
        lines.push(`${label('ENGINE')} ${paint(ANSI.yellow, 'consented sample boundary')}`);
        lines.push(paint(ANSI.yellow, 'Fixture only. The browser did not launch codex or inspect a repository.'));
        return lines;
    }

    if (state.projectStage === 'inspection') {
        lines.push(`${label('ENGINE')} ${paint(ANSI.yellow, 'SAMPLE GUIDED SESSION · FIXTURE')}`);
        lines.push('');
        lines.push(paint(ANSI.white, 'Inspecting package manifests, scripts, CI, docs, and recent history…'));
        lines.push(`${paint(ANSI.green, '✓')} ${PROJECT_FIXTURE.stack}`);
        lines.push(`${paint(ANSI.green, '✓')} release workflow and repository conventions mapped`);
        lines.push(`${paint(ANSI.green, '✓')} existing flows checked before proposing additions`);
        lines.push('');
        lines.push(paint(ANSI.yellow, 'Prewritten transcript. No live engine or filesystem access occurred.'));
        return lines;
    }

    if (state.projectStage === 'suggestions' || state.projectStage === 'selection') {
        lines.push(`${label('ENGINE')} ${paint(ANSI.white, 'Suggested starter roster · fixture')}`);
        lines.push('');
        for (const suggestion of PROJECT_SUGGESTIONS) {
            lines.push(paint(ANSI.white, `${suggestion.number}. ${suggestion.slug}`));
            lines.push(paint(ANSI.zinc, `   ${clip(suggestion.description, Math.max(8, width - 3))}`));
            if (width >= 68) lines.push(paint(ANSI.dim, `   inlines: ${suggestion.context}`));
        }
        lines.push('');
        lines.push(paint(ANSI.white, 'Which should we keep, drop, or change?'));
        lines.push(`${paint(ANSI.orange, 'You ›')} ${paint(
            state.projectSelection.length > 0 ? ANSI.white : ANSI.dim,
            state.projectSelection.length > 0
                ? `Keep 1 and 3. Drop 2 and 4. Default engine: ${PROJECT_FIXTURE.engine}.`
                : 'reply with numbers',
        )}`);
        lines.push(paint(ANSI.dim, 'Numbered conversation—not a package-install checklist.'));
        return lines;
    }

    if (state.projectStage === 'approval') {
        lines.push(paint(ANSI.white, 'Guide › I will create these project flows:'));
        for (const number of state.projectSelection) {
            const suggestion = PROJECT_SUGGESTIONS.find((item) => item.number === number);
            if (suggestion) lines.push(`${paint(ANSI.orange, `${number}.`)} flows/${suggestion.slug}.md`);
        }
        lines.push('');
        lines.push(paint(ANSI.zinc, 'Plus colocated eval fixtures, flows/README.md, and .mdflow.yaml.'));
        lines.push(paint(ANSI.zinc, `Project default engine: ${PROJECT_FIXTURE.engine}`));
        lines.push('');
        lines.push(`${label('LOCAL WRITE')} ${paint(ANSI.white, 'Type go to approve this exact roster:')}`);
        lines.push(`${paint(ANSI.orange, 'You ›')} ${paint(ANSI.dim, '█')}`);
        lines.push(paint(ANSI.yellow, 'Autoplay stopped. Nothing is written until you continue the sample.'));
        return lines;
    }

    lines.push(`${paint(ANSI.orange, 'You ›')} ${paint(ANSI.white, 'go')}`);
    lines.push(`${paint(ANSI.green, 'SAMPLE RECEIPT AFTER EXPLICIT go')} ${label('LOCAL WRITE')}`);
    lines.push('');
    for (const number of state.projectSelection) {
        const suggestion = PROJECT_SUGGESTIONS.find((item) => item.number === number);
        if (suggestion) lines.push(paint(ANSI.white, `created flows/${suggestion.slug}.md`));
    }
    lines.push(paint(ANSI.zinc, 'created eval fixtures + roster + .mdflow.yaml'));
    lines.push(paint(ANSI.yellow, 'Browser memory only. No repository files were written.'));
    lines.push('');
    lines.push(`${label('FREE')} ${paint(ANSI.white, 'md review-changes --_dry-run')}`);
    lines.push(paint(ANSI.green, 'Would resolve the command plan without invoking an engine.'));
    lines.push(paint(ANSI.zinc, 'Creation and dry-run resolution are not behavioral proof.'));
    return lines;
}

function quickCreateScreen(state: DemoState, width: number): string[] {
    const lines = header('quick create', width);
    lines.push(sides(PROJECT_FIXTURE.cwd, 'ONE QUESTION · PROJECT FLOW', width, ANSI.zinc, ANSI.green));
    lines.push('');

    if (state.quickStage === 'empty') {
        lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.dim, '█')}`);
        lines.push('');
        lines.push(paint(ANSI.zinc, 'An empty terminal is enough.'));
        return lines;
    }

    if (state.quickStage === 'command') {
        lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.white, 'md create')}`);
        lines.push('');
        lines.push(paint(ANSI.zinc, 'No flags, form, or template selection required.'));
        return lines;
    }

    if (state.quickStage === 'receipt') {
        const intent = state.createIntent;
        const slug = slugifyIntent(intent);
        lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.white, 'md create')}`);
        lines.push(promptLine(intent, 'Describe the repeatable outcome'));
        lines.push('');
        lines.push(`${label('LOCAL WRITE')} ${paint(ANSI.green, `Created flow: ${PROJECT_FIXTURE.cwd}/flows/${slug}.md`)}`);
        lines.push(paint(ANSI.zinc, 'Added project support only when missing; existing paths stay untouched.'));
        lines.push(paint(ANSI.yellow, 'Browser memory only. The new flow has no feedback and is not evaluated.'));
        lines.push('');
        lines.push(paint(ANSI.white, `Next: md ${slug}`));
        return lines;
    }

    lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.white, 'md create')}`);
    lines.push(promptLine(state.createIntent, 'Describe the repeatable outcome'));
    lines.push('');
    if (state.quickStage === 'question') {
        lines.push(paint(ANSI.zinc, 'Answer in plain language. That is the whole interactive path.'));
    } else {
        lines.push(`${label('LOCAL WRITE')} ${paint(ANSI.white, 'Enter create project flow')}`);
        if (state.quickStage === 'enter-boundary') {
            lines.push(paint(ANSI.yellow, 'Autoplay stopped before Enter. No file has been created.'));
        }
    }
    return lines;
}

function confirmationScreen(state: DemoState, width: number): string[] {
    const rollback = state.confirmAction === 'rollback';
    const command = rollback
        ? `md evolve rollback ${EVOLUTION_FIXTURE.proposalId}`
        : `md evolve apply ${EVOLUTION_FIXTURE.proposalId}`;
    return [
        ...header('evolve · confirmation', width),
        paint(ANSI.blue, 'CONFIRM LOCAL WRITE · DEMO FIXTURE'),
        '',
        paint(ANSI.white, rollback
            ? `Roll back sample apply ${EVOLUTION_FIXTURE.proposalId}?`
            : `Apply sample proposal ${EVOLUTION_FIXTURE.proposalId} to flows/${EVOLUTION_FIXTURE.flow}.md?`),
        paint(ANSI.zinc, 'Real md checks the reviewed source hash and writes atomically.'),
        paint(ANSI.yellow, 'The browser can change demo state only; it cannot write your files.'),
        '',
        paint(ANSI.zinc, `Shell: ${command}`),
        `${label('LOCAL WRITE')} ${paint(ANSI.blue, 'Enter / C confirm')}   ${paint(ANSI.dim, 'Esc cancel')}`,
    ];
}

function evolveScreen(state: DemoState, width: number): string[] {
    if (state.confirmAction) return confirmationScreen(state, width);
    const lines = header(`evolve · ${EVOLUTION_FIXTURE.flow}.md`, width);
    lines.push(sides('Evidence → Plan → Proposal → Decision', 'FIXTURE DATA', width, ANSI.zinc, ANSI.yellow));
    lines.push('');

    if (state.evolveStage === 'sample-result') {
        lines.push(`${label('ENGINE')} ${paint(ANSI.yellow, 'SAMPLE RESULT · PRECOMPUTED FIXTURE')}`);
        lines.push('');
        lines.push(paint(ANSI.white, 'src/auth/logout.ts:31 — server session remains active after local logout'));
        lines.push(paint(ANSI.zinc, 'Sample finding: revoke the server session when the user signs out.'));
        lines.push('');
        lines.push(paint(ANSI.yellow, 'The browser did not run an engine or verify this finding.'));
        lines.push(paint(ANSI.white, 'F record what this sample result missed'));
    } else if (state.evolveStage === 'feedback') {
        lines.push(`${paint(ANSI.orange, 'F')} ${paint(ANSI.white, 'WHAT DID THIS FLOW MISS?')}`);
        lines.push('');
        lines.push(`${paint(ANSI.orange, '>')} ${paint(
            state.feedbackText ? ANSI.white : ANSI.dim,
            state.feedbackText || 'Describe the observed miss…',
        )}`);
        lines.push('');
        lines.push(`${label('LOCAL WRITE')} Enter save feedback to the evidence ledger`);
        lines.push(paint(ANSI.yellow, 'Feedback is evidence about a miss, not proof of a fix.'));
    } else if (state.evolveStage === 'feedback-saved') {
        lines.push(`${paint(ANSI.green, 'EVIDENCE SAVED · DEMO STATE')} ${label('LOCAL WRITE')}`);
        lines.push('');
        lines.push(paint(ANSI.white, `${EVOLUTION_FIXTURE.feedbackId} · “${state.feedbackText || EVOLUTION_FIXTURE.feedback}”`));
        lines.push(paint(ANSI.yellow, 'Browser memory only. P can inspect readiness without an engine.'));
    } else if (state.evolveStage === 'plan') {
        lines.push(`${paint(ANSI.orange, 'P')} ${paint(ANSI.white, 'READINESS PLAN')}  ${label('FREE')}`);
        lines.push(rule(width));
        lines.push(paint(ANSI.white, '1 open feedback · 1 linked eval case'));
        lines.push(paint(ANSI.zinc, 'Would compare current and candidate with 2 paid invocations.'));
        lines.push(paint(ANSI.green, 'No engine invoked. No source write.'));
        lines.push(paint(ANSI.yellow, 'A cost/readiness plan is not a verification result.'));
    } else if (state.evolveStage === 'proposal') {
        lines.push(`${paint(ANSI.orange, 'O')} ${paint(ANSI.white, 'SAMPLE PROPOSAL RECORD')}  ${label('ENGINE')}`);
        lines.push(rule(width));
        lines.push(paint(ANSI.white, `${EVOLUTION_FIXTURE.proposalId} · fixture status: verified_improvement`));
        lines.push(paint(ANSI.zinc, `Current ${EVOLUTION_FIXTURE.currentScore} → candidate ${EVOLUTION_FIXTURE.candidateScore}`));
        lines.push(paint(ANSI.yellow, 'Precomputed mock data. This browser did not run or verify the proposal.'));
        lines.push(paint(ANSI.white, 'Review the diff before making a separate apply decision.'));
    } else if (state.evolveStage === 'diff') {
        lines.push(paint(ANSI.white, `PROPOSAL DIFF · ${EVOLUTION_FIXTURE.proposalId} · FIXTURE`));
        lines.push(rule(width));
        for (const line of EVOLUTION_FIXTURE.diff) {
            lines.push(paint(line.startsWith('+') ? ANSI.green : ANSI.red, line));
        }
        lines.push('');
        lines.push(paint(ANSI.zinc, `Receipt fixture: current ${EVOLUTION_FIXTURE.currentScore} · candidate ${EVOLUTION_FIXTURE.candidateScore}`));
        lines.push(paint(ANSI.yellow, 'Status was loaded from fixture data, not produced in this browser.'));
    } else if (state.evolveStage === 'decision') {
        lines.push(`${paint(ANSI.white, 'DECISION BOUNDARY')}  ${label('LOCAL WRITE')}`);
        lines.push(rule(width));
        lines.push(paint(ANSI.white, `Reviewed sample proposal: ${EVOLUTION_FIXTURE.proposalId}`));
        lines.push(paint(ANSI.zinc, 'Real apply validates the source hash and writes atomically.'));
        lines.push(paint(ANSI.yellow, 'Autoplay never presses A, confirms, applies, or rolls back.'));
        lines.push('');
        lines.push(`${paint(ANSI.blue, 'A')} open apply confirmation`);
        lines.push(paint(ANSI.dim, 'R becomes available only after an explicit apply'));
    } else if (state.evolveStage === 'applied') {
        lines.push(`${paint(ANSI.green, 'APPLIED · DEMO STATE ONLY')} ${label('LOCAL WRITE')}`);
        lines.push('');
        lines.push(paint(ANSI.white, `${EVOLUTION_FIXTURE.proposalId} is marked applied in browser memory.`));
        lines.push(paint(ANSI.zinc, 'No source file changed.'));
        lines.push(`${paint(ANSI.blue, 'R')} open rollback confirmation`);
    } else {
        lines.push(`${paint(ANSI.green, 'ROLLED BACK · DEMO STATE ONLY')} ${label('LOCAL WRITE')}`);
        lines.push('');
        lines.push(paint(ANSI.white, 'The in-memory fixture returned to its pre-apply state.'));
        lines.push(paint(ANSI.zinc, 'No source file changed.'));
    }

    lines.push('');
    lines.push(paint(ANSI.dim, 'F feedback   P plan [FREE]   O propose [ENGINE]   A apply   R rollback'));
    return lines;
}

function personalFlowScreen(state: DemoState, width: number): string[] {
    const lines = header('personal flow', width);
    lines.push(sides(PROJECT_FIXTURE.cwd, '~/.mdflow · AVAILABLE ACROSS PROJECTS', width, ANSI.zinc, ANSI.cyan));
    lines.push('');

    if (state.personalStage === 'cross-project') {
        const slug = slugifyIntent(state.personalIntent);
        lines.push(`${label('LOCAL WRITE')} ${paint(ANSI.green, `Created flow: ~/.mdflow/${slug}.md`)}`);
        lines.push(paint(ANSI.yellow, 'Browser memory only. This was a direct personal create, not a registry install.'));
        lines.push('');
        lines.push(`${paint(ANSI.zinc, '$')} cd ${PROJECT_FIXTURE.otherCwd}`);
        lines.push(`${paint(ANSI.zinc, '$')} md ${slug} --_dry-run`);
        lines.push('');
        lines.push(`${label('FREE')} ${paint(ANSI.white, `Resolved: ~/.mdflow/${slug}.md`)}`);
        lines.push(paint(ANSI.green, 'No engine invoked; inline commands would be skipped.'));
        lines.push(paint(ANSI.zinc, `A project flows/${slug}.md would shadow the personal flow.`));
        lines.push(paint(ANSI.yellow, 'Resolution proves the command plan, not behavioral quality.'));
        return lines;
    }

    lines.push(`${paint(ANSI.zinc, '$')} ${paint(ANSI.white, 'md create --global')}`);
    if (state.personalStage !== 'command') {
        lines.push(promptLine(state.personalIntent, 'Describe a general-use outcome'));
    }
    lines.push('');
    if (state.personalStage === 'command') {
        lines.push(paint(ANSI.white, 'Create an ordinary Markdown flow in your personal ~/.mdflow directory.'));
        lines.push(paint(ANSI.zinc, 'Use it from project folders, your home directory, or anywhere md can run.'));
        lines.push(paint(ANSI.yellow, 'This is personal scope, not md install --global registry scope.'));
    } else if (state.personalStage === 'question') {
        lines.push(paint(ANSI.zinc, 'The personal path uses the same single create question.'));
    } else {
        const slug = slugifyIntent(state.personalIntent || 'new flow');
        lines.push(paint(ANSI.zinc, `Target after Enter: ~/.mdflow/${slug}.md`));
        lines.push(paint(ANSI.zinc, 'Direct personal Markdown file; not a registry install.'));
        lines.push(`${label('LOCAL WRITE')} ${paint(ANSI.white, 'Enter create personal flow')}`);
        if (state.personalStage === 'enter-boundary') {
            lines.push(paint(ANSI.yellow, 'Autoplay stopped before Enter. No personal file has been created.'));
        }
    }
    return lines;
}

export function filterDemoFlows(flows: readonly DemoFlow[], query: string): DemoFlow[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...flows];
    return flows.filter((flow) => `${flow.slug} ${flow.description}`.toLowerCase().includes(needle));
}

function acceptsText(state: DemoState): boolean {
    return (state.storyId === 'quick-create' && ['question', 'answer', 'enter-boundary'].includes(state.quickStage))
        || (state.storyId === 'personal-flows' && ['question', 'answer', 'enter-boundary'].includes(state.personalStage))
        || (state.storyId === 'evolve-safely' && state.evolveStage === 'feedback')
        || state.confirmAction !== null;
}

export function terminalScreen(
    state: DemoState,
    _flows: readonly DemoFlow[],
    cols: number,
    _rows: number,
    reducedMotion: boolean,
): string {
    const width = Math.max(38, Math.min(cols || 92, 110));
    let lines: string[];
    if (state.storyId === 'project-setup') lines = projectSetupScreen(state, width);
    else if (state.storyId === 'quick-create') lines = quickCreateScreen(state, width);
    else if (state.storyId === 'personal-flows') lines = personalFlowScreen(state, width);
    else lines = evolveScreen(state, width);

    const cursor = acceptsText(state) && !reducedMotion ? ANSI.cursorOn : ANSI.cursorOff;
    return `${ANSI.clear}${cursor}${lines.map((line) => clipAnsi(line, width)).join('\r\n')}`;
}

/** Useful for component copy and regression tests without duplicating shell quoting. */
export function personalCreateCommand(intent: string): string {
    return `md create --global ${shellQuote(intent)}`;
}
