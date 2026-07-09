import React, {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from 'react';
import { Terminal, useTerminal } from '@wterm/react';
import '@wterm/react/css';
import { motion } from 'framer-motion';
import {
    ArrowRight,
    Check,
    FilePlus2,
    FolderSearch,
    GitCompareArrows,
    Globe2,
    Keyboard,
    Pause,
    Play,
    RotateCcw,
    Sparkles,
    StepForward,
} from 'lucide-react';
import {
    allDemoFlows,
    canContinueSample,
    currentCue,
    currentRun,
    demoReducer,
    initialDemoState,
} from './workbench-demo/model';
import {
    STORIES,
    storyFor,
    type StoryId,
} from './workbench-demo/stories';
import { terminalScreen } from './workbench-demo/screens';

const STORY_ICONS = {
    'project-setup': FolderSearch,
    'quick-create': FilePlus2,
    'evolve-safely': GitCompareArrows,
    'personal-flows': Globe2,
} satisfies Record<StoryId, React.ComponentType<{ size?: number; className?: string }>>;

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);

    useEffect(() => {
        const query = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReduced(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    return reduced;
}

function printable(data: string): string {
    return data.replace(/[\u0000-\u001f\u007f]/g, '');
}

export const FlowWorkbenchDemo: React.FC = () => {
    const { ref, write } = useTerminal();
    const sectionRef = useRef<HTMLElement | null>(null);
    const lastScreenRef = useRef('');
    const renderFrameRef = useRef<number | null>(null);
    const autoplayStartedRef = useRef(false);
    const [state, dispatch] = useReducer(
        demoReducer,
        undefined,
        () => initialDemoState('project-setup', false),
    );
    const [size, setSize] = useState({ cols: 92, rows: 26 });
    const [ready, setReady] = useState(false);
    const [terminalError, setTerminalError] = useState<string | null>(null);
    const [isInView, setIsInView] = useState(false);
    const [hoverPaused, setHoverPaused] = useState(false);
    const [focusPaused, setFocusPaused] = useState(false);
    const [pageHidden, setPageHidden] = useState(
        () => typeof document !== 'undefined' && document.hidden,
    );
    const reducedMotion = usePrefersReducedMotion();

    const story = storyFor(state.storyId);
    const cue = currentCue(state);
    const run = currentRun(state);
    const flows = useMemo(() => allDemoFlows(state), [state]);

    useEffect(() => {
        const section = sectionRef.current;
        if (!section) return undefined;
        if (!('IntersectionObserver' in window)) {
            setIsInView(true);
            return undefined;
        }

        const observer = new IntersectionObserver(
            ([entry]) => setIsInView(Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.3)),
            { threshold: [0, 0.3, 0.6] },
        );
        observer.observe(section);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const onVisibility = () => setPageHidden(document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, []);

    // Only the first story autoplays, only after the section is meaningfully
    // visible. Selecting another story always resets to a manual start.
    useEffect(() => {
        if (
            !isInView
            || reducedMotion
            || autoplayStartedRef.current
            || state.playback.takenOver
            || state.playback.status !== 'idle'
        ) return;

        autoplayStartedRef.current = true;
        dispatch({ type: 'RESTART', play: true });
    }, [isInView, reducedMotion, state.playback.status, state.playback.takenOver]);

    const environmentallyPaused = !isInView || hoverPaused || focusPaused || pageHidden;

    // Schedule only the next declarative cue. The story/run/index tuple makes
    // callbacks from an earlier selection or replay harmless.
    useEffect(() => {
        if (reducedMotion || environmentallyPaused || state.playback.status !== 'playing' || !cue) {
            return undefined;
        }

        const previousAt = run.cueIndex === 0 ? 0 : story.cues[run.cueIndex - 1]?.at ?? 0;
        const delay = Math.max(0, cue.at - previousAt);
        const timeout = window.setTimeout(() => {
            dispatch({ type: 'TIMELINE_CUE', ...run });
        }, delay);
        return () => window.clearTimeout(timeout);
    }, [cue, environmentallyPaused, reducedMotion, run, state.playback.status, story.cues]);

    // Coalesce state bursts into one wterm frame and skip identical screens.
    useEffect(() => {
        if (!ready) return undefined;
        const next = terminalScreen(state, flows, size.cols, size.rows, reducedMotion);
        if (next === lastScreenRef.current) return undefined;
        if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);

        renderFrameRef.current = window.requestAnimationFrame(() => {
            write(next);
            lastScreenRef.current = next;
            renderFrameRef.current = null;
        });

        return () => {
            if (renderFrameRef.current !== null) {
                window.cancelAnimationFrame(renderFrameRef.current);
                renderFrameRef.current = null;
            }
        };
    }, [flows, ready, reducedMotion, size.cols, size.rows, state, write]);

    const takeOver = useCallback(() => dispatch({ type: 'TAKE_OVER' }), []);

    const selectStory = useCallback((storyId: StoryId) => {
        autoplayStartedRef.current = true;
        setHoverPaused(false);
        setFocusPaused(false);
        dispatch({ type: 'SELECT_STORY', storyId });
    }, []);

    const stepCue = useCallback(() => {
        dispatch({ type: 'STEP_CUE', ...currentRun(state) });
    }, [state]);

    const continueSample = useCallback(() => {
        autoplayStartedRef.current = true;
        dispatch({ type: 'CONTINUE_SAMPLE', ...currentRun(state) });
    }, [state]);

    const inspectApply = useCallback(() => {
        autoplayStartedRef.current = true;
        dispatch({ type: 'REQUEST_APPLY' });
    }, []);

    const handleEvolveInput = useCallback((data: string) => {
        if (state.confirmAction) {
            if (data === '\u001b') dispatch({ type: 'CANCEL_CONFIRM' });
            else if (data === '\r' || data === '\n' || /^[cC]$/.test(data)) {
                dispatch({
                    type: state.confirmAction === 'apply' ? 'APPLY_FIXTURE' : 'ROLLBACK_FIXTURE',
                });
            }
            return true;
        }

        if (data === '\u001b') {
            dispatch({ type: state.evolveStage === 'feedback' ? 'CANCEL_FEEDBACK' : 'CANCEL_CONFIRM' });
            return true;
        }

        // Once the feedback editor is open, letters are content—not global
        // shortcuts. Save or leave the editor before using P/O/A/R again.
        if (state.evolveStage === 'feedback') {
            if (data === '\r' || data === '\n') dispatch({ type: 'SAVE_FEEDBACK' });
            else if (data === '\u007f' || data === '\b') {
                dispatch({ type: 'SET_FEEDBACK', feedback: Array.from(state.feedbackText).slice(0, -1).join('') });
            } else {
                const value = printable(data);
                if (value) dispatch({ type: 'SET_FEEDBACK', feedback: `${state.feedbackText}${value}` });
            }
            return true;
        }

        if (/^[fF]$/.test(data)) dispatch({ type: 'SHOW_FEEDBACK' });
        else if (/^[pP]$/.test(data)) dispatch({ type: 'PLAN' });
        else if (/^[oO]$/.test(data)) dispatch({ type: 'LOAD_PROPOSAL_FIXTURE' });
        else if (/^[aA]$/.test(data)) dispatch({ type: 'REQUEST_APPLY' });
        else if (/^[rR]$/.test(data)) dispatch({ type: 'REQUEST_ROLLBACK' });
        else return false;
        return true;
    }, [state.confirmAction, state.evolveStage, state.feedbackText]);

    const handleData = useCallback((data: string) => {
        // Keyboard input is takeover just like pointer input. TAKE_OVER keeps
        // the run token stable, so a same-event STEP_CUE remains current while
        // any scheduled autoplay callback is rejected by the paused status.
        takeOver();
        if (state.storyId === 'evolve-safely' && handleEvolveInput(data)) return;

        const editingQuickIntent = state.storyId === 'quick-create'
            && (state.quickStage === 'question' || state.quickStage === 'answer');
        if (editingQuickIntent && (data === '\u007f' || data === '\b')) {
            dispatch({
                type: 'SET_CREATE_INTENT',
                intent: Array.from(state.createIntent).slice(0, -1).join(''),
            });
            return;
        }
        if (editingQuickIntent && data !== '\r' && data !== '\n') {
            const value = printable(data);
            if (value) {
                dispatch({ type: 'SET_CREATE_INTENT', intent: `${state.createIntent}${value}` });
                return;
            }
        }

        const editingPersonalIntent = state.storyId === 'personal-flows'
            && (state.personalStage === 'question' || state.personalStage === 'answer');
        if (editingPersonalIntent && (data === '\u007f' || data === '\b')) {
            dispatch({
                type: 'SET_PERSONAL_INTENT',
                intent: Array.from(state.personalIntent).slice(0, -1).join(''),
            });
            return;
        }
        if (editingPersonalIntent && data !== '\r' && data !== '\n') {
            const value = printable(data);
            if (value) {
                dispatch({ type: 'SET_PERSONAL_INTENT', intent: `${state.personalIntent}${value}` });
                return;
            }
        }

        const isAdvance = data === '\r'
            || data === '\n'
            || data === ' '
            || data === '\u001b[C'
            || /^[nN]$/.test(data);
        if (state.gate && (isAdvance || /^[gGcC]$/.test(data))) {
            if (canContinueSample(state)) continueSample();
            else if (state.gate === 'evolve-apply') inspectApply();
            return;
        }
        if (isAdvance) {
            stepCue();
            return;
        }

    }, [continueSample, handleEvolveInput, inspectApply, state, stepCue, takeOver]);

    const playOrPause = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (reducedMotion) return;
        const resumeInspectionPause = event.currentTarget.dataset.playbackAction === 'resume';
        setHoverPaused(false);
        setFocusPaused(false);
        autoplayStartedRef.current = true;
        if (resumeInspectionPause) return;

        if (state.playback.status === 'complete') dispatch({ type: 'RESTART', play: true });
        else if (state.playback.status === 'playing') dispatch({ type: 'PAUSE' });
        else dispatch({ type: 'PLAY' });
    }, [reducedMotion, state.playback.status]);

    const restart = useCallback(() => {
        autoplayStartedRef.current = true;
        setHoverPaused(false);
        setFocusPaused(false);
        dispatch({ type: 'RESTART', play: false });
    }, []);

    const terminalStyle = {
        '--term-bg': '#070708',
        '--term-fg': '#d4d4d8',
        '--term-cursor': '#fb923c',
        '--term-color-0': '#09090b',
        '--term-color-1': '#fb7185',
        '--term-color-2': '#34d399',
        '--term-color-3': '#fbbf24',
        '--term-color-4': '#60a5fa',
        '--term-color-5': '#c084fc',
        '--term-color-6': '#67e8f9',
        '--term-color-7': '#e4e4e7',
        '--term-font-family': '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
        '--term-font-size': '13px',
        '--term-row-height': '18px',
        '--term-line-height': '1.35',
        background: '#070708',
    } as React.CSSProperties;

    const progress = Math.round((state.playback.cueIndex / story.cues.length) * 100);
    const inspectionPaused = state.playback.status === 'playing' && (hoverPaused || focusPaused);
    const playbackAction = reducedMotion
        ? 'manual'
        : inspectionPaused
            ? 'resume'
            : state.playback.status === 'complete'
                ? 'replay'
                : state.playback.status === 'playing'
                    ? 'pause'
                    : 'play';
    const playbackLabel = playbackAction === 'manual'
        ? 'Manual only'
        : playbackAction.charAt(0).toUpperCase() + playbackAction.slice(1);
    const PlaybackIcon = state.playback.status === 'playing' && !inspectionPaused && !reducedMotion
        ? Pause
        : Play;
    const pauseReason = pageHidden
        ? 'paused while tab is hidden'
        : !isInView
            ? 'waiting until visible'
            : inspectionPaused
                ? 'paused while you inspect'
                : state.playback.status;
    const showNextStep = reducedMotion || state.playback.status === 'idle' || state.playback.status === 'paused';
    const showContinue = canContinueSample(state);
    const showApplyBoundary = state.gate === 'evolve-apply' && !state.confirmAction;
    const visibleCaption = reducedMotion
        ? `Reduced motion: autoplay is off. ${state.caption.replace(
            'Use Play or step through it manually.',
            'Use Next step to continue.',
        )}`
        : state.caption;

    return (
        <section
            ref={sectionRef}
            id="workbench"
            aria-labelledby="workbench-title"
            data-story={state.storyId}
            data-playback={state.playback.status}
            data-cue={state.playback.cueIndex}
            data-story-id={state.storyId}
            data-playback-status={state.playback.status}
            data-cue-index={state.playback.cueIndex}
            className="relative overflow-hidden border-t border-white/5 px-4 py-24 sm:px-6 md:py-32"
        >
            <div className="pointer-events-none absolute left-1/2 top-[-20%] h-[680px] w-[900px] -translate-x-1/2 rounded-full bg-orange-500/[0.08] blur-[150px]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_70%_55%,rgba(34,211,238,0.05),transparent_35%)]" />

            <div className="relative z-10 mx-auto max-w-7xl">
                <motion.div
                    initial={reducedMotion ? false : { opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: reducedMotion ? 0 : 0.55 }}
                    className="mb-12 text-center"
                >
                    <p className="mb-4 font-mono text-xs uppercase tracking-[0.3em] text-orange-400">
                        four ways to start
                    </p>
                    <h2
                        id="workbench-title"
                        className="select-none font-display text-4xl font-bold tracking-tighter text-white md:text-6xl"
                    >
                        SET UP A PROJECT. CREATE A FLOW.<br />
                        <span className="bg-gradient-to-r from-orange-400 via-amber-200 to-white bg-clip-text text-transparent">
                            IMPROVE IT. TAKE IT EVERYWHERE.
                        </span>
                    </h2>
                    <p className="mx-auto mt-6 max-w-3xl text-lg font-light leading-relaxed text-zinc-400">
                        These browser-only fixtures show a guided engine inspecting a project and suggesting flows,
                        then how <span className="font-mono text-white">md</span> creates one from an empty terminal,
                        evolves it from evidence, and resolves personal flows everywhere.
                    </p>
                </motion.div>

                <div className="grid gap-6 lg:grid-cols-[minmax(280px,0.76fr)_minmax(0,2fr)] lg:items-stretch">
                    <div
                        className="grid grid-cols-2 gap-3 lg:grid-cols-1"
                        aria-label="Choose an mdflow walkthrough"
                        onMouseEnter={() => setHoverPaused(true)}
                        onMouseLeave={() => setHoverPaused(false)}
                        onFocusCapture={() => setFocusPaused(true)}
                        onBlurCapture={(event) => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusPaused(false);
                        }}
                    >
                        {STORIES.map((item, index) => {
                            const active = state.storyId === item.id;
                            const Icon = STORY_ICONS[item.id];
                            return (
                                <motion.button
                                    key={item.id}
                                    type="button"
                                    data-story-select={item.id}
                                    initial={reducedMotion ? false : { opacity: 0, x: -12 }}
                                    whileInView={{ opacity: 1, x: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: reducedMotion ? 0 : index * 0.06, duration: reducedMotion ? 0 : 0.35 }}
                                    onClick={() => selectStory(item.id)}
                                    aria-pressed={active}
                                    aria-controls="md-workbench-terminal"
                                    className={`group relative overflow-hidden rounded-xl border p-3 text-left transition-all motion-reduce:transition-none sm:p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 ${
                                        active
                                            ? 'border-orange-400/50 bg-orange-500/[0.09] shadow-[0_12px_40px_rgba(249,115,22,0.08)]'
                                            : 'border-white/10 bg-white/[0.025] hover:border-white/20 hover:bg-white/[0.045]'
                                    }`}
                                >
                                    <div className="mb-2.5 flex items-center justify-between">
                                        <span className={`font-mono text-[11px] ${active ? 'text-orange-300' : 'text-zinc-600'}`}>
                                            {item.number}
                                        </span>
                                        <Icon size={16} className={active ? 'text-orange-300' : 'text-zinc-500 group-hover:text-zinc-300'} />
                                    </div>
                                    <h3 className="mb-1 font-semibold tracking-tight text-white">{item.title}</h3>
                                    <p className="hidden text-sm font-light leading-relaxed text-zinc-400 sm:block">{item.summary}</p>
                                    <div className={`mt-3 flex items-center gap-1.5 font-mono text-[10px] sm:text-[11px] ${active ? 'text-orange-300' : 'text-zinc-600'}`}>
                                        <span className="truncate">{item.keyHint}</span>
                                        <ArrowRight size={11} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
                                    </div>
                                </motion.button>
                            );
                        })}

                        <div className="col-span-2 hidden rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-xs leading-relaxed text-zinc-500 lg:col-span-1 lg:block">
                            <Keyboard size={15} className="mb-2 text-zinc-400" aria-hidden="true" />
                            Choose a story to switch to manual mode. Hover, focus, or interact to pause; only Play resumes it.
                        </div>
                    </div>

                    <motion.div
                        initial={reducedMotion ? false : { opacity: 0, y: 18 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true, margin: '-80px' }}
                        transition={{ duration: reducedMotion ? 0 : 0.55 }}
                        data-demo-shell
                        className="min-w-0 overflow-hidden rounded-2xl border border-white/10 bg-[#070708] shadow-[0_30px_90px_rgba(0,0,0,0.55)]"
                    >
                        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-zinc-950/90 px-4 py-2">
                            <div className="flex items-center gap-1.5" aria-hidden="true">
                                <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                                <span className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
                                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
                            </div>
                            <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
                                <Sparkles size={12} className="text-orange-400" aria-hidden="true" />
                                {story.shortTitle} · {pauseReason}
                            </div>
                            <div className="flex items-center gap-1.5">
                                {showNextStep && !state.gate && cue ? (
                                    <button
                                        type="button"
                                        data-playback-control="next"
                                        onClick={stepCue}
                                        className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-white/10 px-3 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 sm:min-h-0 sm:px-2"
                                    >
                                        <StepForward size={12} aria-hidden="true" />
                                        Next step
                                    </button>
                                ) : null}
                                <button
                                    type="button"
                                    data-playback-control="primary"
                                    data-playback-action={playbackAction}
                                    onClick={playOrPause}
                                    disabled={reducedMotion}
                                    className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-white/10 px-3 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:cursor-default disabled:text-zinc-600 sm:min-h-0 sm:px-2"
                                    aria-label={reducedMotion ? 'Autoplay disabled by reduced motion preference' : `${playbackLabel} ${story.shortTitle} walkthrough`}
                                >
                                    <PlaybackIcon size={12} aria-hidden="true" />
                                    {playbackLabel}
                                </button>
                                <button
                                    type="button"
                                    data-playback-control="restart"
                                    onClick={restart}
                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-white/10 p-1.5 text-zinc-500 transition-colors hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 sm:min-h-0 sm:min-w-0"
                                    aria-label={`Restart ${story.shortTitle} in manual mode`}
                                    title="Restart in manual mode"
                                >
                                    <RotateCcw size={13} />
                                </button>
                            </div>
                        </div>

                        <div className="h-0.5 bg-white/5" role="progressbar" aria-label={`${story.shortTitle} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                            <div
                                className="h-full bg-gradient-to-r from-orange-500 to-amber-300 transition-[width] duration-300 motion-reduce:transition-none"
                                style={{ width: `${progress}%` }}
                            />
                        </div>

                        <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-zinc-950/60 px-4 py-2.5 text-sm text-zinc-300">
                            <div className="min-w-0 flex-1" role="status" aria-live="polite" aria-atomic="true">
                                <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.18em] text-orange-400">
                                    {state.storyId.replace('-', ' ')}
                                </span>
                                {visibleCaption}
                            </div>
                            {showContinue ? (
                                <button
                                    type="button"
                                    data-continue-sample={state.gate ?? undefined}
                                    onClick={continueSample}
                                    className="min-h-11 shrink-0 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 py-1.5 font-mono text-[11px] text-blue-200 transition-colors hover:border-blue-300/60 hover:bg-blue-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 sm:min-h-0"
                                >
                                    {story.continueLabel ?? 'Continue sample'}
                                </button>
                            ) : showApplyBoundary ? (
                                <button
                                    type="button"
                                    data-continue-sample="evolve-apply"
                                    onClick={inspectApply}
                                    className="min-h-11 shrink-0 rounded-md border border-blue-400/30 bg-blue-400/10 px-3 py-1.5 font-mono text-[11px] text-blue-200 transition-colors hover:border-blue-300/60 hover:bg-blue-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 sm:min-h-0"
                                >
                                    Inspect apply confirmation
                                </button>
                            ) : null}
                        </div>

                        <div
                            id="md-workbench-terminal"
                            data-terminal-story={state.storyId}
                            data-terminal-gate={state.gate ?? 'none'}
                            onPointerDown={takeOver}
                            className="h-[430px] min-w-0 bg-[#070708] sm:h-[500px]"
                            role="region"
                            aria-live="off"
                            aria-label={`${story.title} interactive terminal fixture. No repository is scanned, no engine runs, and no files are written.`}
                            onMouseEnter={() => setHoverPaused(true)}
                            onMouseLeave={() => setHoverPaused(false)}
                            onFocusCapture={() => setFocusPaused(true)}
                            onBlurCapture={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusPaused(false);
                            }}
                        >
                            {terminalError ? (
                                <div className="flex h-full items-center justify-center p-8 text-center font-mono text-sm text-zinc-400">
                                    <div>
                                        <p className="mb-2 text-rose-400">The terminal demo could not start.</p>
                                        <p>{terminalError}</p>
                                    </div>
                                </div>
                            ) : (
                                <Terminal
                                    ref={ref}
                                    autoResize
                                    cursorBlink={!reducedMotion}
                                    cols={92}
                                    rows={26}
                                    onData={handleData}
                                    onReady={(terminal) => {
                                        // wterm focuses its hidden textarea during init. This public
                                        // demo must not steal focus or summon a mobile keyboard.
                                        const active = document.activeElement;
                                        if (active instanceof HTMLElement && terminal.element.contains(active)) {
                                            active.blur();
                                        }
                                        setReady(true);
                                    }}
                                    onResize={(cols, rows) => setSize((current) => (
                                        current.cols === cols && current.rows === rows ? current : { cols, rows }
                                    ))}
                                    onError={(error) => setTerminalError(error instanceof Error ? error.message : String(error))}
                                    className="h-full !rounded-none !p-4 !shadow-none"
                                    style={terminalStyle}
                                />
                            )}
                        </div>
                    </motion.div>
                </div>

                <div
                    data-demo-honesty
                    className="mt-6 flex flex-col items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.025] px-5 py-4 sm:flex-row"
                >
                    <div className="flex items-center gap-3 text-sm text-zinc-400">
                        <Check size={16} className="shrink-0 text-emerald-400" aria-hidden="true" />
                        <span>
                            Browser fixture only: no repo inspection, engine call, or file write occurs. Commands, gates, and safety labels mirror the product contract.
                        </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 font-mono text-xs">
                        <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-emerald-300">FREE</span>
                        <span className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-300">ENGINE</span>
                        <span className="rounded border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-blue-300">LOCAL WRITE</span>
                    </div>
                </div>

                <p className="mt-5 text-center text-sm font-light text-zinc-500 sm:hidden">
                    Pick a story, then use Play, Next step, or the terminal. Autoplay never resumes after takeover unless you ask it to.
                </p>
            </div>
        </section>
    );
};

export default FlowWorkbenchDemo;
