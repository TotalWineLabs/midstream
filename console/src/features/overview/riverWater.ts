/**
 * The river's water on the GPU: each particle a comet — a round head and a trail that tapers and
 * fades behind it — drawn as one instanced quad, so thousands stay smooth at any pixel density.
 * The colour is chosen per pixel: a record left of the gate, a row right of it, so a comet crossing
 * the gate changes colour exactly at the line. `riverEngine.ts` moves the particles; this draws them.
 */

/** Floats per comet: head x, y; direction x, y; trail length, width, alpha; colour r, g, b (0–1). */
export const COMET_FLOATS = 10;

export interface WaterFrame {
  /** The canvas in CSS pixels, and device pixels to each. */
  width: number;
  height: number;
  dpr: number;
  dark: boolean;
  gateX: number;
  /** Records' colour (0–1) and how strongly they are drawn; rows carry their own colour. */
  raw: [number, number, number];
  rawStrength: number;
  rowStrength: number;
  /** A row just made leans toward this colour, less and less over `freshReach` px past the gate. */
  fresh: [number, number, number];
  freshAmount: number;
  freshReach: number;
  /** A soft halo drawn under every comet: its width against the comet's, and its strength. */
  halo: { spread: number; gain: number } | null;
}

const VERTEX = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aHeadDir;
layout(location = 2) in vec3 aShape;
layout(location = 3) in vec3 aColor;
uniform vec2 uSize;
uniform float uSpread;
out vec2 vLocal;
out float vX;
out float vLength;
out float vRadius;
out float vAlpha;
out vec3 vColor;
void main() {
  float radius = 0.5 * aShape.y * uSpread;
  float pad = radius + 1.0;
  float along = aCorner.x > 0.5 ? pad : -aShape.x - pad;
  float across = aCorner.y * pad;
  vec2 dir = aHeadDir.zw;
  vec2 world = aHeadDir.xy + dir * along + vec2(-dir.y, dir.x) * across;
  gl_Position = vec4(world.x / uSize.x * 2.0 - 1.0, 1.0 - world.y / uSize.y * 2.0, 0.0, 1.0);
  vLocal = vec2(along, across);
  vX = world.x;
  vLength = aShape.x;
  vRadius = radius;
  vAlpha = aShape.z;
  vColor = aColor;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vX;
in float vLength;
in float vRadius;
in float vAlpha;
in vec3 vColor;
uniform float uDpr;
uniform float uGate;
uniform vec3 uRaw;
uniform float uRawStrength;
uniform float uRowStrength;
uniform vec3 uFresh;
uniform float uFreshAmount;
uniform float uFreshReach;
uniform float uSoft;
uniform float uGain;
out vec4 outColor;
void main() {
  float along = vLocal.x;
  // 1 at the head, 0 at the end of the trail.
  float t = vLength > 0.0 ? clamp(1.0 + along / vLength, 0.0, 1.0) : 1.0;
  float radius = max(0.001, vRadius * mix(0.4, 1.0, t));
  // The head is a disc (all of a comet with no trail, as a held record is); the trail fades behind it.
  bool head = along > 0.0 || vLength <= 0.0;
  float d = head ? length(vLocal) : abs(vLocal.y);
  float coverage = uSoft > 0.5
    ? exp(-2.5 * d * d / (radius * radius))
    : clamp((radius - d) * uDpr + 0.5, 0.0, 1.0);
  float body = head ? 1.0 : (along < -vLength ? 0.0 : t * t);
  vec3 color = vColor;
  float strength = uRowStrength;
  if (vX < uGate) {
    color = uRaw;
    strength = uRawStrength;
  } else {
    color = mix(vColor, uFresh, uFreshAmount * (1.0 - clamp((vX - uGate) / uFreshReach, 0.0, 1.0)));
  }
  float a = clamp(vAlpha * coverage * body * strength * uGain, 0.0, 1.0);
  outColor = vec4(color * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

interface Resources {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  corners: WebGLBuffer;
  comets: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export class RiverWater {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private resources: Resources | null;
  private readonly onLost = (event: Event): void => {
    // Ask for the context back; until then nothing is drawn.
    event.preventDefault();
    this.resources = null;
  };
  private readonly onRestored = (): void => {
    this.resources = this.build();
  };

  /** The water on a canvas, or null where WebGL 2 is unavailable (the engine then draws it in 2D). */
  static create(canvas: HTMLCanvasElement): RiverWater | null {
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) return null;
    const water = new RiverWater(canvas, gl);
    return water.resources ? water : null;
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.resources = this.build();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  private build(): Resources | null {
    const gl = this.gl;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    const vao = gl.createVertexArray();
    const corners = gl.createBuffer();
    const comets = gl.createBuffer();
    if (!vao || !corners || !comets) return null;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, comets);
    const stride = COMET_FLOATS * 4;
    for (const [location, size, offset] of [
      [1, 4, 0],
      [2, 3, 16],
      [3, 3, 28],
    ] as const) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    const names = ['uSize', 'uSpread', 'uDpr', 'uGate', 'uRaw', 'uRawStrength', 'uRowStrength', 'uFresh', 'uFreshAmount', 'uFreshReach', 'uSoft', 'uGain'];
    const uniforms = Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
    return { program, vao, corners, comets, uniforms };
  }

  /** Draws `count` comets from `data`, replacing what the canvas held. */
  draw(data: Float32Array, count: number, frame: WaterFrame): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const resources = this.resources;
    if (!resources || count === 0 || gl.isContextLost()) return;
    const { program, vao, comets, uniforms: u } = resources;
    gl.useProgram(program);
    gl.uniform2f(u.uSize ?? null, frame.width, frame.height);
    gl.uniform1f(u.uDpr ?? null, frame.dpr);
    gl.uniform1f(u.uGate ?? null, frame.gateX);
    gl.uniform3f(u.uRaw ?? null, ...frame.raw);
    gl.uniform1f(u.uRawStrength ?? null, frame.rawStrength);
    gl.uniform1f(u.uRowStrength ?? null, frame.rowStrength);
    gl.uniform3f(u.uFresh ?? null, ...frame.fresh);
    gl.uniform1f(u.uFreshAmount ?? null, frame.freshAmount);
    gl.uniform1f(u.uFreshReach ?? null, frame.freshReach);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, comets);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * COMET_FLOATS), gl.DYNAMIC_DRAW);
    gl.enable(gl.BLEND);
    // Light adds up in the dark; in the light, comets lie over one another like ink.
    if (frame.dark) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (frame.halo) {
      gl.uniform1f(u.uSpread ?? null, frame.halo.spread);
      gl.uniform1f(u.uSoft ?? null, 1);
      gl.uniform1f(u.uGain ?? null, frame.halo.gain);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    gl.uniform1f(u.uSpread ?? null, 1);
    gl.uniform1f(u.uSoft ?? null, 0);
    gl.uniform1f(u.uGain ?? null, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    const resources = this.resources;
    this.resources = null;
    if (!resources || this.gl.isContextLost()) return;
    this.gl.deleteBuffer(resources.corners);
    this.gl.deleteBuffer(resources.comets);
    this.gl.deleteVertexArray(resources.vao);
    this.gl.deleteProgram(resources.program);
  }
}
