import React, { useEffect, useRef, useState } from 'react';
import { shaderAudio } from './shaderAudio';

/**
 * 23 hidden easter eggs + a five-step secret puzzle.
 *
 * Every egg pairs a discovery trigger with its own sound (composed from
 * shaderAudio's generic voices) and its own visual (composed from the
 * ShaderGuide 'mdflow:fx' primitives: shock/burst/rain/fountain/quake/
 * lightning/sweep/flip/excite). First-time discoveries toast a counter.
 *
 * The puzzle unlocks SEQUENTIALLY — each completed step lights a star in
 * the bottom-left constellation and reveals the next cryptic hint:
 *   1. boop the eggo three times
 *   2. hold a click to FULL charge (the grinding saw)
 *   3. shift+click a closed shape of light
 *   4. slingshot a volley into the workshop button
 *   5. click all four corners of the screen
 * Finishing awakens THE FACTORY: a synced audio-visual finale, and the
 * eggo turns golden forever (localStorage).
 */

const fx = (detail: Record<string, unknown>) =>
    window.dispatchEvent(new CustomEvent('mdflow:fx', { detail }));

// A-minor-pentatonic building blocks — everything stays in the page's key
const A3 = 220, C4 = 261.63, D4 = 293.66, E4 = 329.63, G4 = 392, A4 = 440,
    C5 = 523.25, E5 = 659.25, A5 = 880;
const PENTA = [A3, C4, D4, E4, G4, A4, C5, D4 * 2, E5, G4 * 2];
const CHORD = [A3, C4, E4, A4];

const EGG_COUNT = 23;

const HINTS = [
    '★ The egg likes attention. Boop it three times.',
    '★★ Patience: hold your click until the machine SCREAMS.',
    '★★★ Close a shape of light (shift+click, or two-finger taps).',
    '★★★★ Feed the factory: slingshot a volley into the Workshop.',
    '★★★★★ Bless all four corners of your world.',
    '⚡ THE FACTORY IS AWAKE. The egg is golden forever.',
];

const load = <T,>(key: string, fall: T): T => {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) as T : fall;
    } catch { return fall; }
};
const save = (key: string, v: unknown) => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ }
};

export const EasterEggs: React.FC = () => {
    const [toast, setToast] = useState<{ text: string; big?: boolean } | null>(null);
    const [foundCount, setFoundCount] = useState(() => load<string[]>('mdflow-eggs', []).length);
    const [step, setStep] = useState(() => load<number>('mdflow-puzzle', 0));
    const toastTimer = useRef(0);

    const show = (text: string, big = false, ms = 4500) => {
        window.clearTimeout(toastTimer.current);
        setToast({ text, big });
        toastTimer.current = window.setTimeout(() => setToast(null), ms);
    };

    useEffect(() => {
        // touch devices play too: tap/hold/scroll/two-finger eggs all work;
        // keyboard and hover eggs simply never fire there
        const found = new Set(load<string[]>('mdflow-eggs', []));
        let puzzleStep = load<number>('mdflow-puzzle', 0);
        const cools = new Map<string, number>();
        const timers: number[] = [];
        const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
        const cool = (id: string, ms: number) => {
            const now = performance.now();
            if ((cools.get(id) ?? 0) > now) return false;
            cools.set(id, now + ms);
            return true;
        };
        const discover = (id: string, label: string) => {
            if (found.has(id)) return;
            found.add(id);
            save('mdflow-eggs', [...found]);
            setFoundCount(found.size);
            show(`🥚 ${found.size}/${EGG_COUNT} — ${label}`);
            // first-find sparkle on top of the egg's own voice
            shaderAudio.playNotes([{ f: A5, type: 'sine', gain: 0.03, decay: 0.6, wet: 0.6 },
                { f: A5 * 1.5, at: 0.09, type: 'sine', gain: 0.025, decay: 0.8, wet: 0.6 }]);
        };
        const center = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

        // ---- the puzzle ----
        const advance = (expected: number) => {
            if (puzzleStep !== expected) return;
            puzzleStep++;
            save('mdflow-puzzle', puzzleStep);
            setStep(puzzleStep);
            // step chime: one more chord tone each star
            shaderAudio.playNotes(CHORD.slice(0, puzzleStep + 1).map((f, i) => (
                { f: f * 2, at: i * 0.13, type: 'sine' as OscillatorType, gain: 0.06, decay: 1.0, wet: 0.6 })));
            const c = center();
            fx({ type: 'burst', x: c.x, y: c.y, n: 6 + puzzleStep * 2, amp: 0.5, freqs: CHORD, grace: 0.6 });
            if (puzzleStep >= 5) later(factoryAwakens, 900);
            else show(`⭐ A star ignites (${puzzleStep}/5). Next: ${HINTS[puzzleStep]}`, true, 8000);
        };

        const factoryAwakens = () => {
            try { localStorage.setItem('mdflow-golden', '1'); } catch { /* private mode */ }
            window.dispatchEvent(new CustomEvent('mdflow:golden'));
            document.title = '⚡ mdflow — FACTORY MODE';
            shaderAudio.payoff();
            shaderAudio.subBoom(1.5);
            // grand fanfare: the motif climbs three times, then holds the sky
            const motif = [A3, E4, A4, C5, E5];
            for (let r = 0; r < 3; r++) {
                shaderAudio.playNotes(motif.map((f, i) => (
                    { f: f * (r + 1), at: r * 0.9 + i * 0.12, type: 'sawtooth' as OscillatorType, gain: 0.045, decay: 0.5, wet: 0.5 })));
            }
            shaderAudio.playNotes([A4, C5, E5, A5].map(f => (
                { f, at: 2.9, type: 'sine' as OscillatorType, gain: 0.05, decay: 3, wet: 0.9 })));
            // 7-second golden barrage
            const W = window.innerWidth, H = window.innerHeight;
            fx({ type: 'sweep' });
            for (let i = 0; i < 14; i++) {
                later(() => fx({
                    type: 'burst',
                    x: 60 + Math.random() * (W - 120), y: 60 + Math.random() * (H * 0.75),
                    n: 9, amp: 0.9, speed: 560, size: 1.4, grace: 0.8,
                    freqs: CHORD.map(f => f * 2),
                }), 300 + i * 420);
            }
            later(() => fx({ type: 'quake' }), 3200);
            for (let i = 0; i < 3; i++) later(() => fx({ type: 'excite' }), 500 + i * 2000);
            show('🏭⚡ THE FACTORY AWAKENS — all five stars found. Eggo is GOLDEN, forever.', true, 12000);
        };

        // step 1: three boops
        let boops = 0;
        const onBoop = () => {
            boops++;
            if (boops >= 3) advance(0);
        };
        // step 2: full charge
        const onFullCharge = () => advance(1);
        // step 3: closed light shape
        const onShape = () => advance(2);
        // step 4: volley into the workshop
        const onVolley = (ev: Event) => {
            if ((ev as CustomEvent<{ target: string }>).detail?.target === 'workshop') advance(3);
        };
        window.addEventListener('mdflow:boop', onBoop);
        window.addEventListener('mdflow:fullcharge', onFullCharge);
        window.addEventListener('mdflow:shape', onShape);
        window.addEventListener('mdflow:volley', onVolley);

        // ---- keyboard eggs: konami, "mdflow", "egg", b, h, arrow dance ----
        const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
        let keyBuf: string[] = [];
        let typeBuf = '';
        let arrowBuf: { k: string; t: number }[] = [];
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            const k = e.key.toLowerCase();
            keyBuf = [...keyBuf, k].slice(-10);
            if (KONAMI.every((v, i) => keyBuf[i] === v)) {
                keyBuf = [];
                discover('konami', 'GOD MODE (the old ways still work)');
                const c = center();
                for (let i = 0; i < 6; i++) {
                    later(() => fx({
                        type: 'burst', x: c.x + (Math.random() - 0.5) * 500, y: c.y + (Math.random() - 0.5) * 300,
                        n: 10, amp: 0.8, size: 1.5, freqs: CHORD.map(f => f * 2),
                    }), i * 260);
                }
                shaderAudio.playNotes(PENTA.concat(PENTA.map(f => f * 2)).map((f, i) => (
                    { f, at: i * 0.05, type: 'square' as OscillatorType, gain: 0.03, decay: 0.12 })));
            }
            if (k.length === 1) {
                typeBuf = (typeBuf + k).slice(-8);
                if (typeBuf.endsWith('mdflow')) {
                    discover('type-mdflow', 'you spoke its name');
                    const logo = document.querySelector('nav .font-display')?.getBoundingClientRect();
                    fx({ type: 'shock', x: (logo?.left ?? 80) + 40, y: (logo?.top ?? 30) + 15, amp: 1.1 });
                    shaderAudio.playNotes([A3, E4, A4, C5, E5].map((f, i) => (
                        { f, at: i * 0.09, type: 'sawtooth' as OscillatorType, gain: 0.045, decay: 0.5, wet: 0.4 })));
                }
                if (typeBuf.endsWith('egg')) {
                    typeBuf = '';
                    discover('type-egg', 'egg rain — you typed the magic word');
                    fx({ type: 'rain', n: 14, size: 1.2, freqs: CHORD.map(f => f * 2), stagger: 150 });
                    for (let i = 0; i < 3; i++) later(() => shaderAudio.boop(), i * 260);
                }
            }
            if (k === 'b' && cool('key-b', 1500)) {
                discover('key-b', 'bass drop');
                const c = center();
                fx({ type: 'shock', x: c.x, y: c.y, amp: -1.0 });
                shaderAudio.subBoom(1.3);
            }
            if (k === 'h' && cool('key-h', 2000)) {
                discover('key-h', 'the headline says hello');
                const hr = document.querySelector('[data-shader-headline]')?.getBoundingClientRect();
                if (hr && hr.bottom > 0 && hr.top < window.innerHeight) {
                    for (let i = 0; i < 6; i++) {
                        const px = hr.left + (i / 5) * hr.width;
                        later(() => fx({ type: 'shock', x: px, y: hr.top + hr.height / 2, amp: 0.45 }), i * 80);
                    }
                } else {
                    fx({ type: 'sweep', dir: 'down' });
                }
                shaderAudio.playNotes(PENTA.slice(0, 8).map((f, i) => (
                    { f: f * 2, at: i * 0.07, type: 'sine' as OscillatorType, gain: 0.035, decay: 0.3, wet: 0.3 })));
            }
            if (k === 'arrowleft' || k === 'arrowright') {
                const now = performance.now();
                arrowBuf = [...arrowBuf.filter(a => now - a.t < 2000), { k, t: now }].slice(-4);
                if (arrowBuf.length === 4
                    && arrowBuf[0].k === 'arrowleft' && arrowBuf[1].k === 'arrowright'
                    && arrowBuf[2].k === 'arrowleft' && arrowBuf[3].k === 'arrowright'
                    && cool('arrow-dance', 6000)) {
                    arrowBuf = [];
                    discover('arrow-dance', 'dance party — eggo felt that');
                    // pump the dance channel for 5s
                    let ticks = 0;
                    const pump = window.setInterval(() => {
                        window.dispatchEvent(new CustomEvent('mdflow:workshop-prox', { detail: { p: 1 } }));
                        if (++ticks > 50) window.clearInterval(pump);
                    }, 100);
                    timers.push(pump);
                    later(() => window.dispatchEvent(new CustomEvent('mdflow:workshop-prox', { detail: { p: 0 } })), 5200);
                    shaderAudio.playNotes([
                        { f: 180, gain: 0.16, decay: 0.12, type: 'sine' as OscillatorType },
                        { f: 150, at: 0.12, gain: 0.16, decay: 0.12, type: 'sine' as OscillatorType },
                        { f: 120, at: 0.24, gain: 0.17, decay: 0.12, type: 'sine' as OscillatorType },
                        { f: 100, at: 0.36, gain: 0.18, decay: 0.2, type: 'sine' as OscillatorType },
                        { f: 2400, at: 0.48, gain: 0.03, decay: 0.05, type: 'square' as OscillatorType },
                    ]);
                }
            }
        };
        window.addEventListener('keydown', onKey);

        // ---- click eggs: double, triple, alt, middle, corners, targets ----
        let clickTimes: number[] = [];
        let corners: Set<string> = new Set();
        let cornersAt = 0;
        const onClick = (e: MouseEvent) => {
            const now = performance.now();
            // alt+click: gravity flip
            if (e.altKey && cool('alt-click', 6000)) {
                discover('alt-click', 'gravity flip — the dots flee');
                fx({ type: 'flip', ms: 5000 });
                fx({ type: 'shock', x: e.clientX, y: e.clientY, amp: -0.7 });
                shaderAudio.whoosh(1400, 90, 0.9, 0.09);
                shaderAudio.playNotes([{ f: E4 * 2, type: 'sine', gain: 0.03, decay: 1.4, wet: 0.7 },
                    { f: E4 * 2 * 1.02, type: 'sine', gain: 0.03, decay: 1.4, wet: 0.7 }]);
                return;
            }
            // double / triple click
            clickTimes = [...clickTimes.filter(t => now - t < 700), now];
            if (clickTimes.length === 2 && cool('double-click', 1200)) {
                discover('double-click', 'echo bloom');
                for (let i = 0; i < 3; i++) {
                    later(() => fx({ type: 'shock', x: e.clientX, y: e.clientY, amp: 0.55 - i * 0.15 }), i * 170);
                }
                shaderAudio.playNotes([0, 0.18, 0.36].map((at, i) => (
                    { f: E5, at, type: 'sine' as OscillatorType, gain: 0.05 / (i + 1), decay: 0.5, wet: 0.3 + i * 0.25 })));
            }
            if (clickTimes.length >= 3 && cool('triple-click', 2500)) {
                clickTimes = [];
                discover('triple-click', 'firework fountain');
                fx({ type: 'fountain', x: e.clientX, y: e.clientY, n: 14, freqs: CHORD.map(f => f * 2) });
                shaderAudio.whoosh(300, 1500, 0.45, 0.08);
                shaderAudio.playNotes([C5, E5, G4 * 2, A5, C5 * 2].map((f, i) => (
                    { f, at: 0.4 + i * 0.09, type: 'sine' as OscillatorType, gain: 0.035, decay: 0.7, wet: 0.6 })));
            }
            // four corners ritual (also the final puzzle step)
            const m = 90;
            const W = window.innerWidth, H = window.innerHeight;
            const corner = (e.clientX < m && e.clientY < m) ? 'tl'
                : (e.clientX > W - m && e.clientY < m) ? 'tr'
                : (e.clientX < m && e.clientY > H - m) ? 'bl'
                : (e.clientX > W - m && e.clientY > H - m) ? 'br' : '';
            if (corner) {
                if (now - cornersAt > 12000) corners = new Set();
                cornersAt = now;
                corners.add(corner);
                fx({ type: 'shock', x: e.clientX, y: e.clientY, amp: 0.4 });
                if (corners.size === 4) {
                    corners = new Set();
                    discover('corners', 'the four corners ritual');
                    fx({ type: 'lightning', x: W / 2 });
                    [[0, 0], [W, 0], [0, H], [W, H]].forEach(([cx, cy], i) =>
                        later(() => fx({ type: 'shock', x: cx, y: cy, amp: 0.9 }), i * 110));
                    shaderAudio.playNotes([A3, C4, E4, 493.88].map((f, i) => (
                        { f, at: i * 0.15, type: 'sine' as OscillatorType, gain: 0.04, decay: 2.6, wet: 0.85 })));
                    advance(4);
                }
            }
            // decorated page elements
            const el = e.target as HTMLElement;
            if (el.closest?.('[data-egg="zap"]') && cool('footer-zap', 3000)) {
                discover('footer-zap', 'you summoned the lightning');
                fx({ type: 'lightning', x: e.clientX });
                shaderAudio.subBoom(1.4);
                shaderAudio.whoosh(900, 70, 1.1, 0.12);
            }
            if (el.closest?.('[data-egg="v3"]') && cool('v3-badge', 3000)) {
                discover('v3-badge', 'version fireworks');
                for (let i = 0; i < 3; i++) {
                    later(() => fx({
                        type: 'burst', x: e.clientX + (i - 1) * 120, y: e.clientY - 40 - i * 30,
                        n: 8, amp: 0.6, freqs: CHORD,
                    }), i * 220);
                }
                shaderAudio.playNotes([[A3, C4, E4], [C4, E4, A4], [E4, A4, C5]].flatMap((tri, i) =>
                    tri.map(f => ({ f: f * 2, at: i * 0.22, type: 'sawtooth' as OscillatorType, gain: 0.03, decay: 0.35, wet: 0.3 }))));
            }
            const logoHit = el.closest?.('[data-egg="logo"]');
            if (logoHit) {
                logoClicks = [...logoClicks.filter(t => now - t < 4000), now];
                if (logoClicks.length >= 5 && cool('logo-disco', 12000)) {
                    logoClicks = [];
                    discover('logo-disco', 'DISCO MODE');
                    document.documentElement.classList.add('egg-disco');
                    later(() => document.documentElement.classList.remove('egg-disco'), 8000);
                    shaderAudio.playNotes([
                        { f: 110, gain: 0.12, decay: 0.15, type: 'square' as OscillatorType },
                        { f: 110, at: 0.11, gain: 0.1, decay: 0.1, type: 'square' as OscillatorType },
                        { f: 164.8, at: 0.32, gain: 0.12, decay: 0.15, type: 'square' as OscillatorType },
                        { f: 110, at: 0.43, gain: 0.1, decay: 0.1, type: 'square' as OscillatorType },
                        { f: 196, at: 0.64, gain: 0.12, decay: 0.2, type: 'square' as OscillatorType },
                        { f: 220, at: 0.86, gain: 0.1, decay: 0.3, type: 'square' as OscillatorType },
                    ]);
                }
            }
        };
        let logoClicks: number[] = [];
        window.addEventListener('click', onClick);

        // middle-click: warp gate
        const onAux = (e: MouseEvent) => {
            if (e.button !== 1 || !cool('middle-click', 2500)) return;
            discover('middle-click', 'warp gate — as above, so below');
            const mx = window.innerWidth - e.clientX;
            const my = window.innerHeight - e.clientY;
            fx({ type: 'shock', x: e.clientX, y: e.clientY, amp: 0.8 });
            fx({ type: 'shock', x: mx, y: my, amp: -0.8 });
            fx({ type: 'burst', x: mx, y: my, n: 8, amp: 0.3, freqs: [E4 * 2] });
            shaderAudio.whoosh(200, 900, 0.3, 0.07);
            shaderAudio.whoosh(900, 200, 0.3, 0.07);
            shaderAudio.playNotes([{ f: G4 * 2, type: 'sine', gain: 0.04, decay: 0.8, wet: 0.7 },
                { f: G4 * 2 * 0.98, at: 0.06, type: 'sine', gain: 0.04, decay: 0.8, wet: 0.7 }]);
        };
        window.addEventListener('auxclick', onAux);

        // ---- gesture eggs: shake, circle, overload hold ----
        let lastX = 0, lastDx = 0, flips: number[] = [];
        let headings: { a: number; t: number }[] = [];
        let turn = 0;
        let prevGX = 0, prevGY = 0;
        const onMove = (e: PointerEvent) => {
            const now = performance.now();
            const dx = e.clientX - lastX;
            lastX = e.clientX;
            // shake: rapid horizontal direction reversals (mouse or finger)
            if (Math.abs(dx) > 22 && Math.sign(dx) !== Math.sign(lastDx) && lastDx !== 0) {
                flips = [...flips.filter(t => now - t < 1200), now];
                if (flips.length >= 6 && cool('shake', 8000)) {
                    flips = [];
                    discover('shake', 'earthquake!');
                    fx({ type: 'quake' });
                    shaderAudio.subBoom(1);
                    shaderAudio.whoosh(130, 55, 0.9, 0.13);
                }
            }
            if (Math.abs(dx) > 4) lastDx = dx;
            // circle: accumulate heading turn while gliding (mouse: no
            // buttons; touch: any drag). Manual deltas — movementX/Y is
            // unreliable for touch pointers in some engines.
            const mdx = e.clientX - prevGX;
            const mdy = e.clientY - prevGY;
            prevGX = e.clientX;
            prevGY = e.clientY;
            if ((e.buttons === 0 || e.pointerType === 'touch') && (Math.abs(mdx) + Math.abs(mdy)) > 3) {
                const a = Math.atan2(mdy, mdx);
                const prev = headings[headings.length - 1];
                headings = [...headings.filter(h => now - h.t < 1600), { a, t: now }];
                if (prev && now - prev.t < 250) {
                    let da = a - prev.a;
                    while (da > Math.PI) da -= Math.PI * 2;
                    while (da < -Math.PI) da += Math.PI * 2;
                    turn = Math.abs(da) < 2.4 ? turn + da : 0;
                } else {
                    turn = 0;
                }
                if (Math.abs(turn) > Math.PI * 2.1 && cool('circle', 6000)) {
                    turn = 0;
                    discover('circle', 'you drew the halo');
                    fx({ type: 'burst', x: e.clientX, y: e.clientY, n: 12, speed: 300, amp: 0.6, grace: 1.2, freqs: PENTA.slice(0, 5).map(f => f * 2) });
                    shaderAudio.playNotes(PENTA.slice(0, 10).map((f, i) => (
                        { f: f * 2, at: i * 0.06, type: 'triangle' as OscillatorType, gain: 0.03, decay: 0.5, wet: 0.6 })));
                }
            }
        };
        window.addEventListener('pointermove', onMove, { passive: true });

        // overload: a still hold sustained to 10s (past full charge)
        let holdTimer = 0;
        let holdStart = { x: 0, y: 0 };
        const onDown = (e: PointerEvent) => {
            holdStart = { x: e.clientX, y: e.clientY };
            window.clearTimeout(holdTimer);
            holdTimer = window.setTimeout(() => {
                if (!cool('overload', 12000)) return;
                discover('overload', 'OVERLOAD — you held past the redline');
                fx({ type: 'shock', x: holdStart.x, y: holdStart.y, amp: 2 });
                fx({ type: 'excite' });
                fx({ type: 'burst', x: holdStart.x, y: holdStart.y, n: 14, speed: 700, size: 1.8, amp: 1.4, freqs: CHORD.map(f => f * 2) });
                shaderAudio.subBoom(1.6);
                shaderAudio.whoosh(2200, 90, 1.1, 0.14);
                shaderAudio.playNotes([{ f: A5 * 2, type: 'square', gain: 0.04, decay: 0.5, wet: 0.5 }]);
            }, 10000);
            timers.push(holdTimer);
        };
        const cancelHold = (e?: PointerEvent) => {
            if (e && Math.hypot(e.clientX - holdStart.x, e.clientY - holdStart.y) < 12 && e.type === 'pointermove') return;
            window.clearTimeout(holdTimer);
        };
        window.addEventListener('pointerdown', onDown, { passive: true });
        window.addEventListener('pointerup', cancelHold as EventListener, { passive: true });
        window.addEventListener('pointercancel', cancelHold as EventListener, { passive: true });
        window.addEventListener('pointermove', cancelHold as EventListener, { passive: true });

        // ---- monster hunt: ShaderGuide's pixel creatures, gate-captured ----
        // The shader layer spawns wandering 8-bit monsters; closing a
        // shift+click shape around one dispatches this. First capture is
        // the discovery; every capture after grows the jar count.
        let monsterJar = load<number>('mdflow-monsters', 0);
        const onMonster = () => {
            monsterJar++;
            save('mdflow-monsters', monsterJar);
            const first = !found.has('monster-hunt');
            discover('monster-hunt', 'gatekeeper — a pixel monster, captured in light');
            if (!first) show(`👾 gate closed — ${monsterJar} pixel monsters in the jar`);
        };
        window.addEventListener('mdflow:monster', onMonster);

        // ---- eggo pop: 5 spark impacts on the egg within 2.5s ----
        let eggHits: number[] = [];
        const onSparkHit = (ev: Event) => {
            const d = (ev as CustomEvent<{ x: number; y: number }>).detail;
            const er = document.querySelector('[data-shader-egg]')?.getBoundingClientRect();
            if (!er || d.x < er.left - 8 || d.x > er.right + 8 || d.y < er.top - 8 || d.y > er.bottom + 8) return;
            const now = performance.now();
            eggHits = [...eggHits.filter(t => now - t < 2500), now];
            if (eggHits.length >= 5 && cool('egg-pop', 8000)) {
                eggHits = [];
                discover('egg-pop', 'scrambled! (5 hits, 2.5 seconds)');
                fx({ type: 'burst', x: (er.left + er.right) / 2, y: (er.top + er.bottom) / 2, n: 12, amp: 1, size: 1.3, freqs: [C5, E5] });
                shaderAudio.boop();
                shaderAudio.playNotes([C5, G4, E5, C5].map((f, i) => (
                    { f, at: 0.1 + i * 0.09, type: 'triangle' as OscillatorType, gain: 0.05, decay: 0.25 })));
            }
        };
        window.addEventListener('mdflow:sparkhit', onSparkHit);

        // ---- ambient eggs: idle fireflies, elevator, shy volume, tab return ----
        let idleTimer = 0;
        const armIdle = () => {
            window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(() => {
                discover('idle-fireflies', 'fireflies come out when it’s quiet');
                fx({ type: 'rain', n: 12, speed: 60, stagger: 420, life: 4, size: 0.8, grace: 3 });
                shaderAudio.playNotes([E5, C5, A4, C5, E5, A5].map((f, i) => (
                    { f, at: i * 0.5, type: 'sine' as OscillatorType, gain: 0.028, decay: 1.4, wet: 0.8 })));
            }, 30000);
            timers.push(idleTimer);
        };
        const activity = () => armIdle();
        window.addEventListener('pointermove', activity, { passive: true });
        window.addEventListener('pointerdown', activity, { passive: true });
        window.addEventListener('keydown', activity);
        window.addEventListener('scroll', activity, { passive: true });
        armIdle();

        let bottomAt = 0;
        const onScroll = () => {
            const bottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 6;
            const top = window.scrollY <= 6;
            const now = performance.now();
            if (bottom) bottomAt = now;
            if (top && bottomAt && now - bottomAt < 3500 && cool('elevator', 10000)) {
                bottomAt = 0;
                discover('elevator', 'express elevator to the top');
                fx({ type: 'sweep' });
                shaderAudio.whoosh(150, 950, 0.7, 0.1);
                shaderAudio.playNotes([{ f: C5 * 2, at: 0.7, type: 'sine', gain: 0.05, decay: 1.2, wet: 0.5 }]);
            }
        };
        window.addEventListener('scroll', onScroll, { passive: true });

        let volTimer = 0;
        const volBtn = document.querySelector<HTMLElement>('[data-egg="volume"]');
        const volEnter = () => {
            volTimer = window.setTimeout(() => {
                discover('shy-volume', 'the speaker is ticklish');
                volBtn?.classList.add('egg-wiggle');
                later(() => volBtn?.classList.remove('egg-wiggle'), 1600);
                shaderAudio.playNotes([0, 0.15, 0.3, 0.45].map(at => (
                    { f: 2100, at, type: 'sine' as OscillatorType, gain: 0.022, decay: 0.04 })));
                const r = volBtn?.getBoundingClientRect();
                if (r) fx({ type: 'shock', x: r.left + r.width / 2, y: r.top + r.height / 2, amp: 0.35 });
            }, 3000);
            timers.push(volTimer);
        };
        const volLeave = () => window.clearTimeout(volTimer);
        volBtn?.addEventListener('pointerenter', volEnter);
        volBtn?.addEventListener('pointerleave', volLeave);

        let hiddenAt = 0;
        const onVis = () => {
            if (document.hidden) {
                hiddenAt = performance.now();
            } else if (hiddenAt && performance.now() - hiddenAt > 15000 && cool('welcome-back', 20000)) {
                discover('welcome-back', 'welcome back — it missed you');
                const c = center();
                fx({ type: 'shock', x: c.x, y: c.y, amp: 0.7 });
                shaderAudio.playNotes([{ f: C5, type: 'sine', gain: 0.045, decay: 1.2, wet: 0.6 },
                    { f: E5, at: 0.12, type: 'sine', gain: 0.04, decay: 1.4, wet: 0.6 }]);
            }
        };
        document.addEventListener('visibilitychange', onVis);

        // one gentle nudge per session that secrets exist at all
        later(() => {
            try {
                if (found.size === 0 && !sessionStorage.getItem('mdflow-nudge')) {
                    sessionStorage.setItem('mdflow-nudge', '1');
                    show(`✨ this page keeps secrets — ${EGG_COUNT} of them, and five stars`, false, 6000);
                }
            } catch { /* private mode */ }
        }, 25000);

        return () => {
            window.removeEventListener('mdflow:boop', onBoop);
            window.removeEventListener('mdflow:fullcharge', onFullCharge);
            window.removeEventListener('mdflow:shape', onShape);
            window.removeEventListener('mdflow:volley', onVolley);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('click', onClick);
            window.removeEventListener('auxclick', onAux);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerdown', onDown);
            window.removeEventListener('pointerup', cancelHold as EventListener);
            window.removeEventListener('pointercancel', cancelHold as EventListener);
            window.removeEventListener('pointermove', cancelHold as EventListener);
            window.removeEventListener('mdflow:monster', onMonster);
            window.removeEventListener('mdflow:sparkhit', onSparkHit);
            window.removeEventListener('pointermove', activity);
            window.removeEventListener('pointerdown', activity);
            window.removeEventListener('keydown', activity);
            window.removeEventListener('scroll', activity);
            window.removeEventListener('scroll', onScroll);
            volBtn?.removeEventListener('pointerenter', volEnter);
            volBtn?.removeEventListener('pointerleave', volLeave);
            document.removeEventListener('visibilitychange', onVis);
            for (const id of timers) { window.clearTimeout(id); window.clearInterval(id); }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <>
            <style>{`
                @keyframes egg-hue { to { filter: hue-rotate(360deg); } }
                .egg-disco { animation: egg-hue 1.6s linear infinite; }
                @keyframes egg-wiggle-kf {
                    0%, 100% { transform: rotate(0); }
                    25% { transform: rotate(14deg) scale(1.15); }
                    75% { transform: rotate(-14deg) scale(1.15); }
                }
                .egg-wiggle { animation: egg-wiggle-kf 0.28s ease-in-out 4; }
                @keyframes egg-toast-in {
                    from { opacity: 0; transform: translateY(12px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
            {/* puzzle constellation: five stars + the egg counter */}
            <div className="fixed bottom-3 left-3 z-50 flex items-center gap-2 select-none">
                <button
                    aria-label={`Secret puzzle progress: ${step} of 5 stars`}
                    onClick={() => show(step >= 5 ? HINTS[5] : `Hint: ${HINTS[step]}`, false, 7000)}
                    className="flex items-center gap-1 opacity-50 hover:opacity-100 transition-opacity cursor-pointer bg-transparent"
                >
                    {[0, 1, 2, 3, 4].map(i => (
                        <span
                            key={i}
                            className={i < step
                                ? 'text-amber-400 drop-shadow-[0_0_5px_rgba(251,191,36,0.9)] text-xs'
                                : 'text-zinc-700 text-xs'}
                        >
                            {'★'}
                        </span>
                    ))}
                </button>
                {foundCount > 0 && (
                    <button
                        aria-label={`${foundCount} of ${EGG_COUNT} easter eggs found`}
                        onClick={() => show(`🥚 ${foundCount}/${EGG_COUNT} easter eggs found. Keep poking.`, false, 5000)}
                        className="text-[10px] font-mono text-zinc-600 hover:text-zinc-300 transition-colors opacity-70 hover:opacity-100 bg-transparent cursor-pointer"
                    >
                        {'🥚'}{foundCount}/{EGG_COUNT}
                    </button>
                )}
            </div>
            {/* discovery / hint toast */}
            {toast && (
                <div
                    className={`fixed bottom-10 left-3 z-50 max-w-sm rounded-lg border px-4 py-3 font-mono backdrop-blur-md pointer-events-none ${
                        toast.big
                            ? 'text-sm border-amber-500/60 bg-amber-950/60 text-amber-200 shadow-[0_0_30px_rgba(251,191,36,0.35)]'
                            : 'text-xs border-zinc-700/80 bg-zinc-950/80 text-zinc-300'
                    }`}
                    style={{ animation: 'egg-toast-in 0.25s ease-out' }}
                >
                    {toast.text}
                </div>
            )}
        </>
    );
};
