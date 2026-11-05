export type Point = { x: number; y: number };
export type Dot = Point & { vx: number; vy: number; age: number; life: number; size: number; color: string };
export type Foe = Point & {
  homeX: number;
  homeY: number;
  phase: number;
  hp: number;
  max: number;
  lastHit: number;
  small: boolean;
  shield: boolean;
  beacon: Point;
};
const TAU = Math.PI * 2;
type C = CanvasRenderingContext2D;
export function line(c: C, points: Point[], color: string, width = 2) {
  if (!points.length) return;
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath();
  c.moveTo(points[0].x, points[0].y);
  for (let j = 1; j < points.length; j++) c.lineTo(points[j].x, points[j].y);
  c.stroke();
}
export function ring(c: C, x: number, y: number, r: number, col: string, fill = false) {
  if (r < 0.2) return;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  if (fill) {
    c.fillStyle = col;
    c.fill();
  } else {
    c.strokeStyle = col;
    c.stroke();
  }
}
export function drawTrail(
  c: C,
  id: string,
  t: number,
  p: Point,
  trail: Point[],
  w: number,
  h: number,
  color: string,
  strings: number[],
) {
  if (id === 'orbit') {
    for (let row = 0; row < 3; row++) {
      const r = 45 + row * 36;
      c.save();
      c.translate(p.x, p.y);
      c.rotate(-0.52 + row * 0.65);
      c.scale(1, 0.52);
      c.lineWidth = 1.5;
      ring(c, 0, 0, r, color + '99');
      for (let i = 0; i < 3; i++) {
        const a = t * (1.6 - row * 0.27) + row + (i * TAU) / 3;
        ring(c, Math.cos(a) * r, Math.sin(a) * r, 6 + i, '#fff1c4', true);
      }
      c.restore();
    }
    ring(c, p.x, p.y, 12, '#efd1ff', true);
    return;
  }
  if (id === 'harp') {
    for (let i = 0; i < 10; i++) {
      const x = ((i + 0.5) * w) / 10,
        age = Math.max(0, t - strings[i]),
        v = age < 2 ? Math.exp(-age * 3.6) : 0;
      const path = Array.from({ length: 48 }, (_, k) => ({
        x: x + Math.sin((k / 47) * Math.PI * 3) * Math.cos(age * 30) * v * 23,
        y: 58 + ((h - 114) * k) / 47,
      }));
      line(c, path, `hsla(${139 + i * 7},90%,${v > 0.2 ? 83 : 62}%,${0.33 + v * 0.64})`, 1.6 + v * 4);
      ring(c, x, h - 56, 4 + v * 5, color, true);
    }
    return;
  }
  const copies = id === 'mirror' ? 4 : id === 'ribbon' ? 2 : 1;
  for (let copy = 0; copy < copies; copy++) {
    const points = trail.map((v, i) => ({
      x: id === 'mirror' && copy % 2 ? w - v.x : v.x,
      y:
        id === 'mirror' && copy > 1
          ? h - v.y
          : v.y + (id === 'ribbon' ? Math.sin(i * 0.34 - t * 4 + copy * Math.PI) * 18 : 0),
    }));
    for (let i = 1; i < points.length; i++) {
      const f = i / points.length;
      c.globalAlpha = 0.12 + f * 0.85;
      const pigment =
        id === 'comet' ? `hsl(${12 + f * 43},100%,${42 + f * 38}%)` : copy % 2 ? '#72e8ff' : color;
      line(c, [points[i - 1], points[i]], pigment, 1 + f * (id === 'comet' ? 13 : 5));
      if (id === 'comet' && i % 3 === 0)
        ring(c, points[i].x - 8 * Math.sin(i), points[i].y + (1 - f) * 24, 1 + f, color, true);
    }
    c.globalAlpha = 1;
    const end = points.at(-1);
    if (end) {
      ring(c, end.x, end.y, 6, '#fffbdc', true);
      ring(c, end.x, end.y, 11, color);
    }
  }
}
export function filings(c: C, p: Point, w: number, h: number, t: number) {
  const spacing = Math.max(30, w / 34);
  for (let y = 15; y < h; y += spacing)
    for (let x = 12; x < w; x += spacing) {
      const ax = p.x - 72 - x,
        ay = p.y - y,
        bx = p.x + 72 - x,
        by = p.y - y,
        ra = (ax * ax + ay * ay + 300) ** 1.5,
        rb = (bx * bx + by * by + 300) ** 1.5;
      const a = Math.atan2(ay / ra - by / rb, ax / ra - bx / rb) + 0.04 * Math.sin(t + x),
        dx = Math.cos(a) * 8,
        dy = Math.sin(a) * 8;
      line(
        c,
        [
          { x: x - dx, y: y - dy },
          { x: x + dx, y: y + dy },
        ],
        ax < 0 ? '#7ecaffaa' : '#ffb873aa',
        2.5,
      );
    }
  ring(c, p.x - 72, p.y, 8, '#ffc27e', true);
  ring(c, p.x + 72, p.y, 8, '#85c9ff', true);
}
export function drawDot(c: C, id: string, d: Dot, w: number, h: number) {
  const k = d.age / d.life;
  c.globalAlpha = Math.max(0, Math.min(1, (1 - k) * 2));
  c.lineWidth = 2;
  if (id === 'bubbles') {
    ring(c, d.x, d.y, d.size, d.color);
    ring(c, d.x - d.size * 0.29, d.y - d.size * 0.3, d.size * 0.17, '#dcffff', true);
  } else if (id === 'sonar') {
    const r = d.age * 205 + 4;
    for (const [x, y] of [
      [d.x, d.y],
      [-d.x, d.y],
      [2 * w - d.x, d.y],
      [d.x, 2 * h - d.y],
    ]) {
      ring(c, x, y, r, d.color);
      ring(c, x, y, r + 8, d.color + '55');
    }
  } else {
    const l = id === 'meteors' ? 0.2 : 0.06;
    line(c, [{ x: d.x - d.vx * l, y: d.y - d.vy * l }, d], d.color + 'a0', d.size);
    ring(c, d.x, d.y, d.size * 0.72, '#fff5cb', true);
  }
  c.globalAlpha = 1;
}
const sprites: Record<string, string[]> = {
  jellies: [
    '0001111000',
    '0012222100',
    '0122222210',
    '1223223221',
    '1222222221',
    '0010101000',
    '0100100100',
    '0101001010',
  ],
  moths: [
    '1100000011',
    '1210000121',
    '1221001221',
    '0122112210',
    '0012332100',
    '0112112110',
    '0121001210',
    '0100000010',
  ],
  crabs: [
    '1100000011',
    '0101001010',
    '1113113111',
    '0012222100',
    '0112222110',
    '1101111011',
    '1010000101',
    '0100000010',
  ],
  blink: ['00111100', '01222210', '12233221', '12311321', '12222221', '12211221', '01222210', '01011010'],
  hydra: [
    '00100000100',
    '01110001110',
    '12321012321',
    '01221012210',
    '00122222100',
    '00012221000',
    '00112221100',
    '01001110010',
  ],
};
export function drawFoe(c: C, id: string, f: Foe, t: number, color: string) {
  const sprite = sprites[id],
    size = f.small ? 3 : id === 'hydra' ? 6 : 4,
    beat = Math.sin(t * 4 + f.phase);
  c.save();
  c.translate(f.x, f.y);
  if (id === 'moths') c.scale(0.78 + 0.28 * Math.abs(beat), 1);
  else c.scale(1 + 0.035 * beat, 1 - 0.035 * beat);
  if (id === 'blink') {
    c.setLineDash([3, 8]);
    c.lineWidth = 1;
    line(
      c,
      [
        { x: 0, y: 0 },
        { x: f.beacon.x - f.x, y: f.beacon.y - f.y },
      ],
      color + '98',
    );
    c.setLineDash([]);
    ring(c, f.beacon.x - f.x, f.beacon.y - f.y, 11 + 3 * beat, color);
  }
  if (f.shield) {
    c.lineWidth = 3;
    c.strokeStyle = '#6bcaff';
    c.beginPath();
    c.arc(0, 0, 31, t * 0.9, t * 0.9 + 5.6);
    c.stroke();
  }
  const grad = c.createRadialGradient(0, 0, 4, 0, 0, 39);
  grad.addColorStop(0, color + '65');
  grad.addColorStop(1, color + '00');
  c.fillStyle = grad;
  c.fillRect(-40, -40, 80, 80);
  sprite.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const n = row[x];
      if (n === '0') continue;
      c.fillStyle = t - f.lastHit < 0.2 ? 'white' : n === '3' ? '#fffddd' : n === '2' ? color : '#687cb3';
      c.fillRect((x - row.length / 2) * size, (y - sprite.length / 2) * size, size + 0.2, size + 0.2);
    }
  });
  for (let k = 0; k < f.max; k++) {
    c.fillStyle = k < f.hp ? color : '#535469';
    c.fillRect((k - f.max / 2) * 7, (-sprite.length * size) / 2 - 10, 5, 2);
  }
  c.restore();
}
export function drawMusic(
  c: C,
  id: string,
  t: number,
  beat: number,
  p: Point,
  w: number,
  h: number,
  color: string,
) {
  const phase = beat % 1,
    pulse = Math.exp(-phase * 5),
    cy = h * 0.62;
  if (id === 'cassette') {
    for (let i = 0; i < 2; i++) {
      const x = w * (i ? 0.68 : 0.32),
        r = Math.min(w * 0.09, 60);
      c.lineWidth = 2;
      ring(c, x, cy, r, color);
      for (let j = 0; j < 5; j++) {
        const a = t * 1.9 + (j * TAU) / 5;
        ring(c, x + Math.cos(a) * r * 0.58, cy + Math.sin(a) * r * 0.58, r * 0.17, color, true);
      }
    }
    line(
      c,
      [
        { x: w * 0.32, y: cy + Math.min(w * 0.09, 60) },
        { x: w * 0.68, y: cy + Math.min(w * 0.09, 60) },
      ],
      color,
      2 + pulse * 3,
    );
  } else if (id === 'breaks') {
    for (let i = 0; i < 22; i++) {
      const x = (w * (i * 0.127) + t * (210 + i * 5)) % w,
        y = h * (0.2 + ((i * 17) % 58) / 100);
      line(
        c,
        [
          { x: x - 20 - pulse * 40, y: y + 12 },
          { x, y },
        ],
        i % 2 ? color : '#ffe0a5',
        2 + (i % 4),
      );
    }
  } else if (id === 'outrun') {
    for (let i = -9; i <= 9; i++)
      line(
        c,
        [
          { x: p.x, y: h * 0.45 },
          { x: w * 0.5 + i * w * 0.15, y: h },
        ],
        color + 'b0',
      );
    for (let i = 0; i < 9; i++) {
      const y = h * (0.45 + 0.6 * (((i + t * 0.7) % 9) / 9) ** 2);
      line(
        c,
        [
          { x: 0, y },
          { x: w, y },
        ],
        color + 'aa',
      );
    }
    ring(c, p.x, h * 0.4, 30 + pulse * 9, '#ffbe73', true);
  } else if (id === 'glass') {
    for (let i = 0; i < 13; i++) {
      const x = ((i + 0.5) * w) / 13,
        y = cy + Math.sin(i * 0.8 + beat * 0.6) * 48,
        r = 8 + 18 * Math.max(0, Math.cos(beat * Math.PI - i));
      line(
        c,
        [
          { x, y: y - r },
          { x: x + r * 0.55, y },
          { x, y: y + r },
          { x: x - r * 0.55, y },
          { x, y: y - r },
        ],
        i % 2 ? color : '#b8e2ff',
        2,
      );
    }
  } else
    for (let j = 0; j < 3; j++)
      line(
        c,
        Array.from({ length: 73 }, (_, i) => ({
          x: (i * w) / 72,
          y: cy + j * 32 + Math.sin(i * 0.12 + (beat * TAU) / 3 + j) * (0.08 * h + pulse * 8),
        })),
        j % 2 ? color : '#b7a7ee',
        3,
      );
}
// Low-motion and no-WebGL renderings preserve the subject of each lens, without starting another GPU context.
export function drawLens(c: C, id: string, t: number, p: Point, w: number, h: number, color: string) {
  const cx = w * 0.33 + p.x * 0.34,
    cy = h * 0.34 + p.y * 0.27;
  if (id === 'aurora' || id === 'chrome') {
    const chrome = id === 'chrome';
    for (let i = 0; i < (chrome ? 25 : 35); i++) {
      const pts = Array.from({ length: 59 }, (_, k) => ({
        x: (k * w) / 58,
        y:
          cy +
          (i - 15) * (chrome ? 7 : 2.7) +
          Math.sin(k * 0.12 + t * 0.65 + i * 0.07) * h * 0.13 +
          Math.cos(k * 0.22 + i * 0.1) * h * 0.05,
      }));
      line(
        c,
        pts,
        chrome ? `hsla(209,48%,${35 + (i % 8) * 7}%,.55)` : `hsla(${145 + i * 3},93%,64%,.21)`,
        chrome ? 2 : 6,
      );
    }
  } else if (id === 'prism') {
    for (let i = 0; i < 9; i++) {
      const rad = 18 * 1.5 ** ((i + t * 0.6) % 9);
      line(
        c,
        Array.from({ length: 7 }, (_, k) => ({
          x: cx + rad * Math.cos((k * TAU) / 6 + t * 0.15),
          y: cy + rad * Math.sin((k * TAU) / 6 + t * 0.15),
        })),
        `hsla(${(i * 38 + t * 12) % 360},90%,70%,.74)`,
        3,
      );
    }
  } else if (id === 'sunset') {
    const r = Math.min(w * 0.13, 85);
    c.fillStyle = color;
    for (let i = -r; i < r; i += 6) {
      const dx = Math.sqrt(r * r - i * i);
      c.fillRect(cx - dx, cy + i, dx * 2, 4);
    }
    for (let i = -8; i <= 8; i++)
      line(
        c,
        [
          { x: cx, y: cy + r },
          { x: w * 0.5 + i * w * 0.19, y: h },
        ],
        '#e975cf99',
      );
    for (let i = 0; i < 8; i++) {
      const y = cy + r + (h - cy - r) * (((i + t * 0.5) % 8) / 8) ** 2;
      line(
        c,
        [
          { x: 0, y },
          { x: w, y },
        ],
        '#e975cfaa',
      );
    }
  } else {
    c.fillStyle = '#92fa9a1e';
    for (let y = 0; y < h; y += 6) c.fillRect(0, y, w, 2);
    const y = (cy + t * 40) % h;
    c.fillStyle = '#aaffbc43';
    c.fillRect(0, y, w, 7);
    ring(c, cx, cy, 63, color);
  }
}
