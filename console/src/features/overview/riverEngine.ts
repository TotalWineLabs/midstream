/**
 * The river's renderer: a particle system on canvases, kept apart from React so it can run every
 * frame without rendering anything (docs/10-design-system.md §10.8).
 *
 * Each materialization is a channel from Kafka, through the Midstream gate, into the lake. Its
 * particles are its records: their speed is its throughput — faster in the middle of the channel
 * than at its edges, as in a stream — and each leaves a trail as long as its speed, so velocity is
 * what you see. A record turns from mist to its state's colour exactly where it crosses the gate and
 * becomes a row. Rows run on into the lake as they were moving, under its surface, and slow into its
 * current (`riverLake.ts`), where every channel's rows combine and flow on. A backlog crowds the
 * channel; a failed or starting materialization holds its records at the gate; a stopped one is a
 * still, dashed channel.
 *
 * The bed canvas (channels, gate, lake) is drawn in 2D; the water — every particle a comet, its
 * trail as long as its speed — on the GPU (`riverWater.ts`), or in 2D where WebGL 2 is unavailable.
 * Both are drawn fresh each frame. Sizes and speeds follow the river's width, so a wide river is a
 * bolder one rather than a finer one.
 */
import { LAKE_EXPOSURE, Lake } from './riverLake';
import { COMET_FLOATS, RiverWater } from './riverWater';
import type { StatusKind } from '@/lib/status';

export interface RiverStrand {
  key: string;
  label: string;
  kind: StatusKind;
  /** Rows a second; null before its workers have reported twice. */
  rate: number | null;
}

type Rgb = [number, number, number];

export interface RiverPalette {
  dark: boolean;
  /** Records before the gate. */
  raw: Rgb;
  current: Rgb;
  dawn: Rgb;
  buoy: Rgb;
  flare: Rgb;
  slate: Rgb;
  ink: Rgb;
}

interface Track {
  key: string;
  strand: RiverStrand;
  /** Resampled every STEP px along the channel: positions and unit tangents. */
  xs: Float32Array;
  ys: Float32Array;
  txs: Float32Array;
  tys: Float32Array;
  length: number;
  gateAt: number;
  width: number;
  /** The curves it was laid along: a channel laid the same way again keeps everything. */
  shape: string;
  /** Speed at the channel's centre, px/s, easing toward `targetSpeed` as the rate changes. */
  speed: number;
  targetSpeed: number;
  particles: Particle[];
}

interface Particle {
  /** Position along the channel, 0–1. */
  f: number;
  /** Across the channel, −1 to 1, before it wanders. */
  u: number;
  /** Speed against the channel's centre: the laminar profile, with a little jitter. */
  v: number;
  alpha: number;
  phase: number;
  /** Where it was drawn last frame, to draw from; NaN when it has just appeared. */
  px: number;
  py: number;
  /** Seconds since it ran into the lake, or −1 while in its channel. */
  lake: number;
  /** Seconds it lasts in the lake before it has faded into it. */
  life: number;
  /** In the lake: where it is and how it moves, carried on from the channel. */
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Glint {
  key: string;
  y: number;
  t: number;
  rgb: Rgb;
}

const STEP = 2;
const GLINT_LIFE = 0.35;
/** Glints showing at once, at most: a gate that glints now and then, not one lit up. */
const GLINTS = 4;
/** Seconds a row lasts in the lake, on average: by then it has faded into the lake's own water. */
const LAKE_LIFE = 5;
/**
 * How fast a row fades into the lake: its time constant, long enough to see it join the lake's
 * current and run on in it, short enough that the water is brightest where the channel runs in.
 */
const LAKE_FADE = 1.5;
/** How fast rows slow in the lake, per second: along it, and down into it. */
const LAKE_DRAG = { along: 2, down: 4 };
const MAX_PARTICLES = 3200;
/** How steeply a channel meets the lake: enough that its rows run on under the surface. */
const ENTRY_SLOPE = 0.45;
/** A comet's trail: the distance it covers in this many seconds, up to `TRAIL_LONGEST` px. */
const TRAIL_SECONDS = { dark: 0.16, light: 0.16 };
const TRAIL_LONGEST = 64;
/** Alpha levels the 2D water is drawn at: one path per level and colour, rather than one per comet. */
const LEVELS = 8;
const ORDER: StatusKind[] = ['failed', 'attention', 'starting', 'catching-up', 'flowing', 'stopped'];

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** Centre speed for a rate, at a river 1100 px wide: a slow drift when barely anything flows, a rush at tens of thousands a second. */
export function speedFor(rate: number | null): number {
  if (rate === null) return 14;
  return 22 + 52 * Math.log10(1 + Math.max(0, rate));
}

/** How much of a row is left showing in the lake: fading from the moment it runs in, gone by the end of its life. */
function lakeFade(particle: Particle): number {
  const left = 1 - particle.lake / particle.life;
  return Math.exp(-particle.lake / LAKE_FADE) * Math.min(1, left * 4);
}

export class RiverEngine {
  /** The riverbed, the gate and the lake: drawn fresh each frame. */
  private readonly bed: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The water: on the GPU, or in 2D where WebGL 2 is unavailable. */
  private readonly water: HTMLCanvasElement;
  private readonly gpu: RiverWater | null;
  private readonly wctx: CanvasRenderingContext2D | null;
  /** Every comet this frame, `COMET_FLOATS` to each. */
  private comets = new Float32Array(0);
  /** A copy of the water, blurred by CSS under it: the bloom where the flow is dense. */
  private readonly glow: HTMLCanvasElement | null;
  private readonly gctx: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** Sizes and speeds against a river 1100 px wide. */
  private scale = 1;
  private palette: RiverPalette;
  private strands: RiverStrand[] = [];
  private tracks: Track[] = [];
  private glints: Glint[] = [];
  private hover: string | null = null;
  private frame = 0;
  private last = 0;
  private time = 0;
  private running = false;
  private gateX = 0;
  private gateTop = 0;
  private gateBottom = 0;
  private lakeY = 0;
  private lakeLeft = 0;
  /** The lake's own water: settled rows, its current, its surface. */
  private readonly lake = new Lake();
  private lakeRows: number | null = null;

  constructor(bed: HTMLCanvasElement, water: HTMLCanvasElement, glow: HTMLCanvasElement | null, palette: RiverPalette) {
    this.bed = bed;
    this.water = water;
    this.glow = glow;
    const ctx = bed.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.gpu = RiverWater.create(water);
    this.wctx = this.gpu ? null : water.getContext('2d');
    this.gctx = glow?.getContext('2d') ?? null;
    this.palette = palette;
  }

  /** Rows the lake holds: how full it shows. */
  setLakeRows(rows: number | null): void {
    this.lakeRows = rows;
    this.feedLake();
    if (!this.running) this.paint();
  }

  /** The lake's water: its rows, and the rows arriving a second, which set its current's speed. */
  private feedLake(): void {
    const arriving = this.strands.reduce((sum, strand) => sum + (strand.kind === 'stopped' ? 0 : Math.max(0, strand.rate ?? 0)), 0);
    this.lake.setFlow(this.lakeRows, arriving);
  }

  setPalette(palette: RiverPalette): void {
    this.palette = palette;
    if (!this.running) this.paint();
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = width;
    this.height = height;
    this.dpr = Math.min(2, dpr);
    for (const canvas of [this.bed, this.water]) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
    // The bloom is blurred anyway: half the pixels are plenty.
    if (this.glow) {
      this.glow.width = Math.round(width / 2);
      this.glow.height = Math.round(height / 2);
    }
    this.layout();
    this.paint();
  }

  setStrands(strands: RiverStrand[]): void {
    this.strands = strands;
    this.feedLake();
    this.layout();
    if (!this.running) this.paint();
  }

  setHover(key: string | null): void {
    this.hover = key;
    if (!this.running) this.paint();
  }

  /** The channel under a point, if any, for pointing and clicking. */
  hit(x: number, y: number): string | null {
    let best: string | null = null;
    let bestDistance = Infinity;
    for (const track of this.tracks) {
      const reach = Math.max(9, track.width / 2 + 5);
      for (let index = 0; index < track.xs.length; index += 3) {
        const dx = (track.xs[index] as number) - x;
        const dy = (track.ys[index] as number) - y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance && distance < reach * reach) {
          bestDistance = distance;
          best = track.key;
        }
      }
    }
    return best;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number): void => {
      if (!this.running) return;
      // A tab coming back from the background resumes, rather than jumping a minute's travel.
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.update(dt);
      this.drawBed();
      this.drawWater();
      this.bloom();
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.paint();
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.frame);
    this.gpu?.destroy();
  }

  /** One still frame, as if photographed: for reduced motion, an offscreen river, or a change while stopped. */
  private paint(): void {
    this.drawBed();
    this.drawWater();
    this.bloom();
  }

  private bloom(): void {
    if (!this.glow || !this.gctx) return;
    this.gctx.setTransform(1, 0, 0, 1, 0, 0);
    this.gctx.clearRect(0, 0, this.glow.width, this.glow.height);
    this.gctx.drawImage(this.water, 0, 0, this.glow.width, this.glow.height);
  }

  private layout(): void {
    const W = this.width;
    const H = this.height;
    if (W <= 0 || H <= 0) return;
    const s = Math.min(1.4, Math.max(0.8, W / 1100));
    this.scale = s;
    const sorted = [...this.strands].sort(
      (left, right) => ORDER.indexOf(left.kind) - ORDER.indexOf(right.kind) || (right.rate ?? 0) - (left.rate ?? 0),
    );
    const peak = Math.max(1, ...sorted.map((strand) => Math.log10(1 + Math.max(0, strand.rate ?? 0))));
    const widths = sorted.map((strand) =>
      strand.kind === 'stopped' ? 2 * s : (3 + 10 * Math.sqrt(Math.log10(1 + Math.max(0, strand.rate ?? 0)) / peak)) * s,
    );
    const total = widths.reduce((sum, width) => sum + width, 0);

    // The gate is the river's middle: records to its left, rows to its right.
    this.gateX = W * 0.5;
    this.lakeY = H * 0.74;
    this.lakeLeft = W * 0.6;
    this.lake.layout(W, H, s, this.lakeY, this.lakeLeft);
    const spread = (centre: number, gap: number): number[] => {
      let cursor = centre - (total + gap * Math.max(0, widths.length - 1)) / 2;
      return widths.map((width) => {
        const middle = cursor + width / 2;
        cursor += width + gap;
        return middle;
      });
    };
    const roomy = Math.min(26 * s, Math.max(5, (H * 0.8 - total) / Math.max(1, widths.length - 1)));
    const source = spread(H * 0.48, roomy);
    const gate = spread(H * 0.4, 2);
    this.gateTop = (gate[0] ?? H * 0.4) - (widths[0] ?? 0) / 2;
    this.gateBottom = (gate.at(-1) ?? H * 0.4) + (widths.at(-1) ?? 0) / 2;
    // A delta: the channel highest at the gate meets the lake farthest out, so none crosses another.
    const ends = sorted.map((_, index) => (sorted.length === 1 ? W * 0.74 : W * (0.86 - (0.22 * index) / (sorted.length - 1))));

    const previous = new Map(this.tracks.map((track) => [track.key, track]));
    const tracks = sorted.map((strand, index) => {
      const width = widths[index] as number;
      const ys = source[index] as number;
      const yg = gate[index] as number;
      const xe = ends[index] as number;
      const reach = xe - this.gateX;
      const segments: Array<[number, number, number, number, number, number, number, number]> = [
        [-14, ys, W * 0.2, ys, W * 0.32, yg, this.gateX, yg],
        // Leaving the gate level, then down into the lake at a slope, so its rows run on under the surface.
        [this.gateX, yg, this.gateX + reach * 0.5, yg, xe - reach * 0.3, this.lakeY - reach * 0.3 * ENTRY_SLOPE, xe, this.lakeY],
      ];
      return this.track(strand, width, segments, previous.get(strand.key));
    });

    // Every channel keeps its share when the fleet is large.
    const wanted = tracks.map((track) => this.particlesFor(track));
    const budget = wanted.reduce((sum, count) => sum + count, 0);
    const share = budget > MAX_PARTICLES ? MAX_PARTICLES / budget : 1;
    tracks.forEach((track, index) => {
      const count = Math.round((wanted[index] as number) * share);
      while (track.particles.length < count) track.particles.push(this.spawn(Math.random()));
      if (track.particles.length > count) track.particles.length = count;
    });
    this.tracks = tracks;
    for (const track of tracks) {
      if (!previous.has(track.key)) this.prime(track);
      // A failed or starting channel's records wait at its gate, even in a frame that never moves.
      const kind = track.strand.kind;
      if (kind !== 'failed' && kind !== 'starting') continue;
      const gateF = track.gateAt / track.length;
      for (const particle of track.particles) {
        if (particle.f < gateF - 0.003 && particle.lake < 0) continue;
        Object.assign(particle, this.spawn(gateF - 0.003 - Math.random() * Math.random() * 0.05));
      }
    }
  }

  /**
   * A channel new to the river arrives already flowing: each particle somewhere in its round, in the
   * channel or already in the lake, as often as it spends its time in each — the river as it is after
   * running a while, from the first frame, still or moving.
   */
  private prime(track: Track): void {
    const kind = track.strand.kind;
    if (kind === 'failed' || kind === 'starting' || kind === 'stopped') return;
    const gateF = track.gateAt / track.length;
    const pace = kind === 'attention' ? 0.45 : 1;
    for (const particle of track.particles) {
      const transit = (track.length * (gateF + (1 - gateF) / pace)) / Math.max(1, track.targetSpeed * particle.v);
      if (Math.random() >= LAKE_LIFE / (LAKE_LIFE + transit)) continue;
      particle.f = 1;
      this.enterLake(track, particle, pace);
      const age = Math.random() * particle.life;
      for (; particle.lake < age; particle.lake += 0.05) this.stepLake(particle, 0.05);
    }
  }

  /** Particles a channel carries: enough to fill it, more where a backlog crowds it, and its rows' time in the lake. */
  private particlesFor(track: Track): number {
    const kind = track.strand.kind;
    if (kind === 'stopped') return 0;
    // Counted at the river's own scale: a wider river is the same picture, larger.
    const area = (track.width * track.length) / (this.scale * this.scale);
    const fill = Math.min(300, Math.max(24, area / 70)) * (kind === 'catching-up' ? 1.8 : 1);
    const held = kind === 'failed' || kind === 'starting';
    return Math.round(fill * (held ? 1 : 1 + (LAKE_LIFE * track.targetSpeed) / track.length));
  }

  private track(
    strand: RiverStrand,
    width: number,
    segments: Array<[number, number, number, number, number, number, number, number]>,
    old: Track | undefined,
  ): Track {
    const shape = segments.map((segment) => segment.map((value) => value.toFixed(1)).join(',')).join(';');
    const targetSpeed = speedFor(strand.rate) * this.scale;
    if (old && old.shape === shape && old.width === width) {
      return { ...old, strand, targetSpeed };
    }
    // Sample densely, then resample by arc length so a particle's position is one array index.
    const raw: Array<[number, number]> = [];
    let gateIndex = 0;
    segments.forEach((segment, which) => {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = segment;
      for (let step = which === 0 ? 0 : 1; step <= 240; step += 1) {
        const t = step / 240;
        raw.push([cubic(x0, x1, x2, x3, t), cubic(y0, y1, y2, y3, t)]);
      }
      if (which === 0) gateIndex = raw.length - 1;
    });
    const cumulative = [0];
    for (let index = 1; index < raw.length; index += 1) {
      const [ax, ay] = raw[index - 1] as [number, number];
      const [bx, by] = raw[index] as [number, number];
      cumulative.push((cumulative[index - 1] as number) + Math.hypot(bx - ax, by - ay));
    }
    const length = cumulative.at(-1) as number;
    const count = Math.max(2, Math.floor(length / STEP));
    const xs = new Float32Array(count);
    const ys = new Float32Array(count);
    const txs = new Float32Array(count);
    const tys = new Float32Array(count);
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      const at = (index / (count - 1)) * length;
      while (cursor < cumulative.length - 2 && (cumulative[cursor + 1] as number) < at) cursor += 1;
      const [ax, ay] = raw[cursor] as [number, number];
      const [bx, by] = raw[cursor + 1] as [number, number];
      const span = (cumulative[cursor + 1] as number) - (cumulative[cursor] as number) || 1;
      const t = (at - (cumulative[cursor] as number)) / span;
      xs[index] = ax + (bx - ax) * t;
      ys[index] = ay + (by - ay) * t;
      const norm = Math.hypot(bx - ax, by - ay) || 1;
      txs[index] = (bx - ax) / norm;
      tys[index] = (by - ay) / norm;
    }
    // A relaid channel keeps its particles where they were along it, drawn afresh from there so
    // none streaks across from where the old channel ran. Rows in the lake run on as they were.
    const particles = old ? old.particles : [];
    for (const particle of particles) {
      if (particle.lake >= 0) continue;
      particle.px = Number.NaN;
      particle.py = Number.NaN;
    }
    return {
      key: strand.key,
      strand,
      xs,
      ys,
      txs,
      tys,
      length,
      gateAt: cumulative[gateIndex] as number,
      width,
      shape,
      speed: old ? old.speed : targetSpeed,
      targetSpeed,
      particles,
    };
  }

  private spawn(f: number): Particle {
    const u = (Math.random() * 2 - 1) * 0.95;
    return {
      f,
      u,
      // Laminar: the middle of the channel runs fastest.
      v: (1 - 0.6 * u * u) * (0.85 + Math.random() * 0.3),
      alpha: 0.35 + Math.random() * 0.65,
      phase: Math.random() * Math.PI * 2,
      px: Number.NaN,
      py: Number.NaN,
      lake: -1,
      life: LAKE_LIFE,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
    };
  }

  /** Where a particle is now, across its channel and wandering a little. */
  private place(track: Track, particle: Particle): [number, number] {
    const f = Math.max(0, Math.min(1, particle.f));
    const index = Math.min(track.xs.length - 1, Math.floor((f * track.length) / STEP));
    const tx = track.txs[index] as number;
    const ty = track.tys[index] as number;
    const wander = 0.07 * Math.sin(this.time * 0.9 + particle.phase * 3 + f * 9);
    const offset = Math.max(-1, Math.min(1, particle.u + wander)) * (track.width / 2);
    return [(track.xs[index] as number) - ty * offset, (track.ys[index] as number) + tx * offset];
  }

  private update(dt: number): void {
    this.time += dt;
    this.lake.advance(dt);
    for (const track of this.tracks) this.advance(track, dt);
    for (const glint of this.glints) glint.t += dt;
    this.glints = this.glints.filter((glint) => glint.t < GLINT_LIFE);
  }

  /** One step of a channel's water. */
  private advance(track: Track, dt: number): void {
    track.speed += (track.targetSpeed - track.speed) * Math.min(1, dt * 1.2);
    const kind = track.strand.kind;
    const holds = kind === 'failed' || kind === 'starting';
    const gateF = track.gateAt / track.length;
    for (const particle of track.particles) {
      if (particle.lake >= 0) {
        particle.lake += dt;
        if (particle.lake > particle.life) {
          Object.assign(particle, this.spawn(-Math.random() * 0.05));
          continue;
        }
        this.stepLake(particle, dt);
        continue;
      }
      const downstream = particle.f >= gateF;
      const pace = kind === 'attention' && downstream ? 0.45 : 1;
      const before = particle.f;
      particle.f += ((track.speed * particle.v * pace) / track.length) * dt;
      if (holds && particle.f >= gateF - 0.003) {
        // Held at the gate: records pile up where they cannot become rows.
        particle.f = gateF - 0.003 - Math.random() * Math.random() * 0.05;
        particle.px = Number.NaN;
        continue;
      }
      if (before < gateF && particle.f >= gateF && this.glints.length < GLINTS && Math.random() < 0.06) {
        this.glints.push({ key: track.key, y: this.place(track, particle)[1], t: 0, rgb: this.colorOf(kind) });
      }
      if (particle.f >= 1) this.enterLake(track, particle, pace);
    }
  }

  /**
   * A row in the lake, slowing to the lake's own current. The dive levels out where the water stops
   * it and the row runs on at that depth — never pulled back up, so never a hook.
   */
  private stepLake(particle: Particle, dt: number): void {
    const [u, v] = this.lake.flow(particle.x, particle.y);
    particle.vx = u + (particle.vx - u) * Math.exp(-LAKE_DRAG.along * dt);
    particle.vy = v + (particle.vy - v) * Math.exp(-LAKE_DRAG.down * dt);
    particle.x += particle.vx * dt;
    particle.y = Math.min(this.height - 2, particle.y + particle.vy * dt);
  }

  /** A row leaving its channel: on into the lake from where it was, as fast and in the same direction. */
  private enterLake(track: Track, particle: Particle, pace: number): void {
    const end = track.xs.length - 1;
    const tx = track.txs[end] as number;
    const ty = track.tys[end] as number;
    const over = (particle.f - 1) * track.length;
    const [x, y] = this.place(track, particle);
    const speed = track.speed * particle.v * pace;
    particle.lake = 0;
    particle.life = LAKE_LIFE * (0.7 + Math.random() * 0.6);
    particle.x = x + tx * over;
    particle.y = y + ty * over;
    particle.vx = tx * speed;
    particle.vy = ty * speed;
  }

  private colorOf(kind: StatusKind): Rgb {
    switch (kind) {
      case 'attention':
        return this.palette.buoy;
      case 'failed':
        return this.palette.flare;
      case 'starting':
        return this.palette.dawn;
      case 'stopped':
        return this.palette.slate;
      default:
        return this.palette.current;
    }
  }

  private dimOf(key: string): number {
    if (this.hover === null) return 1;
    return this.hover === key ? 1.2 : 0.2;
  }

  private drawBed(): void {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    if (W <= 0 || H <= 0) return;
    const { dark } = this.palette;
    const s = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.drawLake();

    // Riverbeds: each channel a faint band, so its water has somewhere to run. Butt ends, so the
    // colour changes at the gate and nowhere before it.
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const track of this.tracks) {
      const dim = this.dimOf(track.key);
      const stopped = track.strand.kind === 'stopped';
      const color = stopped ? this.palette.slate : this.colorOf(track.strand.kind);
      const gateIndex = Math.round(track.gateAt / STEP);
      const end = track.xs.length - 1;
      const trace = (from: number, to: number): void => {
        ctx.beginPath();
        for (let index = from; index <= to; index += 2) {
          const at = Math.min(index, end);
          if (index === from) ctx.moveTo(track.xs[at] as number, track.ys[at] as number);
          else ctx.lineTo(track.xs[at] as number, track.ys[at] as number);
        }
        ctx.lineTo(track.xs[to] as number, track.ys[to] as number);
      };
      // The last stretch thins out as it meets the lake: the channel runs into it rather than stopping at it.
      const ex = track.xs[end] as number;
      const ey = track.ys[end] as number;
      const fadeFrom = 30 * s;
      const intoLake = (rgb: Rgb, alpha: number): CanvasGradient => {
        const gradient = ctx.createLinearGradient(
          ex - (track.txs[end] as number) * fadeFrom,
          ey - (track.tys[end] as number) * fadeFrom,
          ex,
          ey,
        );
        gradient.addColorStop(0, rgba(rgb, alpha));
        gradient.addColorStop(1, rgba(rgb, 0));
        return gradient;
      };
      if (stopped) {
        trace(0, end);
        ctx.setLineDash([3 * s, 5 * s]);
        ctx.lineWidth = 1.5 * s;
        ctx.strokeStyle = intoLake(color, 0.65 * Math.min(1, dim));
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      // Records run in a neutral bed to the gate; rows in their state's colour after it.
      const edge = dark ? 0.035 : 0.045;
      const core = dark ? 0.06 : 0.075;
      trace(0, gateIndex);
      ctx.lineWidth = track.width + 6 * s;
      ctx.strokeStyle = rgba(this.palette.raw, edge * dim);
      ctx.stroke();
      ctx.lineWidth = track.width;
      ctx.strokeStyle = rgba(this.palette.raw, core * dim);
      ctx.stroke();
      trace(gateIndex, end);
      ctx.lineWidth = track.width + 6 * s;
      ctx.strokeStyle = intoLake(color, edge * dim);
      ctx.stroke();
      ctx.lineWidth = track.width;
      ctx.strokeStyle = intoLake(color, core * dim);
      ctx.stroke();
    }

    this.drawGate();

    // Where each channel springs from: its records' source in Kafka.
    for (const track of this.tracks) {
      const index = Math.min(track.xs.length - 1, Math.round(14 / STEP));
      const dim = this.dimOf(track.key);
      ctx.fillStyle = rgba(this.palette.raw, (dark ? 0.55 : 0.6) * Math.min(1, dim));
      ctx.beginPath();
      ctx.arc(track.xs[index] as number, track.ys[index] as number, Math.max(1.6, Math.min(3.4 * s, track.width / 4)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Every particle as a comet: where its head is, which way it moves, and a trail as long as its speed. */
  private buildComets(): number {
    const { dark } = this.palette;
    const s = this.scale;
    const width = (dark ? 1.6 : 2) * s;
    const seconds = dark ? TRAIL_SECONDS.dark : TRAIL_SECONDS.light;
    const longest = TRAIL_LONGEST * s;
    const total = this.tracks.reduce((sum, track) => sum + track.particles.length, 0) + this.lake.count;
    if (this.comets.length < total * COMET_FLOATS) this.comets = new Float32Array(Math.ceil(total * 1.25) * COMET_FLOATS);
    const data = this.comets;
    let at = 0;
    // The lake's own water first, beneath the rows running into it.
    this.lake.emit(
      (x, y, dx, dy, length, cometWidth, alpha, [r, g, b]) => {
        data[at] = x;
        data[at + 1] = y;
        data[at + 2] = dx;
        data[at + 3] = dy;
        data[at + 4] = length;
        data[at + 5] = cometWidth;
        data[at + 6] = alpha;
        data[at + 7] = r / 255;
        data[at + 8] = g / 255;
        data[at + 9] = b / 255;
        at += COMET_FLOATS;
      },
      this.palette.current,
      dark,
      // Pointing at a channel quiets the lake too, so its rows stand out in it.
      this.hover === null ? 1 : 0.45,
    );
    for (const track of this.tracks) {
      const dim = this.dimOf(track.key);
      const kind = track.strand.kind;
      const held = kind === 'failed' || kind === 'starting';
      const [r, g, b] = this.colorOf(kind);
      const gateF = track.gateAt / track.length;
      for (const particle of track.particles) {
        let x: number;
        let y: number;
        let dx: number;
        let dy: number;
        let speed: number;
        let fade: number;
        let exposure = seconds;
        if (particle.lake >= 0) {
          x = particle.x;
          y = particle.y;
          speed = Math.hypot(particle.vx, particle.vy);
          dx = speed > 0 ? particle.vx / speed : 1;
          dy = speed > 0 ? particle.vy / speed : 0;
          fade = lakeFade(particle);
          // Seen as the lake is, in long exposure, once it has levelled out of its dive: a long
          // straight trail on a row still turning would cut below the curve it took.
          const settled = Math.min(1, Math.max(0, (particle.lake - 0.7) / 1.3));
          exposure = seconds + (LAKE_EXPOSURE - seconds) * settled * settled * (3 - 2 * settled);
        } else {
          [x, y] = this.place(track, particle);
          const index = Math.min(track.xs.length - 1, Math.floor((Math.max(0, Math.min(1, particle.f)) * track.length) / STEP));
          dx = track.txs[index] as number;
          dy = track.tys[index] as number;
          // Held records shimmer in place: a point, not a streak.
          speed = held ? 0 : track.speed * particle.v * (kind === 'attention' && particle.f >= gateF ? 0.45 : 1);
          // Records fade in where they come out of Kafka.
          fade = Math.min(1, Math.max(0, particle.f) / 0.05);
        }
        const alpha = particle.alpha * (0.92 + 0.08 * Math.sin(this.time * 2.4 + particle.phase)) * fade * dim;
        if (alpha < 0.02) continue;
        data[at] = x;
        data[at + 1] = y;
        data[at + 2] = dx;
        data[at + 3] = dy;
        data[at + 4] = Math.min(longest, speed * exposure);
        data[at + 5] = width;
        data[at + 6] = alpha;
        data[at + 7] = r / 255;
        data[at + 8] = g / 255;
        data[at + 9] = b / 255;
        at += COMET_FLOATS;
      }
    }
    return at / COMET_FLOATS;
  }

  private drawWater(): void {
    const count = this.buildComets();
    const { dark, raw } = this.palette;
    const s = this.scale;
    const strengths = dark ? { raw: 0.6, row: 0.95 } : { raw: 0.7, row: 1 };
    if (this.gpu) {
      this.gpu.draw(this.comets, count, {
        width: this.width,
        height: this.height,
        dpr: this.dpr,
        dark,
        gateX: this.gateX,
        raw: [raw[0] / 255, raw[1] / 255, raw[2] / 255],
        rawStrength: strengths.raw,
        rowStrength: strengths.row,
        // A row just made is brightest — whiter in the dark, deeper in the light — for a moment past the gate.
        fresh: dark ? [1, 1, 1] : [0, 0, 0],
        freshAmount: dark ? 0.45 : 0.18,
        freshReach: 16 * s,
        halo: dark ? { spread: 4, gain: 0.14 } : { spread: 4, gain: 0.12 },
      });
      return;
    }
    const ctx = this.wctx;
    if (!ctx) return;
    // Without WebGL: each comet a plain stroke, split at the gate.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineCap = 'round';
    ctx.lineWidth = (dark ? 1.6 : 2) * s;
    const paths = new Map<string, Path2D>();
    const add = (style: string, ax: number, ay: number, bx: number, by: number): void => {
      let path = paths.get(style);
      if (!path) paths.set(style, (path = new Path2D()));
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
    };
    const data = this.comets;
    const gate = this.gateX;
    for (let at = 0; at < count * COMET_FLOATS; at += COMET_FLOATS) {
      const x = data[at] as number;
      const y = data[at + 1] as number;
      const length = data[at + 4] as number;
      const tx = x - (data[at + 2] as number) * length;
      const ty = y - (data[at + 3] as number) * length;
      const level = Math.max(1, Math.round((data[at + 6] as number) * LEVELS)) / LEVELS;
      const row = rgba(
        [Math.round((data[at + 7] as number) * 255), Math.round((data[at + 8] as number) * 255), Math.round((data[at + 9] as number) * 255)],
        level * strengths.row,
      );
      const record = rgba(raw, level * strengths.raw);
      if (tx < gate && x >= gate) {
        const crossing = ty + ((y - ty) * (gate - tx)) / (x - tx);
        add(record, tx, ty, gate, crossing);
        add(row, gate, crossing, x, y);
      } else {
        add(x < gate ? record : row, tx, ty, x + 0.01, y);
      }
    }
    for (const [style, path] of paths) {
      ctx.strokeStyle = style;
      ctx.stroke(path);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawLake(): void {
    this.lake.drawBed(this.ctx, this.palette.current, this.palette.dark);
  }

  private drawGate(): void {
    const ctx = this.ctx;
    const { dark, ink, current } = this.palette;
    const s = this.scale;
    const top = Math.max(4, this.gateTop - 20 * s);
    const bottom = Math.min(this.height - 4, this.gateBottom + 20 * s);
    const glow = ctx.createLinearGradient(0, top, 0, bottom);
    glow.addColorStop(0, rgba(ink, 0));
    glow.addColorStop(0.5, rgba(dark ? current : ink, dark ? 0.6 : 0.35));
    glow.addColorStop(1, rgba(ink, 0));
    ctx.strokeStyle = glow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(this.gateX, top);
    ctx.lineTo(this.gateX, bottom);
    ctx.stroke();
    // A record becoming a row: the gate glints where it passed.
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineWidth = 2 * s;
    for (const glint of this.glints) {
      const life = 1 - glint.t / GLINT_LIFE;
      const reach = 7 * s;
      const flash = ctx.createLinearGradient(0, glint.y - reach, 0, glint.y + reach);
      flash.addColorStop(0, rgba(glint.rgb, 0));
      flash.addColorStop(0.5, rgba(glint.rgb, (dark ? 0.9 : 0.8) * life * Math.min(1, this.dimOf(glint.key))));
      flash.addColorStop(1, rgba(glint.rgb, 0));
      ctx.strokeStyle = flash;
      ctx.beginPath();
      ctx.moveTo(this.gateX, glint.y - reach);
      ctx.lineTo(this.gateX, glint.y + reach);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
