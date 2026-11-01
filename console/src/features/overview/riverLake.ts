/**
 * The lake: where every channel's rows come to rest (docs/10-design-system.md §10.8). It is water
 * like the rest of the river — one broad, slow current that the channels run into and combine in,
 * fastest at its surface, its layers meandering, flowing faster the more rows arrive, and carrying
 * as many settled rows as the lake holds rows, on a log scale. It is seen in long exposure: each
 * trail the distance its row drifts in `LAKE_EXPOSURE` seconds, so slow water still shows how it
 * moves. `riverEngine.ts` owns the channels; this owns the lake's water, its bed and its surface,
 * and hands its particles to the same comet renderer.
 */

type Rgb = [number, number, number];

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  alpha: number;
}

interface Glimmer {
  x: number;
  /** Against the surface's own speed. */
  pace: number;
  alpha: number;
  /** Below the surface, px. */
  depth: number;
}

/** A comet for the renderer, in CSS px. */
export type Emit = (x: number, y: number, dx: number, dy: number, length: number, width: number, alpha: number, rgb: Rgb) => void;

/** The lake's long exposure: every trail in it the distance its row drifts in this many seconds. */
export const LAKE_EXPOSURE = 2.2;
/**
 * The layers' meanders, as a stream function ψ = env(Y)·Σ b·sin(kx − ωt + φ + φy·Y): its curl is the
 * velocity, so the water bends without gathering anywhere, and the envelope keeps it level at the
 * surface and the bed. Wavelengths in px at a river 1,100 px wide.
 */
const MEANDERS = [
  { b: 1, lx: 330, w: 0.22, p: 0.4, py: 0 },
  { b: 0.55, lx: 190, w: -0.17, p: 2.3, py: 1.4 },
];
/** The meanders' strength, px²/s at a river 1,100 px wide: layers that bend a few px. */
const MEANDER = 120;
/** Settled rows the lake shows: one per this many px² when it is full. */
const MOTE_AREA = 96;
const MAX_MOTES = 600;

/** The surface's speed for the rows arriving a second, at a river 1,100 px wide: a drift when little arrives. */
function lakeSpeed(rate: number): number {
  return 8 + 4 * Math.log10(1 + Math.max(0, rate));
}

export class Lake {
  private width = 0;
  private height = 0;
  private scale = 1;
  /** The surface at rest, and where the near shore meets it. */
  private top = 0;
  private left = 0;
  private depth = 1;
  private shoreYs = new Float32Array(0);
  private shoreXs = new Float32Array(0);
  private area = 0;
  private rows: number | null = null;
  private rate = 0;
  /** The surface's speed, px/s, easing toward `targetSpeed` as the rows arriving change. */
  private speed = 0;
  private targetSpeed = 0;
  /** The shape the lake was last laid out to: the same shape again keeps its water. */
  private shape = '';
  private motes: Mote[] = [];
  private glimmers: Glimmer[] = [];
  private time = 0;
  private readonly field: [number, number] = [0, 0];

  /** Particles it draws: settled rows and glimmers. */
  get count(): number {
    return this.motes.length + this.glimmers.length;
  }

  layout(width: number, height: number, scale: number, top: number, left: number): void {
    const shape = [width, height, top, left].map((value) => value.toFixed(1)).join(',');
    if (shape === this.shape) return;
    this.shape = shape;
    this.width = width;
    this.height = height;
    this.scale = scale;
    this.top = top;
    this.left = left;
    this.depth = Math.max(1, height - top);
    // The near shore: the curve the bed is drawn with, sampled so a row can be kept off it.
    const reach = width - left;
    const samples = 48;
    this.shoreYs = new Float32Array(samples + 1);
    this.shoreXs = new Float32Array(samples + 1);
    const cubic = (p0: number, p1: number, p2: number, p3: number, t: number): number =>
      (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
    for (let index = 0; index <= samples; index += 1) {
      const t = index / samples;
      this.shoreXs[index] = cubic(left, left + reach * 0.2, left + reach * 0.12, left + reach * 0.45, t);
      this.shoreYs[index] = cubic(top, top, height, height, t);
    }
    let area = 0;
    for (let y = top; y < height; y += 2) area += 2 * Math.max(0, width - this.shore(y));
    this.area = area;
    this.targetSpeed = lakeSpeed(this.rate) * scale;
    this.speed = this.targetSpeed;
    // A new shape would strand the old water where the lake was: it is filled afresh.
    this.motes = [];
    this.glimmers = [];
    this.fill();
  }

  /** Rows the lake holds, and rows arriving a second across the fleet. */
  setFlow(rows: number | null, rate: number): void {
    this.rows = rows;
    this.rate = rate;
    this.targetSpeed = lakeSpeed(rate) * this.scale;
    this.fill();
  }

  /** The near shore's x at a depth. */
  shore(y: number): number {
    const ys = this.shoreYs;
    const count = ys.length;
    if (count === 0) return this.left;
    if (y <= (ys[0] as number)) return this.shoreXs[0] as number;
    for (let index = 1; index < count; index += 1) {
      const y1 = ys[index] as number;
      if (y <= y1) {
        const y0 = ys[index - 1] as number;
        const t = y1 > y0 ? (y - y0) / (y1 - y0) : 0;
        return (this.shoreXs[index - 1] as number) + ((this.shoreXs[index] as number) - (this.shoreXs[index - 1] as number)) * t;
      }
    }
    return this.shoreXs[count - 1] as number;
  }

  /** The surface where it is now: a slow swell, still at the near shore. */
  surface(x: number): number {
    const s = this.scale;
    const calm = Math.min(1, Math.max(0, (x - this.left) / (60 * s)));
    const swell = 0.6 * Math.sin(x / (40 * s) - 0.8 * this.time) + 0.4 * Math.sin(x / (17 * s) + 1.3 * this.time + 1.3);
    return this.top + 1.1 * s * swell * calm;
  }

  /** The lake's water at a point, px/s: the current, fastest at the surface, and its meanders. */
  flow(x: number, y: number): [number, number] {
    const s = this.scale;
    const Y = Math.min(1, Math.max(0, (y - this.top) / this.depth));
    const sine = Math.sin(Math.PI * Y);
    const envelope = sine * sine;
    const slope = (Math.PI * Math.sin(2 * Math.PI * Y)) / this.depth;
    let u = 0;
    let v = 0;
    for (const meander of MEANDERS) {
      const k = (2 * Math.PI) / (meander.lx * s);
      const theta = k * x - meander.w * this.time + meander.p + meander.py * Y;
      const strength = MEANDER * s * s * meander.b;
      u += strength * (slope * Math.sin(theta) + envelope * (meander.py / this.depth) * Math.cos(theta));
      v -= strength * envelope * k * Math.cos(theta);
    }
    this.field[0] = this.speed * (0.22 + 0.78 * (1 - Y) ** 1.5) + u;
    this.field[1] = v;
    return this.field;
  }

  advance(dt: number): void {
    this.time += dt;
    this.speed += (this.targetSpeed - this.speed) * Math.min(1, dt * 0.8);
    const s = this.scale;
    for (const mote of this.motes) {
      mote.age += dt;
      if (mote.age > mote.life) {
        this.place(mote, false);
        continue;
      }
      const [u, v] = this.flow(mote.x, mote.y);
      mote.vx = u;
      mote.vy = v;
      mote.x += u * dt;
      mote.y = Math.min(this.height - 1.5, Math.max(this.surface(mote.x) + 1.5, mote.y + v * dt));
      const shore = this.shore(mote.y) + 1;
      if (mote.x < shore) mote.x = shore;
      // Carried out of view downstream: back in near the shore, fading in.
      if (mote.x > this.width + 12 * s) this.place(mote, true);
    }
    const span = this.width - this.left;
    for (const glimmer of this.glimmers) {
      glimmer.x += this.speed * glimmer.pace * dt;
      if (glimmer.x > this.width + 20 * s) glimmer.x -= span + 40 * s;
    }
  }

  /** Every settled row, and the light moving along the surface, as comets. */
  emit(push: Emit, current: Rgb, dark: boolean, dim: number): void {
    const s = this.scale;
    for (const mote of this.motes) {
      const speed = Math.hypot(mote.vx, mote.vy);
      const Y = (mote.y - this.top) / this.depth;
      const envelope = Math.min(1, mote.age / 1.5) * Math.min(1, (mote.life - mote.age) / 2);
      // Light reaches the upper water: rows near the surface brightest, the deep ones faint.
      const alpha = mote.alpha * envelope * Math.max(0, 1 - Y) ** 1.2 * (dark ? 0.7 : 0.56) * dim;
      if (alpha < 0.02) continue;
      const dx = speed > 0 ? mote.vx / speed : 1;
      const dy = speed > 0 ? mote.vy / speed : 0;
      push(mote.x, mote.y, dx, dy, Math.min(44 * s, speed * LAKE_EXPOSURE), 1.1 * s, alpha, current);
    }
    const span = this.width - this.left;
    for (const glimmer of this.glimmers) {
      // Out of the near shore's shallows, as the waterline is.
      const shallows = Math.min(1, Math.max(0, (glimmer.x - this.left) / (span * 0.22)));
      const alpha = glimmer.alpha * shallows * dim;
      if (alpha < 0.02) continue;
      const y = this.surface(glimmer.x) + glimmer.depth;
      const ahead = this.surface(glimmer.x + 4) + glimmer.depth;
      const norm = Math.hypot(4, ahead - y);
      push(glimmer.x, y, 4 / norm, (ahead - y) / norm, Math.min(48 * s, this.speed * glimmer.pace * LAKE_EXPOSURE), 1.2 * s, alpha, current);
    }
  }

  /** The lake's bed: its water deepening away from a surface that moves, and the waterline. */
  drawBed(ctx: CanvasRenderingContext2D, current: Rgb, dark: boolean): void {
    const W = this.width;
    const H = this.height;
    const left = this.left;
    const reach = W - left;
    const step = 6 * this.scale;
    const trace = (): void => {
      ctx.moveTo(left, this.surface(left));
      for (let x = left + step; x < W; x += step) ctx.lineTo(x, this.surface(x));
      ctx.lineTo(W, this.surface(W));
    };
    const depth = ctx.createLinearGradient(0, this.top, 0, H);
    depth.addColorStop(0, rgba(current, dark ? 0.13 : 0.14));
    depth.addColorStop(1, rgba(current, 0));
    ctx.fillStyle = depth;
    ctx.beginPath();
    trace();
    ctx.lineTo(W, H);
    ctx.lineTo(left + reach * 0.45, H);
    ctx.bezierCurveTo(left + reach * 0.12, H, left + reach * 0.2, this.top, left, this.top);
    ctx.closePath();
    ctx.fill();
    // The waterline, fainter than it was alone: the light moving along it carries it now.
    const line = ctx.createLinearGradient(left, 0, W, 0);
    line.addColorStop(0, rgba(current, 0));
    line.addColorStop(0.28, rgba(current, dark ? 0.5 : 0.55));
    line.addColorStop(1, rgba(current, dark ? 0.28 : 0.3));
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.25 * this.scale;
    ctx.beginPath();
    trace();
    ctx.stroke();
  }

  /** As many settled rows as the lake holds rows, on a log scale: an empty lake fills as rows land. */
  private fill(): void {
    if (this.area <= 0) return;
    const full = this.rows === null ? 0.6 : Math.min(1, Math.log10(1 + Math.max(0, this.rows)) / 9);
    const wanted = Math.min(MAX_MOTES, Math.round((this.area / (MOTE_AREA * this.scale * this.scale)) * full));
    while (this.motes.length < wanted) {
      const mote: Mote = { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, alpha: 0 };
      this.place(mote, false);
      // Already part way through its life, so the lake does not all fade in together.
      mote.age = Math.random() * mote.life;
      this.motes.push(mote);
    }
    if (this.motes.length > wanted) this.motes.length = wanted;
    const span = this.width - this.left;
    const glimmers = Math.round(span / (7 * this.scale));
    while (this.glimmers.length < glimmers) {
      this.glimmers.push({
        x: this.left + Math.random() * span,
        pace: 0.85 + Math.random() * 0.3,
        alpha: 0.25 + Math.random() * 0.45,
        depth: (0.6 + Math.random() * 1.8) * this.scale,
      });
    }
    if (this.glimmers.length > glimmers) this.glimmers.length = glimmers;
  }

  /** A settled row somewhere in the lake — or, carried back in from downstream, near the shore. */
  private place(mote: Mote, upstream: boolean): void {
    const y = this.top + 3 + Math.random() * Math.max(1, this.depth - 6);
    const shore = this.shore(y);
    mote.y = y;
    mote.x = upstream ? shore + Math.random() * 30 * this.scale : shore + Math.random() * Math.max(1, this.width + 8 - shore);
    // Moving with the water from the start, so even a still frame shows which way it flows.
    [mote.vx, mote.vy] = this.flow(mote.x, mote.y);
    mote.age = 0;
    mote.life = 10 + Math.random() * 18;
    mote.alpha = 0.3 + Math.random() * 0.6;
  }
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
