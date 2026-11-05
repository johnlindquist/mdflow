import { shaderAudio as audio } from '../shaderAudio';
import { byId, effects, fxBridge, type Effect } from './catalog';
import { scores } from './scores';
import {
  drawTrail,
  drawDot,
  drawFoe,
  drawLens,
  drawMusic,
  filings,
  ring,
  type Point,
  type Dot,
  type Foe,
} from './draw';

const colors = ['#ffaf73', '#7fffe0', '#fc9cda', '#afe0ff', '#fff4ad'];
const TAU = Math.PI * 2,
  clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const isUI = (el: EventTarget | null) =>
  el instanceof Element &&
  !!el.closest('a,button,input,textarea,select,[contenteditable],[role=textbox],[data-fx-ui]');
const nativeFx = (detail: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent('mdflow:fx', { detail }));
const lenses = effects.filter((e) => e.group === 'Filters');
export function installField(
  canvas: HTMLCanvasElement,
  onChange: (active: Effect | null) => void,
  found: (e: Effect) => void,
) {
  const c = canvas.getContext('2d');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let active: Effect | null = null,
    serial = 0,
    raf = 0,
    timer = 0,
    began = 0,
    previous = 0,
    drawn = 0,
    w = 1,
    h = 1,
    moved = false;
  let pointer = { x: 0, y: 0 },
    tip = { x: 0, y: 0 },
    trail: Point[] = [],
    dots: Dot[] = [],
    foes: Foe[] = [],
    strings: number[] = [];
  let lastEmit = 0,
    lastColumn = -1,
    lastPop = -1,
    strikes = 0,
    kills = 0,
    frame = 0,
    until = 0;
  let gestureAt = 0,
    lastPoint: (Point & { t: number }) | null = null,
    flick = 0,
    reversals = 0,
    direction = 0;
  const age = () => Math.max(0, (performance.now() - began) / 1000);
  const curve = (t: number) => ({
    x: w * (0.5 + 0.22 * Math.sin(t * 1.48)),
    y: h * (0.46 + 0.12 * Math.sin(t * 2.6 + 0.7)),
  });
  const resize = () => {
    if (!active) return;
    w = Math.max(1, innerWidth);
    h = Math.max(1, innerHeight);
    const d = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * d);
    canvas.height = Math.round(h * d);
    c?.setTransform(d, 0, 0, d, 0, 0);
  };
  const sfx = (n: number, tone: OscillatorType = 'sine', decay = 0.22) =>
    audio.playNotes([{ f: n, type: tone, gain: 0.045, decay, wet: 0.25 }]);
  const foe = (i: number, small = false, x = w * (0.22 + i * 0.25), y = h * (0.36 + 0.1 * (i % 2))): Foe => ({
    x,
    y,
    homeX: x,
    homeY: y,
    small,
    phase: i * 1.8,
    hp: active?.id === 'hydra' && !small ? 3 : active?.id === 'crabs' ? 2 : 1,
    max: active?.id === 'hydra' && !small ? 3 : active?.id === 'crabs' ? 2 : 1,
    lastHit: -10,
    shield: false,
    beacon: { x, y },
  });
  const summon = () => {
    foes = Array.from({ length: active?.id === 'hydra' ? 1 : 3 }, (_, i) =>
      foe(i, false, active?.id === 'hydra' ? w * 0.5 : undefined),
    );
    audio.monsterSpawn(0.46);
  };
  const emit = (kind: string, p: Point, seed = false) => {
    const count =
      kind === 'peony' ? 42 : kind === 'meteors' ? (seed ? 20 : 9) : kind === 'bubbles' ? (seed ? 20 : 8) : 1;
    for (let i = 0; i < count; i++) {
      const a = (i * TAU) / count + Math.random() * 0.14,
        v = 100 + Math.random() * 210;
      const d: Dot = {
        ...p,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        age: 0,
        life: 1.4 + Math.random(),
        size: 1.4 + Math.random() * 2.3,
        color: colors[i % colors.length],
      };
      if (kind === 'meteors') {
        d.x = Math.random() * (w + 180);
        d.y = seed ? Math.random() * h : -25 - Math.random() * 100;
        d.vx = -125 - (1 - p.x / w) * 210;
        d.vy = 330 + Math.random() * 190;
        d.life = 3;
      }
      if (kind === 'bubbles') {
        d.x = seed ? Math.random() * w : p.x + (Math.random() - 0.5) * 95;
        d.y = seed ? Math.random() * h : p.y;
        d.vx = (Math.random() - 0.5) * 32;
        d.vy = -24 - Math.random() * 48;
        d.life = 7;
        d.size = 13 + Math.random() * 24;
      }
      if (kind === 'sonar') {
        d.vx = d.vy = 0;
        d.life = 3.6;
        d.color = '#7dfce2';
      }
      if (kind === 'peony' && seed) {
        d.age = 0.25;
        d.x += d.vx * 0.25;
        d.y += d.vy * 0.25;
      }
      dots.push(d);
    }
    if (dots.length > 150) dots.splice(0, dots.length - 150);
  };
  const hit = (f: Foe, net = false) => {
    if (!active || !foes.includes(f)) return false;
    const t = age();
    if (t - f.lastHit < 0.18) return true;
    f.lastHit = t;
    if (f.shield && !net) {
      sfx(155, 'triangle');
      nativeFx({ type: 'shock', x: f.x, y: f.y, amp: -0.28 });
      return true;
    }
    strikes++;
    f.hp = net ? 0 : f.hp - 1;
    if (f.hp <= 0) {
      kills++;
      foes = foes.filter((other) => other !== f);
      emit('peony', f);
      audio.monsterCaught(f.phase / 6);
      nativeFx({ type: 'burst', x: f.x, y: f.y, n: 6, amp: 0.4 });
      if (net) window.dispatchEvent(new CustomEvent('mdflow:monster', { detail: { x: f.x, y: f.y } }));
      if (active.id === 'hydra' && !f.small)
        foes.push(foe(1, true, f.x - 35, f.y), foe(2, true, f.x + 35, f.y));
    } else {
      audio.monsterHit(0.35, false);
      nativeFx({ type: 'shock', x: f.x, y: f.y, amp: 0.4 });
    }
    return true;
  };
  const dart = (x: number, y: number, ox: number, oy: number) => {
    const dx = x - ox,
      dy = y - oy;
    for (const f of foes) {
      const u = clamp(((f.x - ox) * dx + (f.y - oy) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      if (Math.hypot(ox + u * dx - f.x, oy + u * dy - f.y) < (f.small ? 22 : 31)) return hit(f);
    }
    return false;
  };
  function action(p: Point, assist = false) {
    if (!active) return;
    const id = active.id;
    if (active.group === 'Aliens') {
      if (!foes.length) summon();
      else if (assist)
        hit(
          foes.reduce((a, b) =>
            Math.hypot(a.x - p.x, a.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? a : b,
          ),
        );
      else dart(p.x, p.y, p.x, p.y);
    } else if (active.group === 'Physics' && id !== 'iron') {
      emit(id, p);
      if (id === 'peony') audio.whoosh(220, 1200, 0.27, 0.075);
      else if (id === 'meteors') audio.whoosh(1400, 160, 0.35, 0.07);
      else sfx(id === 'sonar' ? 440 : 785);
      nativeFx({ type: 'shock', ...p, amp: 0.46 });
    } else {
      const pitch = audio.noteAt(p.x / w, p.y / h);
      sfx(pitch, id === 'harp' ? 'triangle' : 'sine');
      nativeFx({ type: 'shock', ...p, amp: 0.42 });
    }
    if (motion.matches) paint(performance.now(), false);
  }
  const point = (x: number, y: number) => {
    if (!active || !Number.isFinite(x) || !Number.isFinite(y)) return;
    pointer = { x: clamp(x, 0, w), y: clamp(y, 0, h) };
    moved = true;
    if (active.id === 'harp') {
      const col = clamp(Math.floor((x / w) * 10), 0, 9);
      if (col !== lastColumn) {
        strings[col] = age();
        lastColumn = col;
        sfx(audio.noteAt(x / w, y / h), 'triangle', 0.52);
      }
    }
    if (active.id === 'bubbles') {
      const i = dots.findIndex((d) => Math.hypot(d.x - x, d.y - y) < d.size + 5);
      if (i >= 0) {
        const [d] = dots.splice(i, 1);
        if (age() - lastPop > 0.065) {
          sfx(260 + d.size * 13, 'sine', 0.3);
          lastPop = age();
        }
        nativeFx({ type: 'shock', x, y, amp: 0.24 });
      }
    }
  };
  function paint(now: number, schedule: boolean) {
    if (!c || !active) return;
    const t = motion.matches ? 0.58 : age();
    const dt = clamp((now - previous) / 1000, 0, 0.064);
    previous = now;
    const target = moved ? pointer : curve(t);
    const lerp = motion.matches ? 1 : 1 - Math.exp(-dt * 16);
    tip = { x: tip.x + (target.x - tip.x) * lerp, y: tip.y + (target.y - tip.y) * lerp };
    c.clearRect(0, 0, w, h);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.globalAlpha = 1;
    c.lineWidth = 2;
    const { id, group, color } = active;
    frame++;
    if (group === 'Trails') {
      trail.push({ ...tip });
      if (trail.length > 50) trail.shift();
      drawTrail(c, id, t, tip, trail, w, h, color, strings);
    }
    if (id === 'iron') filings(c, tip, w, h, t);
    if (
      group === 'Physics' &&
      id !== 'iron' &&
      t - lastEmit > (id === 'meteors' ? 0.48 : id === 'bubbles' ? 1.9 : id === 'sonar' ? 1.05 : 1.75)
    ) {
      emit(id, id === 'bubbles' ? { x: w * (0.2 + 0.6 * Math.random()), y: h + 12 } : target);
      lastEmit = t;
    }
    for (const d of dots) {
      d.age += dt;
      if (id === 'peony' || group === 'Aliens') d.vy += 87 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      drawDot(c, group === 'Aliens' ? 'peony' : id, d, w, h);
    }
    dots = dots.filter((d) => d.age < d.life && d.y < h + 160);
    if (group === 'Aliens')
      for (const f of foes) {
        const a = t + f.phase,
          rx = Math.min(92, w * 0.12),
          ry = Math.min(52, h * 0.08);
        if (id === 'moths') {
          f.x += (tip.x + Math.cos(a * 1.8) * rx - f.x) * (1 - Math.exp(-dt * 2));
          f.y += (tip.y + Math.sin(a * 2) * ry - f.y) * (1 - Math.exp(-dt * 2));
        } else if (id === 'blink') {
          const step = Math.floor(a / 1.7),
            spot = (n: number) => ({
              x: w * (0.2 + 0.6 * (0.5 + 0.5 * Math.sin(n * 7.2 + f.phase))),
              y: h * (0.26 + 0.48 * (0.5 + 0.5 * Math.cos(n * 3.8 + f.phase))),
            });
          Object.assign(f, spot(step));
          f.beacon = spot(step + 1);
        } else {
          f.x = f.homeX + Math.sin(a * (id === 'crabs' ? 1.6 : 0.88)) * rx;
          f.y =
            f.homeY +
            (id === 'crabs'
              ? Math.abs(Math.sin(a * 4)) * 8
              : Math.sin(a * (id === 'jellies' ? 2 : 1.5)) * ry);
          f.shield = id === 'crabs' && !motion.matches && Math.cos(a * 2.1) > 0.35;
        }
        f.x = clamp(f.x, 28, w - 28);
        f.y = clamp(f.y, 82, Math.max(82, h - 75));
        drawFoe(c, id, f, t, color);
      }
    if (group === 'Tracks') {
      const sc = scores[id];
      drawMusic(c, id, t, (t * sc.bpm) / 60, tip, w, h, color);
    }
    if (group === 'Filters' && (motion.matches || !document.documentElement.classList.contains('shader-fx')))
      drawLens(c, id, t, tip, w, h, color);
    if (schedule && !motion.matches) raf = requestAnimationFrame(tick);
  }
  function tick(now: number) {
    if (!active) return;
    if (now - drawn < 1000 / 40) {
      raf = requestAnimationFrame(tick);
      return;
    }
    drawn = now;
    paint(now, true);
  }
  const stop = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    gestureAt = performance.now() + 8000;
    fxBridge.shader = 0;
    fxBridge.dart = fxBridge.net = null;
    audio.startScore(null);
    active = null;
    dots = [];
    foes = [];
    trail = [];
    c?.clearRect(0, 0, w, h);
    canvas.hidden = true;
    delete document.documentElement.dataset.playFx;
    onChange(null);
  };
  const play = (id: string) => {
    const e = byId(id);
    if (!e) return { ok: false, error: 'unknown_effect' } as const;
    if (!c) return { ok: false, error: 'canvas_unavailable' } as const;
    stop();
    serial++;
    active = e;
    began = previous = performance.now();
    drawn = 0;
    frame = strikes = kills = 0;
    lastEmit = 0;
    lastColumn = lastPop = -1;
    moved = false;
    canvas.hidden = false;
    resize();
    pointer = tip = curve(0);
    trail = Array.from({ length: 49 }, (_, i) => curve((i - 48) * 0.023));
    strings = Array(10).fill(-10);
    strings[4] = 0;
    document.documentElement.dataset.playFx = id;
    if (e.group === 'Filters' && !motion.matches) fxBridge.shader = lenses.indexOf(e) + 1;
    if (e.group === 'Aliens') {
      summon();
      fxBridge.dart = dart;
      fxBridge.net = (inside) => {
        for (const f of [...foes]) if (inside(f.x, f.y)) hit(f, true);
      };
    }
    if (e.group === 'Tracks') audio.startScore(scores[id], () => tip.x > w * 0.62);
    if (e.group === 'Physics' && id !== 'iron') emit(id, tip, true);
    if (e.group !== 'Tracks' && e.group !== 'Aliens')
      audio.playNotes([
        { f: e.group === 'Filters' ? 329.63 : 440, type: 'sine', gain: 0.035, decay: 0.27 },
        { f: e.group === 'Filters' ? 493.88 : 659.25, at: 0.12, type: 'triangle', gain: 0.026, decay: 0.37 },
      ]);
    until = began + (e.group === 'Tracks' ? 32000 : e.group === 'Aliens' ? 30000 : 18000);
    timer = window.setTimeout(stop, until - began);
    onChange(e);
    found(e);
    paint(performance.now(), true);
    return { ok: true, id, serial } as const;
  };
  const inspect = () => ({
    version: 1,
    active: active?.id ?? null,
    serial,
    remainingMs: active ? Math.max(0, Math.round(until - performance.now())) : 0,
    renderer: !active
      ? 'idle'
      : active.group === 'Filters' &&
          !motion.matches &&
          document.documentElement.classList.contains('shader-fx')
        ? 'webgl'
        : motion.matches
          ? 'still'
          : 'canvas2d',
    frame,
    pointer: { ...pointer },
    hits: strikes,
    captures: kills,
    enemies: foes.map(({ x, y, hp, shield, small }) => ({ x, y, hp, shield, small })),
    audio: audio.outputStatus(),
  });
  const pulse = () => {
    if (!active) return { ok: false, error: 'idle' };
    action(tip, true);
    return { ok: true };
  };
  const move = (e: PointerEvent) => {
    if (isUI(e.target) || motion.matches) return;
    const now = performance.now();
    if (!active && e.buttons === 0 && now >= gestureAt && lastPoint) {
      const dx = e.clientX - lastPoint.x,
        dy = e.clientY - lastPoint.y,
        ms = now - lastPoint.t;
      if (ms > 140) {
        flick = 0;
        reversals = 0;
        direction = 0;
      } else if (Math.abs(dx) > 3) {
        if (direction && Math.sign(dx) !== direction) {
          reversals++;
          flick = 0;
        }
        direction = Math.sign(dx);
        flick += Math.hypot(dx, dy);
        if (reversals >= 3) play('ribbon');
        else if (
          (e.shiftKey && flick > 65) ||
          (!reversals && flick > 230 && Math.abs(dx) / Math.max(1, ms) > 1.5)
        )
          play('comet');
      }
    }
    lastPoint = { x: e.clientX, y: e.clientY, t: now };
    if (active) point(e.clientX, e.clientY);
  };
  const tap = (e: PointerEvent) => {
    if (active && !isUI(e.target) && e.button === 0 && !e.shiftKey) {
      point(e.clientX, e.clientY);
      action(pointer);
    }
  };
  const vis = () => {
    if (document.hidden && active) stop();
  };
  const resized = () => {
    resize();
    if (active && motion.matches) paint(performance.now(), false);
  };
  window.addEventListener('pointermove', move, { passive: true });
  window.addEventListener('pointerdown', tap, { passive: true });
  window.addEventListener('resize', resized);
  document.addEventListener('visibilitychange', vis);
  motion.addEventListener('change', stop);
  const api = {
    list: () => effects.map((e) => ({ ...e })),
    inspect,
    play,
    pulse,
    stop: (expected?: number) => {
      if (expected !== undefined && expected !== serial) return { ok: false, error: 'stale' };
      stop();
      return { ok: true };
    },
  };
  return {
    api,
    dispose: () => {
      stop();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', tap);
      window.removeEventListener('resize', resized);
      document.removeEventListener('visibilitychange', vis);
      motion.removeEventListener('change', stop);
    },
  };
}
export type FieldApi = ReturnType<typeof installField>['api'];
declare global {
  interface Window {
    mdflowPlayground?: FieldApi;
  }
}
