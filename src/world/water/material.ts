import * as THREE from 'three';
import { MAX_WAVES, WAVES_GLSL, waveUniforms, type WaveSet } from './waves.ts';
import { WATER_TIME, type WaterLook } from './registry.ts';

// Wasser-Material (See, Fluss, Meer). Gezeichnet vom WaterPass direkt nach der opaken Szene:
//  - Gerstner-Wellen im Vertex-Shader (dieselben wie waterAt() auf der CPU), in der Ferne ausgeblendet
//  - Detail-Normalen aus einer kachelbaren Rauschtextur, bei Flüssen per Flow-Map (zweiphasig) in Strömungsrichtung
//  - Wellenringe aus der GPU-Ripple-Simulation (Schritte, Kugeln, Objekte, Anströmung)
//  - Heckwellen (Kelvin-Keil) hinter angeströmten Hindernissen, analytisch in Pixelauflösung: schräge Kämme an den
//    Armen, Querwellen im Keil, unruhiges Kielwasser mit Schaum direkt dahinter
//  - an Kanten (Hindernis-Maske der Ripple-Simulation): feineres Detail und Strömungsschaum an Ufern/Objekten
//  - Refraktion: Szene hinter dem Wasser (aufgelöste Farb-/Tiefentextur des MSAA-Puffers), verzerrt durch die Normale
//  - Tiefenfarbe: Absorption nach Beer-Lambert über die Wasserdicke, Trübung streut zur Wasserfarbe
//  - Uferschaum aus der Tiefendifferenz, Schaum auf Wellenkämmen
//  - Spiegelung: planare Reflexion (falls vorhanden) sonst Himmelsfarbe, Fresnel, Sonnenglanz
//  - Rückseite (Kamera unter Wasser): Snell-Fenster, Totalreflexion als Wasserfarbe

/** Kameraschicht der Wasserflächen und Spritzer (nur der WaterPass rendert sie) */
export const WATER_LAYER = 4;

/** so viele Heckwellen (Spieler, treibende Objekte) zeichnet das Material gleichzeitig */
export const MAX_WAKES = 4;

/** Gemeinsame Uniforms aller Wasser-Materialien (der WaterPass/das Wassersystem setzt sie pro Frame) */
export const waterShared = {
  uWaterTime: WATER_TIME,
  tScene: { value: null as THREE.Texture | null },
  tDepth: { value: null as THREE.Texture | null },
  uSceneOn: { value: 0 },
  uScreen: { value: new THREE.Vector2(1, 1) },
  uNear: { value: 0.1 },
  uFar: { value: 1000 },
  tReflection: { value: null as THREE.Texture | null },
  uReflMatrix: { value: new THREE.Matrix4() },
  uReflOn: { value: 0 },
  uReflY: { value: 0 },
  tRipple: { value: null as THREE.Texture | null },
  uRippleArea: { value: new THREE.Vector4(0, 0, 64, 0) },
  tRippleMask: { value: null as THREE.Texture | null },
  uMaskArea: { value: new THREE.Vector4(0, 0, 96, 0) },
  tDetail: { value: null as THREE.Texture | null },
  /** Heckwellen: xy = Position, zw = Anströmung (Wasser relativ zum Hindernis, m/s) */
  uWake: { value: Array.from({ length: MAX_WAKES }, () => new THREE.Vector4()) },
  /** Heckwellen: x = Stärke (0..1.2), y = Radius (m), z = Zufallswert */
  uWakeP: { value: Array.from({ length: MAX_WAKES }, () => new THREE.Vector4()) },
  uWakeN: { value: 0 },
  uSkyZenith: { value: new THREE.Color(0x5a7da8) },
  uSkyHorizon: { value: new THREE.Color(0xa8bccc) },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uAmbient: { value: new THREE.Color(0.35, 0.38, 0.42) },
};

// ---------- kachelbare Detail-Textur (RG = Gradient der Höhe, B = Höhe) ----------

let detailTex: THREE.DataTexture | null = null;

/** Summe zufälliger Sinuswellen mit ganzzahligen Wellenzahlen → nahtlos kachelbar */
export function waterDetailTexture(): THREE.DataTexture {
  if (detailTex) return detailTex;
  const N = 256;
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const waves: { kx: number; kz: number; a: number; p: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const f = 2 + Math.floor(Math.pow(rnd(), 1.6) * 22);
    const ang = rnd() * Math.PI * 2;
    const kx = Math.round(Math.cos(ang) * f);
    const kz = Math.round(Math.sin(ang) * f);
    if (!kx && !kz) continue;
    waves.push({ kx, kz, a: 1 / Math.pow(Math.hypot(kx, kz), 1.1), p: rnd() * Math.PI * 2 });
  }
  const h = new Float32Array(N * N);
  const gx = new Float32Array(N * N);
  const gz = new Float32Array(N * N);
  let maxG = 1e-6;
  let maxH = 1e-6;
  for (let z = 0; z < N; z++)
    for (let x = 0; x < N; x++) {
      let v = 0;
      let dx = 0;
      let dz = 0;
      for (const w of waves) {
        const ph = ((w.kx * x + w.kz * z) / N) * Math.PI * 2 + w.p;
        // abgerundete Kämme: |sin|-Anteil wie Kapillarwellen
        v += w.a * Math.sin(ph);
        const c = w.a * Math.cos(ph) * Math.PI * 2;
        dx += c * w.kx;
        dz += c * w.kz;
      }
      const i = z * N + x;
      h[i] = v;
      gx[i] = dx;
      gz[i] = dz;
      maxG = Math.max(maxG, Math.abs(dx), Math.abs(dz));
      maxH = Math.max(maxH, Math.abs(v));
    }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round((gx[i] / maxG) * 127.5 + 127.5);
    data[i * 4 + 1] = Math.round((gz[i] / maxG) * 127.5 + 127.5);
    data[i * 4 + 2] = Math.round((h[i] / maxH) * 127.5 + 127.5);
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  detailTex = t;
  return t;
}

// ---------- Shader ----------

const vertexShader = /* glsl */ `
${WAVES_GLSL}
uniform float uWaveFar;
attribute vec2 aFlow;
attribute float aFade;
varying vec3 vWPos;
varying vec3 vWaveN;
varying vec2 vFlow;
varying float vCrest;
varying float vViewZ;
varying float vFade;
#ifdef EDGE_CLIP
attribute float aEdge;
varying float vEdge;
#endif
#include <fog_pars_vertex>
void main() {
#ifdef EDGE_CLIP
  vEdge = aEdge;
#endif
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float dist = length(wp.xz - cameraPosition.xz);
  float fade = aFade * (1.0 - smoothstep(uWaveFar * 0.45, uWaveFar, dist));
  vec3 T, B;
  vec3 d = gerstner(wp.xz, fade, T, B);
  wp.xyz += d;
  vWaveN = normalize(cross(B, T));
  float amp = 0.0;
  for (int i = 0; i < MAX_WAVES; i++) amp += uWaveA[i].w;
  vCrest = amp > 1e-4 ? d.y / amp : 0.0;
  vWPos = wp.xyz;
  vFlow = aFlow;
  vFade = fade;
  vec4 mvPosition = viewMatrix * wp;
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const fragmentShader = /* glsl */ `
uniform float uWaterTime;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform float uSceneOn;
uniform vec2 uScreen;
uniform float uNear, uFar;
uniform sampler2D tReflection;
uniform mat4 uReflMatrix;
uniform float uReflOn, uReflY;
uniform sampler2D tRipple;
uniform vec4 uRippleArea; // xy = Mitte, z = Größe, w = an
uniform sampler2D tRippleMask;
uniform vec4 uMaskArea; // xy = Mitte, z = Größe, w = gültig
uniform sampler2D tDetail;
uniform vec4 uWake[${MAX_WAKES}];
uniform vec4 uWakeP[${MAX_WAKES}];
uniform int uWakeN;
uniform vec3 uSkyZenith, uSkyHorizon, uSunDir, uSunColor, uAmbient;
uniform vec3 uColor;
uniform float uMurk, uClarity, uFoam, uShore, uDetailScale, uDetailStrength, uDrift;
uniform vec2 uWind;
varying vec3 vWPos;
varying vec3 vWaveN;
varying vec2 vFlow;
varying float vCrest;
varying float vViewZ;
varying float vFade;
#ifdef EDGE_CLIP
varying float vEdge;
#endif
#include <fog_pars_fragment>

float linDepth(float d) {
#ifdef USE_REVERSED_DEPTH_BUFFER
  if (d <= 1e-7) return 1e6;
  return uNear * uFar / (uNear + d * (uFar - uNear));
#else
  if (d >= 0.99999) return 1e6;
  return uNear * uFar / (uFar - d * (uFar - uNear));
#endif
}

vec3 skyColor(vec3 d) {
  vec3 c = mix(uSkyHorizon, uSkyZenith, pow(smoothstep(0.0, 1.0, d.y), 0.55));
  if (d.y < 0.0) c = uSkyHorizon * 0.45;
  return c;
}

vec2 detailGrad(vec2 uv) {
  return texture2D(tDetail, uv).rg * 2.0 - 1.0;
}

/** Detail-Normale (Gradient) – Fluss: zweiphasige Flow-Map, sonst zwei driftende Schichten */
vec2 detail(vec2 p) {
  vec2 uv = p / uDetailScale;
  float fl = length(vFlow);
  vec2 g;
  if (fl > 0.01) {
    float t = uWaterTime * 0.35;
    float p0 = fract(t);
    float p1 = fract(t + 0.5);
    vec2 f = vFlow / uDetailScale;
    vec2 a = detailGrad(uv - f * p0 * 2.86) + detailGrad(uv * 2.3 - f * p0 * 6.6 + 0.37) * 0.5;
    vec2 b = detailGrad(uv - f * p1 * 2.86 + 0.5) + detailGrad(uv * 2.3 - f * p1 * 6.6 + 0.87) * 0.5;
    // Jede Phase springt beim Umlauf auf 0 zurück — dann muss ihr Gewicht 0 sein (a springt bei p0 = 0, b bei p0 = 0,5)
    float w = abs(1.0 - 2.0 * p0);
    g = mix(a, b, w);
    g *= 1.0 + min(fl, 3.0) * 0.25;
  } else {
    vec2 drift = uWind * uWaterTime * uDrift;
    g = detailGrad(uv + drift * 0.03) + detailGrad(uv * 1.9 - drift.yx * 0.021 + 0.41) * 0.6;
  }
  return g;
}

/** Gradient der Ripple-Höhe (Welt-XZ) */
vec2 rippleGrad(vec2 p, out float h) {
  h = 0.0;
  if (uRippleArea.w < 0.5) return vec2(0.0);
  vec2 uv = (p - uRippleArea.xy) / uRippleArea.z + 0.5;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec2(0.0);
  float e = 1.0 / 512.0;
  h = texture2D(tRipple, uv).r;
  float hx = texture2D(tRipple, uv + vec2(e, 0.0)).r - texture2D(tRipple, uv - vec2(e, 0.0)).r;
  float hz = texture2D(tRipple, uv + vec2(0.0, e)).r - texture2D(tRipple, uv - vec2(0.0, e)).r;
  vec2 edge = min(uv, 1.0 - uv);
  float k = smoothstep(0.0, 0.08, min(edge.x, edge.y));
  return vec2(hx, hz) / (2.0 * e * uRippleArea.z) * k;
}

/**
 * Heckwellen aller angeströmten Hindernisse: xy = Gradient (Steigung), z = Schaum.
 * Kelvin-Keil im Hindernis-System (a = stromabwärts, c = quer): Wellenlänge λ = 2π v²/g (begrenzt), das Muster steht
 * relativ zum Hindernis (das Wasser strömt hindurch), nur ein leichtes Flimmern läuft mit.
 */
vec3 wakes(vec2 p) {
  vec3 o = vec3(0.0);
  for (int i = 0; i < ${MAX_WAKES}; i++) {
    if (i >= uWakeN) break;
    vec4 W = uWake[i];
    vec4 P = uWakeP[i];
    vec2 f = W.zw;
    float u = length(f);
    if (u < 0.06) continue;
    vec2 fd = f / u;
    vec2 d = p - W.xy;
    float a = dot(d, fd);
    float L = 2.0 + min(u, 2.5) * 4.0;
    float r = P.y;
    if (a < -r - 0.6 || a > L || dot(d, d) > (L + 1.0) * (L + 1.0)) continue;
    vec2 side = vec2(-fd.y, fd.x);
    float cs = dot(d, side);
    float c = abs(cs);
    vec2 dc = side * sign(cs + 1e-5);
    float s = P.x * smoothstep(0.06, 0.45, u);
    float tt = uWaterTime;

    // Bugwelle: ein Kamm vor dem Hindernis, der seitlich in die Arme übergeht
    float bowR = r + 0.12 + u * 0.06;
    float rr = length(d);
    float bowE = exp(-pow((rr - bowR) / 0.07, 2.0)) * smoothstep(0.2, -0.6, a / max(rr, 1e-3)) * s;
    o.xy += (d / max(rr, 1e-3)) * (-2.0 * (rr - bowR) / (0.07 * 0.07)) * bowE * 0.012;
    o.z += bowE * 0.4;
    if (a <= 0.0) continue;

    float lam = clamp(6.283 * u * u / 9.81, 0.24, 1.6);
    float kT = 6.283 / lam;
    float kD = kT * 1.7;
    // Abklingen nach hinten (Energie verteilt sich auf den wachsenden Keil), weich auslaufen
    float decay = smoothstep(0.0, r + 0.15, a) * inversesqrt(1.0 + a * 0.9) * (1.0 - smoothstep(L * 0.55, L, a));
    float W2 = r * 0.9 + a * 0.354; // Keilrand (19,5°)

    // schräge Kämme an den Armen (Wellenvektor ~55° zur Bahn, nach außen)
    // Hülle: außen am Keilrand am stärksten, nach innen weich auslaufend (kurze, gefiederte Kämme statt Linien)
    float wA = 0.1 + a * 0.09;
    float dx = (c - W2 * 0.9) / wA;
    float armE = exp(-dx * dx * (dx > 0.0 ? 2.5 : 0.6));
    float phD = kD * (0.82 * a - 0.57 * c) - tt * 1.3 + P.z * 6.283;
    float eD = armE * decay * s;
    // leicht spitze Kämme (Trochoide): Steigung vor dem Kamm steiler als dahinter
    float sD = sin(phD);
    o.xy += cos(phD) * (1.0 + 0.45 * sD) * (fd * 0.82 - dc * 0.57) * eD * 0.6;
    o.z += smoothstep(0.55, 1.0, sD) * eD * smoothstep(0.2, 1.0, a) * (1.0 - smoothstep(1.0, 3.5, a)) * 0.45;

    // Querwellen im Keil (gebogene Kämme, zur Mitte hin vorne)
    float inner = 1.0 - smoothstep(W2 * 0.5, W2 * 0.95, c);
    float phT = kT * (a + c * c * 0.35 / max(a, 0.3)) - tt * 0.9 + P.z * 3.1;
    float eT = inner * decay * s * 0.55;
    o.xy += cos(phT) * (1.0 + 0.45 * sin(phT)) * (fd + dc * (0.7 * c / max(a, 0.3))) * eT * 0.35;

    // Kielwasser: unruhiger, schäumender Streifen direkt hinter dem Hindernis (schmal beginnend, aufgefächert)
    float kw = r * 0.8 + a * 0.16;
    float kE = (1.0 - smoothstep(kw * 0.5, kw, c)) * (1.0 - smoothstep(0.4, 1.2 + u * 1.6, a)) * smoothstep(0.0, r * 0.6, a) * s;
    if (kE > 0.002) {
      vec2 q = vec2(a - tt * (0.4 + u * 0.7), cs) * 1.3 + P.z * 13.0;
      vec2 n1 = texture2D(tDetail, q * 0.31).rg * 2.0 - 1.0;
      vec2 n2 = texture2D(tDetail, q * 0.67 + vec2(0.37, tt * 0.05)).rg * 2.0 - 1.0;
      vec2 tg = n1 + n2 * 0.6;
      o.xy += (fd * tg.x + side * tg.y) * kE * 0.28;
      float fn = texture2D(tDetail, q * 0.45 + 0.21).b * 0.65 + texture2D(tDetail, q * 1.3 - 0.4).b * 0.35;
      o.z += smoothstep(0.55, 0.85, fn + kE * 0.15 - a * 0.05) * kE * 0.75;
    }
  }
  return o;
}

/** Nähe zur nächsten Kante/zum nächsten Objekt (0..1, 1 = direkt daneben) aus der Hindernis-Maske */
float edgeNear(vec2 p) {
  if (uMaskArea.w < 0.5) return 0.0;
  vec2 m = (p - uMaskArea.xy) / uMaskArea.z + 0.5;
  if (m.x <= 0.0 || m.y <= 0.0 || m.x >= 1.0 || m.y >= 1.0) return 0.0;
  float r = texture2D(tRippleMask, m).r;
  vec2 b = min(m, 1.0 - m);
  return (r > 0.75 ? 1.0 : r * 2.0) * smoothstep(0.0, 0.06, min(b.x, b.y));
}

void main() {
#ifdef EDGE_CLIP
  if (vEdge < 0.5) discard;
#endif
  vec3 V = cameraPosition - vWPos;
  float camDist = length(V);
  V /= camDist;
  bool front = gl_FrontFacing;

  // Normale: Wellen + Detail (in der Ferne schwächer gegen Flimmern) + Wellenringe
  float detailK = uDetailStrength * (1.0 - smoothstep(30.0, 260.0, camDist) * 0.75);
  float nearCam = 1.0 - smoothstep(20.0, 80.0, camDist);
  float edgeK = edgeNear(vWPos.xz) * nearCam;
  float flowSp = length(vFlow);
  vec2 g = detail(vWPos.xz) * detailK * (1.0 + edgeK * 0.7);
  // an Kanten: zusätzliche feine, unruhige Kräuselung (stärker, wenn das Wasser dort strömt)
  if (edgeK > 0.01) {
    vec2 fuv = vWPos.xz * (3.7 / uDetailScale);
    vec2 ft2 = vec2(uWaterTime * 0.11, -uWaterTime * 0.08) * (1.0 + min(flowSp, 3.0));
    g += (detailGrad(fuv + ft2) - detailGrad(fuv * 1.6 - ft2.yx + 0.31) * 0.6) * edgeK * uDetailStrength * (0.35 + min(flowSp, 2.0) * 0.35);
  }
  float rh;
  vec2 rg = rippleGrad(vWPos.xz, rh);
  // Wellenringe nah an der Kamera deutlicher (Waten, Schritte, Bugwelle)
  float rk = 1.6 + nearCam * 1.4;
  vec3 wk = uWakeN > 0 && nearCam > 0.0 ? wakes(vWPos.xz) * nearCam : vec3(0.0);
  vec3 N = normalize(vWaveN + vec3(-g.x - rg.x * rk - wk.x, 0.0, -g.y - rg.y * rk - wk.y));
  if (!front) N = -N;

  vec2 suv = gl_FragCoord.xy / uScreen;
  float sunUp = clamp(uSunDir.y * 3.0, 0.0, 1.0);
  vec3 light = uAmbient + uSunColor * max(uSunDir.y, 0.0) * 0.6;
  // Farbe des tiefen/trüben Wassers (Streulicht)
  vec3 deep = uColor * light * (0.45 + uMurk * 0.35);

  // Extinktion: Sichttiefe = Distanz, nach der ~5 % durchkommen; Farbe bestimmt, welche Kanäle schneller verschwinden
  float vis = max(uClarity, 0.2);
  vec3 ext = (3.0 / vis) * mix(vec3(1.0), (1.0 - uColor) * 1.6 + 0.25, 0.75) * (1.0 + uMurk * 3.0);

  vec3 refr = deep;
  float thick = 1e3;
  float vthick = 1e3;
  if (uSceneOn > 0.5) {
    vec3 camF = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    float cosV = max(dot(-V, camF), 0.05);
    float sceneZ = linDepth(texture2D(tDepth, suv).x);
    float rawThick = max(sceneZ - vViewZ, 0.0) / cosV;
    vec2 off = (N.xz - vWaveN.xz * 0.5) * 0.06 * clamp(rawThick, 0.0, 1.0) / max(1.0, camDist * 0.05);
    vec2 ruv = clamp(suv + off, vec2(0.001), vec2(0.999));
    float sceneZ2 = linDepth(texture2D(tDepth, ruv).x);
    if (sceneZ2 < vViewZ) {
      ruv = suv;
      sceneZ2 = sceneZ;
    }
    thick = max(sceneZ2 - vViewZ, 0.0) / cosV;
    vthick = thick * max(V.y, 0.05);
    refr = texture2D(tScene, ruv).rgb;
  }

  vec3 col;
  if (front) {
    vec3 T = exp(-ext * thick);
    vec3 body = refr * T + deep * (1.0 - T);
    // Trübung: Streuung bereits nach wenigen Zentimetern
    body = mix(body, deep, (1.0 - exp(-thick * uMurk * 1.5)) * uMurk);

    // Spiegelung
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    vec3 refl = skyColor(R);
    if (uReflOn > 0.5) {
      vec4 rc = uReflMatrix * vec4(vWPos.x, uReflY, vWPos.z, 1.0);
      vec2 puv = rc.xy / rc.w + N.xz * 0.035;
      vec2 e = min(puv, 1.0 - puv);
      float ok = smoothstep(0.0, 0.03, min(e.x, e.y)) * (1.0 - smoothstep(0.5, 2.5, abs(vWPos.y - uReflY)));
      refl = mix(refl, texture2D(tReflection, puv).rgb, ok);
    }
    float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);
    col = mix(body, refl, clamp(F, 0.0, 1.0));

    // Sonnenglanz
    vec3 H = normalize(uSunDir + V);
    float spec = pow(max(dot(N, H), 0.0), 900.0) * 18.0 + pow(max(dot(N, H), 0.0), 120.0) * 0.6;
    col += uSunColor * spec * sunUp * F * 4.0;

    // Schaum: Ufer (geringe Tiefe), Wellenkämme, Wellenringe
    // Strömungs-Rauschen zweiphasig wie detail(): ein Versatz „Strömung × Zeit“ wüchse unbegrenzt, und jede kleine
    // Änderung der Strömung (Simulation) ließe den Schaum springen
    float ft = uWaterTime * 0.35;
    float fp0 = fract(ft);
    float fp1 = fract(ft + 0.5);
    float fa = texture2D(tDetail, vWPos.xz * 0.53 - vFlow * fp0 * 0.343).b;
    float fb = texture2D(tDetail, vWPos.xz * 0.53 - vFlow * fp1 * 0.343).b;
    float fn = texture2D(tDetail, vWPos.xz * 0.21 + vec2(uWaterTime * 0.02, 0.0)).b * 0.6 + mix(fa, fb, abs(1.0 - 2.0 * fp0)) * 0.4;
    float shore = (1.0 - smoothstep(0.0, uShore, vthick)) * step(0.5, uSceneOn);
    float crest = smoothstep(0.5, 0.95, vCrest) * vFade;
    float flowFoam = smoothstep(1.2, 4.0, flowSp) * 0.35;
    // angeströmte Kanten/Objekte: Schaumstreifen und Wirbel
    float edgeFoam = edgeK * edgeK * smoothstep(0.25, 1.5, flowSp) * 0.8;
    float rippleFoam = clamp(rh * 6.0, 0.0, 1.0) * 0.6 + smoothstep(0.35, 1.2, length(rg)) * 0.25 * nearCam;
    float wakeFoam = wk.z * (0.6 + uFoam * 0.4);
    float foam = clamp((shore * 1.2 + crest * 0.8 + flowFoam + edgeFoam + rippleFoam) * uFoam + wakeFoam, 0.0, 1.0);
    foam *= smoothstep(0.25, 0.75, fn + foam * 0.35);
    col = mix(col, light * 0.95, foam);
  } else {
    // Von unten: innerhalb des Snell-Fensters (~48,6°) sieht man nach oben, außerhalb Totalreflexion
    float c = clamp(dot(N, V), 0.0, 1.0);
    float window = smoothstep(0.62, 0.72, c);
    vec3 above = uSceneOn > 0.5 ? texture2D(tScene, clamp(suv + N.xz * 0.05, vec2(0.001), vec2(0.999))).rgb : skyColor(vec3(0.0, 1.0, 0.0));
    col = mix(deep * 0.8, above * 0.9 + deep * 0.1, window);
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export interface WaterMaterialOptions {
  look: WaterLook;
  waves: WaveSet;
  /** Distanz, ab der Wellen ausgeblendet sind (Meer groß, See klein) */
  waveFar?: number;
  /** Detail-Kachel (m) */
  detailScale?: number;
  detailStrength?: number;
  windDir?: number;
  /** Kante über das Attribut `aEdge` ausschneiden (Rand bei 0.5) — abgerundete Ränder des Simulationswassers */
  edgeClip?: boolean;
  /** Wassertiefe (m), bis zu der Uferschaum entsteht (Standard 0.25 + Schaum · 0.9; flaches Simulationswasser kleiner) */
  shoreFoam?: number;
}

export type WaterMaterial = THREE.ShaderMaterial & {
  uniforms: typeof waterShared & {
    uWaveA: { value: THREE.Vector4[] };
    uWaveB: { value: THREE.Vector4[] };
    uWaveFar: { value: number };
    uColor: { value: THREE.Color };
    uMurk: { value: number };
    uClarity: { value: number };
    uFoam: { value: number };
    uShore: { value: number };
    uDetailScale: { value: number };
    uDetailStrength: { value: number };
    uDrift: { value: number };
    uWind: { value: THREE.Vector2 };
  };
};

export function createWaterMaterial(o: WaterMaterialOptions): WaterMaterial {
  waterShared.tDetail.value ??= waterDetailTexture();
  const wa = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
  const wb = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
  waveUniforms(o.waves, wa, wb);
  const ang = ((o.windDir ?? 0) * Math.PI) / 180;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...waterShared,
      uWaveA: { value: wa },
      uWaveB: { value: wb },
      uWaveFar: { value: o.waveFar ?? 400 },
      uColor: { value: o.look.color.clone() },
      uMurk: { value: o.look.murk },
      uClarity: { value: o.look.clarity },
      uFoam: { value: o.look.foam },
      uShore: { value: o.shoreFoam ?? 0.25 + o.look.foam * 0.9 },
      uDetailScale: { value: o.detailScale ?? 6 },
      uDetailStrength: { value: o.detailStrength ?? 0.35 },
      uDrift: { value: 1 },
      uWind: { value: new THREE.Vector2(Math.cos(ang), Math.sin(ang)) },
    },
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
    fog: true,
  }) as WaterMaterial;
  if (o.edgeClip) mat.defines = { ...mat.defines, EDGE_CLIP: '' };
  mat.userData.noWeather = true;
  return mat;
}
