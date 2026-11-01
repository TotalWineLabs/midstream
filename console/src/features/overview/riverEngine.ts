/**
 * The river's renderer: a particle system on two canvases, kept apart from React so it can run every
 * frame without rendering anything (docs/10-design-system.md §10.8).
 *
 * Each materialization is a channel from Kafka, through the Midstream gate, into the lake. Its
 * particles are its records: their speed is its throughput — faster in the middle of the channel
 * than at its edges, as in a stream — and each leaves a trail as long as its speed, so velocity is
 * what you see. A record turns from mist to Current as it passes the gate and becomes a row; rows
 * pour into the lake and dissolve, and each commit ripples its surface. A backlog crowds the
 * channel; a failed or starting materialization holds its records at the gate; a stopped one is a
 * still, dashed channel.
 *
 * The bed canvas (channels, gate, lake, ripples) is drawn fresh each frame; the water canvas keeps
 * what it drew and fades it, which is what makes the trails.
 */
import type { StatusKind } from '@/lib/status';

export interface RiverStrand {
  key: string;
  label: string;
  kind: StatusKind;
  /** Rows a second; null before its workers have reported twice. */
  rate: number | null;
  /** Rows committed: when it grows, a commit has landed in the lake. */
  rows: number | null;
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
  /** Speed at the channel's centre, px/s, easing toward `targetSpeed` as the rate changes. */
  speed: number;
  targetSpeed: number;
  particles: Particle[];
  /** Seconds to the next ambient ripple where it meets the lake. */
  rippleIn: number;
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
  /** Seconds in the lake, or −1 while in the channel. */
  lake: number;
  lx: number;
  ly: number;
  lvx: number;
}

interface Ripple {
  x: number;
  y: number;
  t: number;
  strength: number;
}

interface Spark {
  x: number;
  y: number;
  t: number;
}

const STEP = 2;
const RIPPLE_LIFE = 1.6;
const SPARK_LIFE = 0.4;
const LAKE_LIFE = 1.1;
const MAX_PARTICLES = 2400;
/**
 * How fast trails fade, per second: a half-life of about a tenth of a second in the dark, where they
 * glow, and shorter in the light, where a long trail reads as steps.
 */
const TRAIL_FADE = { dark: 7, light: 13 };
/** Alpha levels particles are drawn at: one path per level and colour, rather than one per particle. */
const LEVELS = 6;
const ORDER: StatusKind[] = ['failed', 'attention', 'starting', 'catching-up', 'flowing', 'stopped'];

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function rgba([r, g, b]: Rgb, a: number): string {
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/** Centre speed for a rate: a slow drift when barely anything flows, a rush at tens of thousands a second. */
export function speedFor(rate: number | null): number {
  if (rate === null) return 14;
  return 22 + 52 * Math.log10(1 + Math.max(0, rate));
}

/** Particles a channel carries: enough to fill it, more where a backlog crowds it. */
function particlesFor(strand: RiverStrand, width: number, length: number): number {
  if (strand.kind === 'stopped') return 0;
  return Math.round(Math.min(300, Math.max(24, (width * length) / 70)) * (strand.kind === 'catching-up' ? 1.8 : 1));
}

export class RiverEngine {
  /** The riverbed, the gate, the lake and its ripples: drawn fresh each frame. */
  private readonly bed: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The water: particles drawn over what they drew before, faded, so each leaves a trail. */
  private readonly water: HTMLCanvasElement;
  private readonly wctx: CanvasRenderingContext2D;
  /** A copy of the water, blurred by CSS under it: the bloom where the flow is dense. */
  private readonly glow: HTMLCanvasElement | null;
  private readonly gctx: CanvasRenderingContext2D | null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private palette: RiverPalette;
  private strands: RiverStrand[] = [];
  private tracks: Track[] = [];
  private ripples: Ripple[] = [];
  private sparks: Spark[] = [];
  private rows = new Map<string, number>();
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

  constructor(bed: HTMLCanvasElement, water: HTMLCanvasElement, glow: HTMLCanvasElement | null, palette: RiverPalette) {
    this.bed = bed;
    this.water = water;
    this.glow = glow;
    const ctx = bed.getContext('2d');
    const wctx = water.getContext('2d');
    if (!ctx || !wctx) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
    this.wctx = wctx;
    this.gctx = glow?.getContext('2d') ?? null;
    this.palette = palette;
  }

  setPalette(palette: RiverPalette): void {
    this.palette = palette;
    this.clearWater();
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
    // A commit landing: rows committed grew since the last frame.
    for (const strand of strands) {
      const before = this.rows.get(strand.key);
      if (strand.rows !== null) {
        if (before !== undefined && strand.rows > before) this.commitRipple(strand.key, strand.rows - before);
        this.rows.set(strand.key, strand.rows);
      }
    }
    this.strands = strands;
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
    this.clearWater();
    const tick = (now: number): void => {
      if (!this.running) return;
      // A tab coming back from the background resumes, rather than jumping a minute's travel.
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.update(dt);
      this.drawBed();
      this.drawWater(dt);
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
  }

  /** One still frame: for reduced motion, an offscreen river, or a change while stopped. */
  private paint(): void {
    this.drawBed();
    this.clearWater();
    this.drawStill();
    this.bloom();
  }

  private bloom(): void {
    if (!this.glow || !this.gctx) return;
    this.gctx.setTransform(1, 0, 0, 1, 0, 0);
    this.gctx.clearRect(0, 0, this.glow.width, this.glow.height);
    if (!this.palette.dark) return;
    this.gctx.drawImage(this.water, 0, 0, this.glow.width, this.glow.height);
  }

  private layout(): void {
    const W = this.width;
    const H = this.height;
    if (W <= 0 || H <= 0) return;
    const sorted = [...this.strands].sort(
      (left, right) => ORDER.indexOf(left.kind) - ORDER.indexOf(right.kind) || (right.rate ?? 0) - (left.rate ?? 0),
    );
    const peak = Math.max(1, ...sorted.map((strand) => Math.log10(1 + Math.max(0, strand.rate ?? 0))));
    const widths = sorted.map((strand) =>
      strand.kind === 'stopped' ? 2 : 3 + 10 * Math.sqrt(Math.log10(1 + Math.max(0, strand.rate ?? 0)) / peak),
    );
    const total = widths.reduce((sum, width) => sum + width, 0);

    this.gateX = W * 0.42;
    this.lakeY = H * 0.76;
    this.lakeLeft = W * 0.58;
    const spread = (centre: number, gap: number): number[] => {
      let cursor = centre - (total + gap * Math.max(0, widths.length - 1)) / 2;
      return widths.map((width) => {
        const middle = cursor + width / 2;
        cursor += width + gap;
        return middle;
      });
    };
    const roomy = Math.min(26, Math.max(5, (H * 0.8 - total) / Math.max(1, widths.length - 1)));
    const source = spread(H * 0.48, roomy);
    const gate = spread(H * 0.42, 2);
    this.gateTop = (gate[0] ?? H * 0.42) - (widths[0] ?? 0) / 2;
    this.gateBottom = (gate.at(-1) ?? H * 0.42) + (widths.at(-1) ?? 0) / 2;
    // A delta: the channel highest at the gate lands farthest out, so none crosses another.
    const ends = sorted.map((_, index) => (sorted.length === 1 ? W * 0.86 : W * (0.97 - (0.27 * index) / (sorted.length - 1))));

    const previous = new Map(this.tracks.map((track) => [track.key, track]));
    const tracks = sorted.map((strand, index) => {
      const width = widths[index] as number;
      const ys = source[index] as number;
      const yg = gate[index] as number;
      const xe = ends[index] as number;
      const segments: Array<[number, number, number, number, number, number, number, number]> = [
        [-14, ys, W * 0.16, ys, W * 0.26, yg, this.gateX, yg],
        [this.gateX, yg, this.gateX + (xe - this.gateX) * 0.55, yg, xe - (xe - this.gateX) * 0.2, this.lakeY, xe, this.lakeY],
      ];
      return this.track(strand, width, segments, previous.get(strand.key));
    });

    // Every channel keeps its share when the fleet is large.
    const budget = tracks.reduce((sum, track) => sum + particlesFor(track.strand, track.width, track.length), 0);
    const scale = budget > MAX_PARTICLES ? MAX_PARTICLES / budget : 1;
    for (const track of tracks) {
      const wanted = Math.round(particlesFor(track.strand, track.width, track.length) * scale);
      while (track.particles.length < wanted) track.particles.push(this.spawn(Math.random()));
      if (track.particles.length > wanted) track.particles.length = wanted;
    }
    this.tracks = tracks;
  }

  private track(
    strand: RiverStrand,
    width: number,
    segments: Array<[number, number, number, number, number, number, number, number]>,
    old: Track | undefined,
  ): Track {
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
    const targetSpeed = speedFor(strand.rate);
    // A relaid channel keeps its particles where they were along it: nothing jumps.
    const particles = old ? old.particles : [];
    for (const particle of particles) {
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
      speed: old ? old.speed : targetSpeed,
      targetSpeed,
      particles,
      rippleIn: old ? old.rippleIn : Math.random() * 2,
    };
  }

  private spawn(f: number): Particle {
    const u = (Math.random() * 2 - 1) * 0.95;
    return {
      f,
      u,
      // Laminar: the middle of the channel runs fastest.
      v: (1 - 0.6 * u * u) * (0.85 + Math.random() * 0.3),
      alpha: 0.3 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
      px: Number.NaN,
      py: Number.NaN,
      lake: -1,
      lx: 0,
      ly: 0,
      lvx: 0,
    };
  }

  private commitRipple(key: string, added: number): void {
    const track = this.tracks.find((candidate) => candidate.key === key);
    if (!track) return;
    const end = track.xs.length - 1;
    this.ripples.push({ x: track.xs[end] as number, y: this.lakeY, t: 0, strength: Math.min(1.8, 0.8 + Math.log10(1 + added) / 3) });
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
    for (const track of this.tracks) {
      track.speed += (track.targetSpeed - track.speed) * Math.min(1, dt * 1.2);
      const kind = track.strand.kind;
      const holds = kind === 'failed' || kind === 'starting';
      const gateF = track.gateAt / track.length;
      for (const particle of track.particles) {
        if (particle.lake >= 0) {
          particle.lake += dt;
          particle.lx += particle.lvx * dt;
          particle.lvx *= Math.exp(-2.2 * dt);
          particle.ly += 5 * dt;
          if (particle.lake > LAKE_LIFE) Object.assign(particle, this.spawn(-Math.random() * 0.05));
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
        if (before < gateF && particle.f >= gateF && Math.random() < 0.06) {
          const [x, y] = this.place(track, particle);
          this.sparks.push({ x, y, t: 0 });
        }
        if (particle.f >= 1) {
          const end = track.xs.length - 1;
          particle.lake = 0;
          particle.lx = track.xs[end] as number;
          particle.ly = this.lakeY + Math.random() * 1.5;
          particle.lvx = (track.txs[end] as number) * track.speed * particle.v * 0.8 + (Math.random() - 0.5) * 26;
        }
      }
      // Rows arriving keep the surface where it meets the lake gently moving.
      if (kind === 'flowing' || kind === 'catching-up') {
        track.rippleIn -= dt;
        if (track.rippleIn <= 0) {
          const end = track.xs.length - 1;
          this.ripples.push({ x: track.xs[end] as number, y: this.lakeY, t: 0, strength: 0.35 });
          track.rippleIn = Math.max(0.6, 3.4 - Math.log10(1 + Math.max(0, track.strand.rate ?? 0)) * 0.6) * (0.7 + Math.random() * 0.6);
        }
      }
    }
    for (const ripple of this.ripples) ripple.t += dt;
    this.ripples = this.ripples.filter((ripple) => ripple.t < RIPPLE_LIFE);
    for (const spark of this.sparks) spark.t += dt;
    this.sparks = this.sparks.filter((spark) => spark.t < SPARK_LIFE);
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
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.drawLake();

    // Riverbeds: each channel a faint band with soft edges, so its water has somewhere to run.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const track of this.tracks) {
      const dim = this.dimOf(track.key);
      const stopped = track.strand.kind === 'stopped';
      const color = stopped ? this.palette.slate : this.colorOf(track.strand.kind);
      const gateIndex = Math.round(track.gateAt / STEP);
      const trace = (from: number, to: number): void => {
        ctx.beginPath();
        for (let index = from; index <= to; index += 2) {
          const x = track.xs[Math.min(index, track.xs.length - 1)] as number;
          const y = track.ys[Math.min(index, track.xs.length - 1)] as number;
          if (index === from) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      };
      if (stopped) {
        trace(0, track.xs.length - 1);
        ctx.setLineDash([3, 5]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(color, 0.65 * Math.min(1, dim));
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      // Records run in a neutral bed to the gate; rows in their state's colour after it.
      for (const [from, to, rgb] of [
        [0, gateIndex, this.palette.raw],
        [gateIndex, track.xs.length - 1, color],
      ] as Array<[number, number, Rgb]>) {
        trace(from, to);
        ctx.lineWidth = track.width + 6;
        ctx.strokeStyle = rgba(rgb, (dark ? 0.035 : 0.03) * dim);
        ctx.stroke();
        ctx.lineWidth = track.width;
        ctx.strokeStyle = rgba(rgb, (dark ? 0.06 : 0.05) * dim);
        ctx.stroke();
      }
    }

    this.drawGate();

    // Where each channel springs from: its records' source in Kafka.
    for (const track of this.tracks) {
      const index = Math.min(track.xs.length - 1, Math.round(14 / STEP));
      const x = track.xs[index] as number;
      const y = track.ys[index] as number;
      const dim = this.dimOf(track.key);
      ctx.fillStyle = rgba(this.palette.raw, (dark ? 0.55 : 0.45) * Math.min(1, dim));
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.6, Math.min(3.2, track.width / 4)), 0, Math.PI * 2);
      ctx.fill();
    }

    // Commits landing: rings on the lake, flattened as a surface seen from the shore is.
    for (const ripple of this.ripples) {
      const life = ripple.t / RIPPLE_LIFE;
      const ease = 1 - (1 - life) * (1 - life);
      const radius = 2 + 34 * ease * ripple.strength;
      ctx.strokeStyle = rgba(this.palette.current, (1 - life) * (dark ? 0.6 : 0.5) * Math.min(1, ripple.strength));
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(ripple.x, ripple.y + 1, radius, radius * 0.24, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // A record becoming a row: a small light where it passes the gate.
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    for (const spark of this.sparks) {
      const life = 1 - spark.t / SPARK_LIFE;
      const glow = ctx.createRadialGradient(spark.x, spark.y, 0, spark.x, spark.y, 2 + 6 * (1 - life));
      glow.addColorStop(0, rgba(this.palette.current, 0.85 * life));
      glow.addColorStop(1, rgba(this.palette.current, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(spark.x - 9, spark.y - 9, 18, 18);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private clearWater(): void {
    this.wctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.wctx.clearRect(0, 0, this.width, this.height);
  }

  /** Each particle's move since the last frame, drawn over the water as it fades. */
  private drawWater(dt: number): void {
    const ctx = this.wctx;
    const { dark, raw } = this.palette;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Fade what is there: the trails.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${(1 - Math.exp(-(dark ? TRAIL_FADE.dark : TRAIL_FADE.light) * dt)).toFixed(3)})`;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineCap = 'butt';

    for (const track of this.tracks) {
      if (track.particles.length === 0) continue;
      const dim = this.dimOf(track.key);
      const down = this.colorOf(track.strand.kind);
      const held = track.strand.kind === 'failed' || track.strand.kind === 'starting';
      const gateF = track.gateAt / track.length;
      const blend = 22 / track.length;
      const strokes: Path2D[][] = [0, 1, 2].map(() => Array.from({ length: LEVELS }, () => new Path2D()));
      const lakeDots: Path2D[] = Array.from({ length: LEVELS }, () => new Path2D());
      for (const particle of track.particles) {
        const twinkle = 0.8 + 0.2 * Math.sin(this.time * 2.4 + particle.phase);
        if (particle.lake >= 0) {
          const fade = 1 - particle.lake / LAKE_LIFE;
          const level = Math.min(LEVELS - 1, Math.floor(particle.alpha * fade * twinkle * LEVELS));
          if (level > 0) (lakeDots[level] as Path2D).rect(particle.lx - 0.7, particle.ly - 0.7, 1.4, 1.4);
          continue;
        }
        const [x, y] = this.place(track, particle);
        const f = particle.f;
        const color = f < gateF - blend ? 0 : f > gateF + blend ? 2 : 1;
        // Records fade in where they come out of Kafka.
        const enter = Math.min(1, Math.max(0, f) / 0.05);
        const level = Math.min(LEVELS - 1, Math.floor(particle.alpha * twinkle * enter * LEVELS));
        if (level > 0) {
          const path = (strokes[color] as Path2D[])[level] as Path2D;
          // From where it was: held records shimmer in place rather than streak.
          if (Number.isNaN(particle.px) || held) {
            path.moveTo(x - 0.6, y);
            path.lineTo(x + 0.6, y);
          } else {
            path.moveTo(particle.px, particle.py);
            path.lineTo(x, y);
          }
        }
        particle.px = x;
        particle.py = y;
      }
      ctx.lineWidth = dark ? 1.4 : 1.25;
      const colors: Rgb[] = [raw, mix(raw, down, 0.5), down];
      colors.forEach((rgb, which) => {
        const strength = dark ? (which === 0 ? 0.55 : 0.95) : which === 0 ? 0.45 : 0.85;
        for (let level = 1; level < LEVELS; level += 1) {
          ctx.strokeStyle = rgba(rgb, (level / (LEVELS - 1)) * strength * dim);
          ctx.stroke((strokes[which] as Path2D[])[level] as Path2D);
        }
      });
      for (let level = 1; level < LEVELS; level += 1) {
        ctx.fillStyle = rgba(down, (level / (LEVELS - 1)) * 0.75 * dim);
        ctx.fill(lakeDots[level] as Path2D);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The water as one still moment: short streaks, as if photographed. */
  private drawStill(): void {
    const ctx = this.wctx;
    const { dark, raw } = this.palette;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    ctx.lineCap = 'round';
    ctx.lineWidth = dark ? 1.4 : 1.6;
    for (const track of this.tracks) {
      const dim = this.dimOf(track.key);
      const down = this.colorOf(track.strand.kind);
      const gateF = track.gateAt / track.length;
      for (const particle of track.particles) {
        if (particle.lake >= 0) continue;
        const [x, y] = this.place(track, particle);
        const index = Math.min(track.xs.length - 1, Math.floor((Math.max(0, Math.min(1, particle.f)) * track.length) / STEP));
        const tail = Math.max(1, Math.min(16, track.speed * particle.v * 0.08));
        ctx.strokeStyle = rgba(particle.f < gateF ? raw : down, particle.alpha * (particle.f < gateF ? 0.5 : 0.85) * dim);
        ctx.beginPath();
        ctx.moveTo(x - (track.txs[index] as number) * tail, y - (track.tys[index] as number) * tail);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawLake(): void {
    const ctx = this.ctx;
    const W = this.width;
    const H = this.height;
    const { dark, current } = this.palette;
    const left = this.lakeLeft;
    // The water: Current, deepening away from its surface, its near shore curving in.
    const depth = ctx.createLinearGradient(0, this.lakeY, 0, H);
    depth.addColorStop(0, rgba(current, dark ? 0.15 : 0.12));
    depth.addColorStop(1, rgba(current, 0));
    ctx.fillStyle = depth;
    ctx.beginPath();
    ctx.moveTo(left, this.lakeY);
    ctx.bezierCurveTo(left + (W - left) * 0.2, this.lakeY, left + (W - left) * 0.12, H, left + (W - left) * 0.45, H);
    ctx.lineTo(W, H);
    ctx.lineTo(W, this.lakeY);
    ctx.closePath();
    ctx.fill();
    // Light under the surface, shimmering as the water moves.
    for (let line = 0; line < 4; line += 1) {
      const y = this.lakeY + 7 + line * ((H - this.lakeY) / 5);
      const shimmer = 0.5 + 0.5 * Math.sin(this.time * (0.6 + line * 0.23) + line * 1.7);
      const from = left + (W - left) * (0.3 + 0.08 * line) + Math.sin(this.time * 0.25 + line) * 14;
      const sheen = ctx.createLinearGradient(from, 0, W, 0);
      sheen.addColorStop(0, rgba(current, 0));
      sheen.addColorStop(0.5, rgba(current, (dark ? 0.12 : 0.1) * shimmer * (1 - line / 4)));
      sheen.addColorStop(1, rgba(current, 0));
      ctx.strokeStyle = sheen;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(from, y);
      ctx.lineTo(W - 6, y);
      ctx.stroke();
    }
    // The waterline: where rows settle, and every engine can read them.
    const line = ctx.createLinearGradient(left, 0, W, 0);
    line.addColorStop(0, rgba(current, 0));
    line.addColorStop(0.28, rgba(current, dark ? 0.8 : 0.7));
    line.addColorStop(1, rgba(current, dark ? 0.45 : 0.4));
    ctx.strokeStyle = line;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(left, this.lakeY);
    ctx.lineTo(W, this.lakeY);
    ctx.stroke();
  }

  private drawGate(): void {
    const ctx = this.ctx;
    const { dark, ink, current } = this.palette;
    const top = Math.max(4, this.gateTop - 20);
    const bottom = Math.min(this.height - 4, this.gateBottom + 20);
    if (dark) {
      const middle = (top + bottom) / 2;
      const radius = Math.max(36, (bottom - top) * 0.9);
      const halo = ctx.createRadialGradient(this.gateX, middle, 0, this.gateX, middle, radius);
      halo.addColorStop(0, rgba(current, 0.1));
      halo.addColorStop(1, rgba(current, 0));
      ctx.fillStyle = halo;
      ctx.fillRect(this.gateX - radius, middle - radius, radius * 2, radius * 2);
    }
    const glow = ctx.createLinearGradient(0, top, 0, bottom);
    glow.addColorStop(0, rgba(ink, 0));
    glow.addColorStop(0.5, rgba(dark ? current : ink, dark ? 0.6 : 0.3));
    glow.addColorStop(1, rgba(ink, 0));
    ctx.strokeStyle = glow;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(this.gateX, top);
    ctx.lineTo(this.gateX, bottom);
    ctx.stroke();
  }
}
