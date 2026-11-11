import * as THREE from 'three';
import { MAX_OBSTACLES, type WaterImpulse, type WaterObstacle } from './registry.ts';

// GPU-Wellenringe: Höhenfeld 512² über 64 m × 64 m um die Kamera (Ping-Pong, R = Höhe, G = vorherige Höhe).
// Wellengleichung mit fester Schrittweite (60 Hz, höchstens 3 Schritte pro Frame). Wandert die Kamera, rückt
// das Feld in ganzen Texeln nach (beim Lesen verschoben), damit Ringe an ihrer Welt-Position bleiben.
// Mit der Hindernis-Maske (rippleMask.ts):
//  - Wände (Ufer, Mauern, Pfeiler, Steine) reflektieren die Ringe (Neumann-Rand: Nachbar in der Wand = eigene Höhe)
//  - flaches Wasser dämpft (Wellen laufen am Strand aus)
//  - das Feld treibt mit der Strömung mit (semi-Lagrange), Ringe werden flussabwärts getragen
//  - angeströmte Kanten erzeugen laufend Wellen: Bugwelle auf der Anströmseite, Wirbel im Kielwasser
// Bewegliche Hindernisse (Spieler, Fässer) kommen pro Frame als Kreise dazu — mit ihrer relativen Anströmung.

export const RIPPLE_RES = 512;
export const RIPPLE_SIZE = 64;
const MAX_IMP = 16;
const STEP = 1 / 60;

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D tPrev;
uniform sampler2D tMask;
uniform vec4 uMaskArea;
uniform vec2 uShift;
uniform vec2 uCenter;
uniform float uSize;
uniform float uTime;
uniform vec4 uImp[${MAX_IMP}];
uniform int uImpN;
uniform vec4 uObs[${MAX_OBSTACLES}];
uniform vec4 uObsF[${MAX_OBSTACLES}];
uniform int uObsN;
varying vec2 vUv;

const float TEXEL = ${(RIPPLE_SIZE / RIPPLE_RES).toFixed(6)};
const float DT = ${STEP.toFixed(6)};

float h(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return texture2D(tPrev, uv).r;
}
/** R = Wand/Nähe, G = Tiefe, BA = Strömung */
vec4 maskAt(vec2 wp) {
  if (uMaskArea.w < 0.5) return vec4(0.0, 4.0, 0.0, 0.0);
  vec2 m = (wp - uMaskArea.xy) / uMaskArea.z + 0.5;
  if (m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0) return vec4(0.0, 4.0, 0.0, 0.0);
  return texture2D(tMask, m);
}
bool solid(vec2 wp) {
  if (maskAt(wp).r > 0.75) return true;
  for (int i = 0; i < ${MAX_OBSTACLES}; i++) {
    if (i >= uObsN) break;
    if (length(wp - uObs[i].xy) < uObs[i].z) return true;
  }
  return false;
}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void main() {
  vec2 wp = uCenter + (vUv - 0.5) * uSize;
  if (solid(wp)) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec4 M = maskAt(wp);
  vec2 flow = M.ba;
  float speed = length(flow);
  // mit der Strömung mittreiben: Zustand vom Punkt stromaufwärts holen
  vec2 e = vec2(1.0 / ${RIPPLE_RES}.0);
  vec2 uv = vUv + uShift - flow * (DT / uSize);
  vec4 c = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture2D(tPrev, uv);
  // Nachbarn in einer Wand spiegeln die eigene Höhe (Reflexion ohne Phasensprung)
  float hR = solid(wp + vec2(TEXEL, 0.0)) ? c.r : h(uv + vec2(e.x, 0.0));
  float hL = solid(wp - vec2(TEXEL, 0.0)) ? c.r : h(uv - vec2(e.x, 0.0));
  float hT = solid(wp + vec2(0.0, TEXEL)) ? c.r : h(uv + vec2(0.0, e.y));
  float hB = solid(wp - vec2(0.0, TEXEL)) ? c.r : h(uv - vec2(0.0, e.y));
  float avg = (hR + hL + hT + hB) * 0.25;
  float n = c.r + (c.r - c.g) * 0.982 + (avg - c.r) * 1.2;
  n *= 0.997;
  // flaches Wasser: Wellen laufen aus
  n *= mix(0.93, 1.0, smoothstep(0.02, 0.18, M.g));

  // Stöße (Schritte, Kugeln, Objekte)
  for (int i = 0; i < ${MAX_IMP}; i++) {
    if (i >= uImpN) break;
    vec4 I = uImp[i];
    float d = length(wp - I.xy);
    float k = 1.0 - smoothstep(0.0, I.z, d);
    n += I.w * k * k;
  }

  // Strömung an festen Kanten: Nähe (R 0..0.5) und Richtung zur Wand aus dem Masken-Gradient
  if (speed > 0.05 && M.r > 0.02) {
    float gx = maskAt(wp + vec2(0.3, 0.0)).r - maskAt(wp - vec2(0.3, 0.0)).r;
    float gz = maskAt(wp + vec2(0.0, 0.3)).r - maskAt(wp - vec2(0.0, 0.3)).r;
    vec2 gw = vec2(gx, gz);
    float gl = length(gw);
    if (gl > 1e-3) {
      vec2 nrm = gw / gl;
      float face = dot(flow, nrm) / speed;
      float prox = clamp(M.r * 2.0, 0.0, 1.0);
      float sp = min(speed, 3.0);
      float turb = vnoise(wp * 2.4 - flow * uTime * 0.9 + vec2(uTime * 1.7, -uTime * 1.3)) - 0.5;
      float osc = sin(uTime * 9.0 - dot(wp, nrm) * 7.0 + vnoise(wp * 0.9) * 6.283);
      n += prox * prox * sp * (max(face, 0.0) * osc * 0.0022 + max(-face, 0.0) * turb * 0.006 + turb * 0.0015);
    }
  }

  // bewegliche Hindernisse: Bugwelle gegen die Anströmung, Wirbel dahinter
  for (int i = 0; i < ${MAX_OBSTACLES}; i++) {
    if (i >= uObsN) break;
    vec4 O = uObs[i];
    vec2 f = uObsF[i].xy;
    float sp = length(f);
    vec2 d = wp - O.xy;
    float dist = length(d);
    float rim = 1.0 - smoothstep(O.z, O.z + 0.7, dist);
    if (rim <= 0.0 || sp < 0.03) continue;
    vec2 nrm = -d / max(dist, 1e-3);
    float face = dot(f, nrm) / sp;
    float s = min(sp, 2.5) * O.w;
    float turb = vnoise(d * 3.2 - f * uTime * 0.8 + vec2(uTime * 2.1, uTime * 1.6) + float(i) * 7.1) - 0.5;
    float osc = sin(uTime * 11.0 + dist * 9.0);
    n += rim * rim * s * (max(face, 0.0) * osc * 0.006 + max(-face, 0.0) * turb * 0.016 + turb * 0.003);
  }

  // Ränder ausblenden (keine Reflexion am Feldrand)
  vec2 edge = min(vUv, 1.0 - vUv);
  n *= smoothstep(0.0, 0.03, min(edge.x, edge.y));
  gl_FragColor = vec4(clamp(n, -2.0, 2.0), c.r, 0.0, 1.0);
}
`;

export class RippleSim {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private idx = 0;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private acc = 0;
  private time = 0;
  private pending: WaterImpulse[] = [];
  private center = new THREE.Vector2(Infinity, Infinity);
  private cleared = false;
  /** xy = Mitte, z = Größe, w = aktiv (für das Wasser-Material) */
  readonly area = new THREE.Vector4(0, 0, RIPPLE_SIZE, 0);

  constructor(
    private renderer: THREE.WebGLRenderer,
    mask?: { texture: THREE.Texture; area: THREE.Vector4 },
  ) {
    const opts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false };
    this.targets = [new THREE.WebGLRenderTarget(RIPPLE_RES, RIPPLE_RES, opts), new THREE.WebGLRenderTarget(RIPPLE_RES, RIPPLE_RES, opts)];
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        tPrev: { value: null },
        tMask: { value: mask?.texture ?? null },
        uMaskArea: { value: mask?.area ?? new THREE.Vector4() },
        uShift: { value: new THREE.Vector2() },
        uCenter: { value: new THREE.Vector2() },
        uSize: { value: RIPPLE_SIZE },
        uTime: { value: 0 },
        uImp: { value: Array.from({ length: MAX_IMP }, () => new THREE.Vector4()) },
        uImpN: { value: 0 },
        uObs: { value: Array.from({ length: MAX_OBSTACLES }, () => new THREE.Vector4()) },
        uObsF: { value: Array.from({ length: MAX_OBSTACLES }, () => new THREE.Vector4()) },
        uObsN: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  get texture(): THREE.Texture {
    return this.targets[this.idx].texture;
  }

  add(list: WaterImpulse[]): void {
    for (const i of list) {
      if (this.pending.length >= 48) this.pending.shift();
      this.pending.push(i);
    }
  }

  /** bewegliche Hindernisse dieses Frames */
  setObstacles(list: readonly WaterObstacle[]): void {
    const u = this.mat.uniforms;
    const n = Math.min(MAX_OBSTACLES, list.length);
    for (let i = 0; i < n; i++) {
      const o = list[i];
      u.uObs.value[i].set(o.x, o.z, o.radius, o.strength);
      u.uObsF.value[i].set(o.flowX, o.flowZ, 0, 0);
    }
    u.uObsN.value = n;
  }

  /** Simulation weiterrechnen; `active` = Wasser in der Nähe der Kamera */
  update(dt: number, camX: number, camZ: number, active: boolean): void {
    this.area.w = active ? 1 : 0;
    if (!active) {
      this.pending.length = 0;
      this.acc = 0;
      return;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = false;
    if (!this.cleared) {
      const cc = r.getClearColor(new THREE.Color());
      const ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      for (const t of this.targets) {
        r.setRenderTarget(t);
        r.clear(true, false, false);
      }
      r.setClearColor(cc, ca);
      this.cleared = true;
    }
    this.acc = Math.min(this.acc + dt, STEP * 3);
    const u = this.mat.uniforms;
    const texel = RIPPLE_SIZE / RIPPLE_RES;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.time = (this.time + STEP) % 1000;
      u.uTime.value = this.time;
      // Feld auf ganze Texel an die Kamera rücken
      const nx = Math.round(camX / texel) * texel;
      const nz = Math.round(camZ / texel) * texel;
      if (!Number.isFinite(this.center.x) || Math.abs(nx - this.center.x) > RIPPLE_SIZE || Math.abs(nz - this.center.y) > RIPPLE_SIZE) {
        u.uShift.value.set(10, 10); // alles außerhalb → leer
      } else u.uShift.value.set((nx - this.center.x) / RIPPLE_SIZE, (nz - this.center.y) / RIPPLE_SIZE);
      this.center.set(nx, nz);
      u.uCenter.value.copy(this.center);
      const n = Math.min(MAX_IMP, this.pending.length);
      for (let i = 0; i < n; i++) {
        const p = this.pending[i];
        u.uImp.value[i].set(p.x, p.z, Math.max(texel * 1.5, p.radius), p.strength);
      }
      this.pending.splice(0, n);
      u.uImpN.value = n;
      u.tPrev.value = this.targets[this.idx].texture;
      this.idx = 1 - this.idx;
      r.setRenderTarget(this.targets[this.idx]);
      r.render(this.scene, this.cam);
    }
    this.area.set(this.center.x, this.center.y, RIPPLE_SIZE, 1);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.xr.enabled = prevXr;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.mat.dispose();
  }
}
