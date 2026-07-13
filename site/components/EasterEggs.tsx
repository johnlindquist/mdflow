import React, { useEffect, useRef, useState } from 'react';
import { shaderAudio } from './shaderAudio';
import { EGG_CATALOG, EGG_COUNT, type EggId } from './easter-eggs/catalog';
import {
  addEgg,
  addPuzzleProof,
  loadProgress,
  saveProgress,
  visiblePuzzleStep,
  type EggProgress,
  type PuzzleProof,
} from './easter-eggs/progress';
import {
  advanceShake,
  classifyClickCadence,
  isInteractiveTarget,
  KONAMI,
  matchesSequence,
  pushTimedKey,
  pushTypedCharacter,
  shouldIgnoreKey,
  TimerBag,
  type ClickSample,
  type ShakeState,
  type TimedKey,
} from './easter-eggs/recognizers';
import type { PlaygroundSignal } from './easter-eggs/events';
import { EggHUD } from './easter-eggs/EggHUD';
import { EggRewardLayer, type EggReward } from './easter-eggs/EggRewardLayer';
import { FallbackPlayground } from './easter-eggs/FallbackPlayground';

const fx = (detail: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent('mdflow:fx', { detail }));

const A3 = 220;
const C4 = 261.63;
const D4 = 293.66;
const E4 = 329.63;
const G4 = 392;
const A4 = 440;
const C5 = 523.25;
const E5 = 659.25;
const A5 = 880;
const PENTA = [A3, C4, D4, E4, G4, A4, C5, D4 * 2, E5, G4 * 2];
const CHORD = [A3, C4, E4, A4];

const PUZZLE_HINTS = [
  '★ The egg likes attention. Boop it three times.',
  '★★ Patience: hold a quiet surface until the machine reaches FULL charge.',
  '★★★ Close a shape of light (shift+click, or the fallback constellation).',
  '★★★★ Feed the factory: slingshot a volley into the Workshop.',
  '★★★★★ Bless all four corners of your world.',
  '⚡ THE FACTORY IS AWAKE. The egg is golden forever.',
];

const storage = (): Storage | undefined => {
  try { return window.localStorage; } catch { return undefined; }
};

const element = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const isVisible = (target: Element | null): target is Element => {
  if (!target) return false;
  const rect = target.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
};

export const EasterEggs: React.FC = () => {
  const [progress, setProgress] = useState<EggProgress>(() => loadProgress(storage()));
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const [rewards, setRewards] = useState<EggReward[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [reducedMotion, setReducedMotion] = useState(false);
  const [fallbackPlayground, setFallbackPlayground] = useState(false);
  const rewardKey = useRef(0);

  const queueReward = (reward: Omit<EggReward, 'key'>) => {
    setRewards((queue) => [...queue, { ...reward, key: ++rewardKey.current }]);
  };

  useEffect(() => {
    if (!rewards[0]) return;
    const timeout = window.setTimeout(() => setRewards((queue) => queue.slice(1)), rewards[0].id === 'factory-finale' ? 9000 : 4300);
    return () => window.clearTimeout(timeout);
  }, [rewards]);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const compact = window.matchMedia('(max-width: 767px)');
    const update = () => {
      setReducedMotion(motion.matches);
      setFallbackPlayground(motion.matches || compact.matches);
    };
    update();
    motion.addEventListener('change', update);
    compact.addEventListener('change', update);
    return () => {
      motion.removeEventListener('change', update);
      compact.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => {
      const compact = window.matchMedia('(max-width: 767px)').matches;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setFallbackPlayground(compact || reduced || !root.classList.contains('shader-fx'));
    };
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    const timer = window.setTimeout(update, 750);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const timers = new TimerBag();
    const controller = new AbortController();
    const { signal } = controller;
    const cools = new Map<string, number>();
    let originalTitle = document.title;
    let boops = 0;
    let idleTimer = 0;
    let hiddenAt = 0;
    let bottomAt = 0;
    let clickSamples: ClickSample[] = [];
    let keyBuffer: TimedKey[] = [];
    let typed = '';
    let lastTypedAt = 0;
    let eggoArrows: TimedKey[] = [];
    let logoClicks: number[] = [];
    let cornerStart = 0;
    const corners = new Set<string>();
    let shake: ShakeState = { lastX: 0, lastDirection: 0, reversals: [] };
    let previousGesturePoint: { x: number; y: number; angle?: number; at: number } | null = null;
    let accumulatedTurn = 0;
    let holdTimer = 0;
    let chargeTimer = 0;
    let holdPoint = { x: 0, y: 0 };
    let holdTarget: EventTarget | null = null;
    let volumeTimer = 0;
    let eggHits: number[] = [];
    let constellationKeys: TimedKey[] = [];

    const now = () => performance.now();
    const center = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const cool = (id: string, duration: number) => {
      const time = now();
      if ((cools.get(id) ?? 0) > time) return false;
      cools.set(id, time + duration);
      return true;
    };
    const commit = (next: EggProgress) => {
      progressRef.current = next;
      setProgress(next);
      saveProgress(storage(), next);
      try {
        localStorage.setItem('mdflow-eggs', JSON.stringify(next.found));
        localStorage.setItem('mdflow-puzzle', JSON.stringify(visiblePuzzleStep(next)));
        localStorage.setItem('mdflow-monsters', JSON.stringify(next.monsterJar));
        if (next.golden) localStorage.setItem('mdflow-golden', '1');
      } catch { /* compatibility writes are best effort */ }
    };
    const addTemporaryClass = (target: Element | null, className: string, duration = 1800) => {
      if (!target) return;
      target.classList.add(className);
      timers.later(() => target.classList.remove(className), duration);
    };
    const reward = (id: EggReward['id'], text: string, options: Partial<Omit<EggReward, 'key' | 'id' | 'text'>> = {}) => {
      queueReward({ id, text, ...options });
      setAnnouncement(text);
    };
    const discover = (id: EggId, text: string, options: Partial<Omit<EggReward, 'key' | 'id' | 'text'>> = {}) => {
      const first = !progressRef.current.found.includes(id);
      if (first) {
        commit(addEgg(progressRef.current, id));
        shaderAudio.playNotes([
          { f: A5, type: 'sine', gain: 0.025, decay: 0.45, wet: 0.5 },
          { f: A5 * 1.5, at: 0.08, type: 'sine', gain: 0.02, decay: 0.6, wet: 0.6 },
        ]);
      }
      reward(id, `${first ? `🥚 ${progressRef.current.found.length}/${EGG_COUNT} — ` : ''}${text}`, options);
    };
    const celebrateGold = () => {
      window.dispatchEvent(new CustomEvent('mdflow:golden'));
      document.title = '⚡ mdflow — FACTORY MODE';
      shaderAudio.payoff();
      shaderAudio.subBoom(1.25);
      fx({ type: 'sweep' });
      for (let index = 0; index < 8; index++) {
        timers.later(() => fx({
          type: 'burst',
          x: 60 + Math.random() * Math.max(1, window.innerWidth - 120),
          y: 60 + Math.random() * window.innerHeight * 0.7,
          n: 7,
          amp: 0.65,
          freqs: CHORD.map((frequency) => frequency * 2),
        }), 250 + index * 350);
      }
      reward('factory-finale', '🏭⚡ THE FACTORY IS AWAKE — Eggo is golden forever.');
      timers.later(() => { document.title = originalTitle; }, 8000);
    };
    const proof = (value: PuzzleProof) => {
      const before = progressRef.current;
      const next = addPuzzleProof(before, value);
      if (next === before) return;
      commit(next);
      const step = visiblePuzzleStep(next);
      shaderAudio.playNotes(CHORD.slice(0, Math.min(4, step + 1)).map((frequency, index) => ({
        f: frequency * 2,
        at: index * 0.12,
        type: 'sine' as OscillatorType,
        gain: 0.05,
        decay: 0.8,
        wet: 0.55,
      })));
      if (!before.golden && next.golden) {
        timers.later(celebrateGold, 700);
      } else {
        queueReward({ id: 'puzzle-star', text: `⭐ A star ignites (${step}/5). ${PUZZLE_HINTS[step]}` });
        setAnnouncement(`Factory puzzle: ${step} of 5 stars. ${PUZZLE_HINTS[step]}`);
      }
    };

    if (progressRef.current.golden) {
      try { localStorage.setItem('mdflow-golden', '1'); } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('mdflow:golden'));
    }

    const onPlayground = (event: Event) => {
      const detail = (event as CustomEvent<PlaygroundSignal>).detail;
      if (!detail) return;
      if (detail.kind === 'boop') {
        boops++;
        if (boops >= 3) proof('three-boops');
      } else if (detail.kind === 'full-charge') proof('full-charge');
      else if (detail.kind === 'shape-closed') proof('closed-shape');
      else if (detail.kind === 'volley-complete' && detail.target === 'workshop' && (detail.landed ?? 2) >= 2) proof('workshop-volley');
      else if (detail.kind === 'monster-captured') {
        const next = { ...progressRef.current, monsterJar: progressRef.current.monsterJar + 1 };
        commit(next);
        discover('monster-hunt', `Bestiary voice #${next.monsterJar} captured.`, { seed: detail.seed });
      } else if (detail.kind === 'spark-impact' && detail.target === 'eggo') {
        const time = now();
        eggHits = [...eggHits.filter((hit) => time - hit < 2500), time];
        if (eggHits.length >= 5 && cool('egg-pop', 8000)) {
          eggHits = [];
          addTemporaryClass(element('[data-shader-egg]'), 'egg-pop-target');
          discover('egg-pop', 'Eggo cracked open a fortune: Small flows open large doors.', { point: detail.point });
          shaderAudio.boop();
        }
      }
    };
    window.addEventListener('mdflow:playground-signal', onPlayground, { signal });

    window.addEventListener('mdflow:boop', () => onPlayground(new CustomEvent('x', { detail: { kind: 'boop' } })), { signal });
    window.addEventListener('mdflow:fullcharge', () => onPlayground(new CustomEvent('x', { detail: { kind: 'full-charge' } })), { signal });
    window.addEventListener('mdflow:shape', () => onPlayground(new CustomEvent('x', { detail: { kind: 'shape-closed' } })), { signal });
    window.addEventListener('mdflow:volley', (event) => {
      const detail = (event as CustomEvent<{ target?: string; landed?: number }>).detail;
      onPlayground(new CustomEvent('x', { detail: { kind: 'volley-complete', target: detail?.target ?? '', landed: detail?.landed } }));
    }, { signal });
    window.addEventListener('mdflow:monster', (event) => {
      const detail = (event as CustomEvent<{ method?: 'gate' | 'darts'; seed?: number }>).detail;
      onPlayground(new CustomEvent('x', { detail: { kind: 'monster-captured', method: detail?.method ?? 'gate', seed: detail?.seed } }));
    }, { signal });
    window.addEventListener('mdflow:sparkhit', (event) => {
      const detail = (event as CustomEvent<{ x: number; y: number; target?: string }>).detail;
      if (!detail) return;
      let target = detail.target;
      if (!target) {
        const rect = element('[data-shader-egg]')?.getBoundingClientRect();
        if (rect && detail.x >= rect.left - 8 && detail.x <= rect.right + 8 && detail.y >= rect.top - 8 && detail.y <= rect.bottom + 8) target = 'eggo';
      }
      onPlayground(new CustomEvent('x', { detail: { kind: 'spark-impact', target: target === 'eggo' ? 'eggo' : 'other', point: { x: detail.x, y: detail.y } } }));
    }, { signal });

    const runKonami = () => {
      discover('konami', 'GOD MODE compiled for play only. Guardrails unchanged; shield online for five seconds.');
      document.documentElement.dataset.eggShield = 'true';
      timers.later(() => { delete document.documentElement.dataset.eggShield; }, 5000);
      shaderAudio.playNotes(PENTA.concat(PENTA.map((frequency) => frequency * 2)).map((frequency, index) => ({
        f: frequency,
        at: index * 0.045,
        type: 'square' as OscillatorType,
        gain: 0.025,
        decay: 0.11,
      })));
    };

    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const constellation = Boolean(target?.closest('[data-egg="constellation"]'));
      const eggo = Boolean(target?.closest('[data-shader-egg]') || element('[data-shader-egg]:hover'));

      if (constellation) {
        const key = event.key.toLowerCase();
        if (key === ' ') {
          event.preventDefault();
          if (event.repeat) return;
          holdTimer = timers.later(() => {
            holdTimer = 0;
            proof('full-charge');
            discover('overload', 'CHARGE 117% — CIRCUIT BREAKER TRIPPED.');
          }, 10000);
          chargeTimer = timers.later(() => {
            chargeTimer = 0;
            proof('full-charge');
          }, 4250);
          return;
        }
        if (event.shiftKey && key === 'enter') {
          proof('closed-shape');
          return;
        }
        if (event.shiftKey && key === 'arrowup') {
          proof('workshop-volley');
          return;
        }
        constellationKeys = pushTimedKey(constellationKeys, key, now(), 2500, 6);
        if (matchesSequence(constellationKeys, ['q', 'e', 'z', 'c'])) {
          corners.clear();
          proof('four-corners');
          discover('corners', 'The four keyboard corners complete a luminous seal.');
        } else if (matchesSequence(constellationKeys, ['arrowup', 'arrowright', 'arrowdown', 'arrowleft'])) {
          discover('circle', 'A complete orbit remains in the constellation.');
        }
        return;
      }

      if (shouldIgnoreKey(event)) return;
      const key = event.key.toLowerCase();
      const time = now();
      keyBuffer = pushTimedKey(keyBuffer, key, time, 2000, KONAMI.length);
      if (matchesSequence(keyBuffer, KONAMI)) {
        keyBuffer = [];
        typed = '';
        eggoArrows = [];
        runKonami();
        return;
      }

      if (key.length === 1) {
        if (time - lastTypedAt > 1800) typed = '';
        lastTypedAt = time;
        typed = pushTypedCharacter(typed, key);
        if (typed.endsWith('mdflow')) {
          typed = '';
          addTemporaryClass(element('[data-egg="logo"]'), 'egg-name-resolved', 1300);
          discover('type-mdflow', 'name resolved — the FlowMark found its line.');
        } else if (typed.endsWith('egg')) {
          typed = '';
          discover('type-egg', 'Egg weather: one shell cracked into a clue.');
          fx({ type: 'rain', n: 12, size: 1.1, freqs: CHORD.map((frequency) => frequency * 2), stagger: 130 });
        } else if (typed.endsWith('bass')) {
          typed = '';
          addTemporaryClass(element('[data-egg-grid]'), 'egg-bass', 800);
          discover('bass-drop', 'The decorative grid absorbed one bass hit.');
          shaderAudio.subBoom(1.15);
        }
      }

      if (key === 'h') {
        const headline = element('[data-egg="headline"]');
        if (isVisible(headline) && cool('headline-hello', 3000)) {
          addTemporaryClass(headline, 'egg-headline-hello', 1800);
          discover('headline-hello', 'HELLO, HUMAN.');
        }
      }

      if (eggo && (key === 'arrowleft' || key === 'arrowright')) {
        eggoArrows = pushTimedKey(eggoArrows, key, time, 2000, 4);
        if (matchesSequence(eggoArrows, ['arrowleft', 'arrowright', 'arrowleft', 'arrowright']) && cool('eggo-dance', 6000)) {
          eggoArrows = [];
          addTemporaryClass(element('[data-shader-egg]'), 'egg-eggo-dance', 2200);
          discover('eggo-dance', '♪ Eggo performs the four-beat choreography.');
          let ticks = 0;
          const interval = timers.every(() => {
            window.dispatchEvent(new CustomEvent('mdflow:workshop-prox', { detail: { p: 1 } }));
            if (++ticks >= 20) {
              timers.clear(interval);
              window.dispatchEvent(new CustomEvent('mdflow:workshop-prox', { detail: { p: 0 } }));
            }
          }, 100);
        }
      }
    };
    window.addEventListener('keydown', onKey, { signal });
    window.addEventListener('keyup', (event) => {
      if (event.key === ' ') {
        if (holdTimer) timers.clear(holdTimer);
        if (chargeTimer) timers.clear(chargeTimer);
        holdTimer = 0;
        chargeTimer = 0;
      }
    }, { signal });

    const completeCorner = (event: MouseEvent) => {
      const margin = 90;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const key = event.clientX < margin && event.clientY < margin ? 'tl'
        : event.clientX > width - margin && event.clientY < margin ? 'tr'
          : event.clientX < margin && event.clientY > height - margin ? 'bl'
            : event.clientX > width - margin && event.clientY > height - margin ? 'br'
              : '';
      if (!key) return;
      const time = now();
      if (!cornerStart || time - cornerStart > 12000) {
        corners.clear();
        cornerStart = time;
      }
      corners.add(key);
      if (corners.size === 4) {
        corners.clear();
        cornerStart = 0;
        proof('four-corners');
        discover('corners', 'A luminous frame connects all four corners.');
      }
    };

    const onClick = (event: MouseEvent) => {
      completeCorner(event);
      const target = event.target instanceof Element ? event.target : null;
      const time = now();

      if (target?.closest('[data-egg="zap"]')) {
        addTemporaryClass(element('#features'), 'egg-footer-zap', 1200);
        discover('footer-zap', 'Electricity travelled up the page connector.');
        shaderAudio.subBoom(1);
        return;
      }
      if (target?.closest('[data-egg="version"]')) {
        addTemporaryClass(target.closest('[data-egg="version"]'), 'egg-version-split', 1700);
        discover('version-badge', 'Major · minor · patch separated, then resolved.');
        return;
      }
      const logo = target?.closest('[data-egg="logo"]');
      if (logo) {
        logoClicks = [...logoClicks.filter((click) => time - click < 4000), time];
        if (logoClicks.length >= 5 && cool('logo-disco', 12000)) {
          logoClicks = [];
          addTemporaryClass(logo, 'egg-logo-disco', 3000);
          discover('logo-disco', 'The FlowMark became a scoped three-channel equalizer.');
        }
        return;
      }
      if (isInteractiveTarget(event.target)) return;

      if (event.altKey && cool('alt-click', 6000)) {
        discover('alt-click', 'GRAVITY −1g — a guaranteed field turns upward.', { point: { x: event.clientX, y: event.clientY } });
        fx({ type: 'burst', x: event.clientX, y: event.clientY, n: 8, amp: 0.4, freqs: [E4, G4, A4] });
        fx({ type: 'flip', ms: 4000 });
        return;
      }

      const cadence = classifyClickCadence(clickSamples, {
        at: time,
        x: event.clientX,
        y: event.clientY,
        pointerType: 'mouse',
        surface: target?.closest('section, footer, nav, main') ?? document.body,
      });
      clickSamples = cadence.samples;
      if (cadence.beat === 2) {
        discover('click-cadence', 'Two translucent echoes answer the beat.', { point: { x: event.clientX, y: event.clientY } });
      } else if (cadence.beat === 3) {
        clickSamples = [];
        discover('click-cadence', 'The third beat turns the echoes into markdown.', { point: { x: event.clientX, y: event.clientY }, escalated: true });
        fx({ type: 'fountain', x: event.clientX, y: event.clientY, n: 10, freqs: CHORD.map((frequency) => frequency * 2) });
      }
    };
    window.addEventListener('click', onClick, { signal });

    const warp = (point?: { x: number; y: number }) => {
      if (!cool('middle-click', 2200)) return;
      const origin = point ?? center();
      discover('middle-click', 'A spark crossed two mirrored portals.', { point: origin });
      fx({ type: 'shock', x: origin.x, y: origin.y, amp: 0.7 });
      fx({ type: 'shock', x: window.innerWidth - origin.x, y: window.innerHeight - origin.y, amp: -0.7 });
    };
    window.addEventListener('auxclick', (event) => {
      if (event.button === 1 && !isInteractiveTarget(event.target)) warp({ x: event.clientX, y: event.clientY });
    }, { signal });
    const onHash = () => { if (window.location.hash === '#warp') warp(); };
    window.addEventListener('hashchange', onHash, { signal });
    onHash();

    const onPointerMove = (event: PointerEvent) => {
      if (isInteractiveTarget(event.target)) return;
      const time = now();
      const shakeResult = advanceShake(shake, event.clientX, time);
      shake = shakeResult.state;
      if (shakeResult.complete && cool('shake', 8000)) {
        addTemporaryClass(element('[data-egg-grid]'), 'egg-shake-grid', 900);
        discover('shake', 'The grid shook one markdown glyph loose.');
      }

      if (holdTimer && (event.target !== holdTarget || Math.hypot(event.clientX - holdPoint.x, event.clientY - holdPoint.y) > 12)) {
        timers.clear(holdTimer);
        holdTimer = 0;
      }

      if (event.buttons !== 0 && event.pointerType !== 'touch') {
        previousGesturePoint = null;
        accumulatedTurn = 0;
        return;
      }
      if (!previousGesturePoint) {
        previousGesturePoint = { x: event.clientX, y: event.clientY, at: time };
        return;
      }
      const dx = event.clientX - previousGesturePoint.x;
      const dy = event.clientY - previousGesturePoint.y;
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      const angle = Math.atan2(dy, dx);
      if (previousGesturePoint.angle !== undefined && time - previousGesturePoint.at < 250) {
        let delta = angle - previousGesturePoint.angle;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        accumulatedTurn = Math.abs(delta) < 2.4 ? accumulatedTurn + delta : 0;
      } else accumulatedTurn = 0;
      previousGesturePoint = { x: event.clientX, y: event.clientY, angle, at: time };
      if (Math.abs(accumulatedTurn) > Math.PI * 2.1 && cool('circle', 6000)) {
        accumulatedTurn = 0;
        discover('circle', 'Your path remains as a luminous orbit.', { point: { x: event.clientX, y: event.clientY } });
      }
    };
    window.addEventListener('pointermove', onPointerMove, { signal, passive: true });

    window.addEventListener('pointerdown', (event) => {
      if (isInteractiveTarget(event.target)) return;
      holdPoint = { x: event.clientX, y: event.clientY };
      holdTarget = event.target;
      if (holdTimer) timers.clear(holdTimer);
      holdTimer = timers.later(() => {
        holdTimer = 0;
        discover('overload', 'CHARGE 117% — CIRCUIT BREAKER TRIPPED.', { point: holdPoint });
        fx({ type: 'excite' });
        shaderAudio.subBoom(1.2);
      }, 10000);
    }, { signal, passive: true });
    const cancelHold = () => {
      if (holdTimer) timers.clear(holdTimer);
      holdTimer = 0;
    };
    window.addEventListener('pointerup', cancelHold, { signal, passive: true });
    window.addEventListener('pointercancel', cancelHold, { signal, passive: true });
    window.addEventListener('blur', cancelHold, { signal });

    const armIdle = () => {
      if (idleTimer) timers.clear(idleTimer);
      if (document.hidden) return;
      idleTimer = timers.later(() => {
        idleTimer = 0;
        discover('idle-fireflies', 'Fireflies assembled into an md constellation.');
      }, 30000);
    };
    for (const eventName of ['pointermove', 'pointerdown', 'keydown', 'scroll'] as const) {
      window.addEventListener(eventName, armIdle, { signal, passive: eventName !== 'keydown' });
    }
    armIdle();

    window.addEventListener('scroll', () => {
      const time = now();
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 6;
      const atTop = window.scrollY <= 6;
      if (atBottom) bottomAt = time;
      if (atTop && bottomAt && time - bottomAt < 3500 && cool('elevator', 10000)) {
        bottomAt = 0;
        discover('elevator', 'B ↑ TOP — express service arrived.');
        shaderAudio.playNotes([{ f: C5 * 2, type: 'sine', gain: 0.045, decay: 1, wet: 0.5 }]);
      }
    }, { signal, passive: true });

    const volume = element('[data-egg="volume"]');
    const startVolumeDwell = () => {
      if (volumeTimer) timers.clear(volumeTimer);
      volumeTimer = timers.later(() => {
        volumeTimer = 0;
        addTemporaryClass(volume, 'egg-shy', 1700);
        discover('shy-volume', 'The speaker peeks back: okay, okay.');
      }, 3000);
    };
    const stopVolumeDwell = () => {
      if (volumeTimer) timers.clear(volumeTimer);
      volumeTimer = 0;
    };
    volume?.addEventListener('pointerenter', startVolumeDwell, { signal });
    volume?.addEventListener('pointerleave', stopVolumeDwell, { signal });
    volume?.addEventListener('focus', startVolumeDwell, { signal });
    volume?.addEventListener('blur', stopVolumeDwell, { signal });

    const onVisibility = () => {
      cancelHold();
      if (document.hidden) {
        hiddenAt = now();
        if (idleTimer) timers.clear(idleTimer);
        idleTimer = 0;
      } else {
        const away = hiddenAt ? now() - hiddenAt : 0;
        hiddenAt = 0;
        armIdle();
        if (away > 15000 && cool('welcome-back', 20000)) {
          discover('welcome-back', 'SIGNAL RESTORED · welcome back.');
          const previous = document.title;
          document.title = 'signal restored · mdflow';
          timers.later(() => { document.title = previous; }, 3500);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility, { signal });

    timers.later(() => {
      try {
        if (progressRef.current.found.length === 0 && !sessionStorage.getItem('mdflow-nudge')) {
          sessionStorage.setItem('mdflow-nudge', '1');
          setAnnouncement(`This page keeps ${EGG_COUNT} secrets and five stars.`);
          queueReward({ id: 'puzzle-star', text: `✨ This page keeps ${EGG_COUNT} secrets and five stars.` });
        }
      } catch { /* private mode */ }
    }, 25000);

    console.info('🥚 The page listens when no field is listening. Start with its name. Some doors have hashes.');

    return () => {
      controller.abort();
      timers.dispose();
      document.title = originalTitle;
      delete document.documentElement.dataset.eggShield;
      for (const [selector, className] of [
        ['[data-egg="logo"]', 'egg-name-resolved'],
        ['[data-egg="logo"]', 'egg-logo-disco'],
        ['[data-egg="volume"]', 'egg-shy'],
        ['[data-egg="headline"]', 'egg-headline-hello'],
        ['[data-egg-grid]', 'egg-bass'],
        ['[data-egg-grid]', 'egg-shake-grid'],
        ['[data-shader-egg]', 'egg-eggo-dance'],
        ['[data-shader-egg]', 'egg-pop-target'],
      ] as const) element(selector)?.classList.remove(className);
      window.dispatchEvent(new CustomEvent('mdflow:workshop-prox', { detail: { p: 0 } }));
    };
  }, []);

  const puzzleStep = visiblePuzzleStep(progress);
  const showEggHint = () => {
    const undiscovered = EGG_CATALOG.find((egg) => !progress.found.includes(egg.id));
    const text = undiscovered?.clue ?? 'All 22 signals are resolved.';
    setAnnouncement(text);
    queueReward({ id: 'puzzle-star', text: `Clue: ${text}` });
  };
  const showPuzzleHint = () => {
    const text = PUZZLE_HINTS[progress.golden ? 5 : puzzleStep];
    setAnnouncement(text);
    queueReward({ id: 'puzzle-star', text });
  };

  return (
    <>
      <EggHUD
        foundCount={progress.found.length}
        puzzleStep={puzzleStep}
        golden={progress.golden}
        announcement={announcement}
        onEggHint={showEggHint}
        onPuzzleHint={showPuzzleHint}
        onConstellationKey={() => { /* native keydown bubbles to the scoped recognizer */ }}
      />
      <FallbackPlayground active={fallbackPlayground} />
      <EggRewardLayer reward={rewards[0] ?? null} reducedMotion={reducedMotion} />
    </>
  );
};
