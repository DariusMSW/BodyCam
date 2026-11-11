import * as THREE from 'three';
import { heightAt, type WaveSet } from './waves.ts';

// Alle Wasserflächen der geladenen Map (See, Fluss, Meer) melden sich hier an. Spieler, schwimmende Objekte,
// Spritzer und Unterwasser-Effekt fragen über waterAt() Höhe (inkl. Wellen) und Strömung ab — CPU und Shader
// rechnen dieselben Gerstner-Wellen. Außerdem sammelt das Modul Ereignisse (Wellenringe, Spritzer), die
// Ripple-Simulation und Partikel im nächsten Frame abholen.

export type WaterKind = 'lake' | 'river' | 'ocean' | 'sim';

export interface WaterLook {
  /** Wasserfarbe (Streuung/Absorption) */
  color: THREE.Color;
  /** Trübung 0..1 */
  murk: number;
  /** Sichttiefe in m */
  clarity: number;
  /** Schaum 0..1 */
  foam: number;
}

export interface WaterSample {
  /** Oberfläche inkl. Wellen */
  height: number;
  /** Ruhehöhe ohne Wellen */
  base: number;
  /** Strömung in m/s (Welt-XZ) */
  flowX: number;
  flowZ: number;
  /** Wellen-Dämpfung an dieser Stelle (Ufer) 0..1 */
  fade: number;
  body: WaterBody | null;
}

export interface WaterBody {
  kind: WaterKind;
  /** typische Höhe (Spiegel-Ebene) */
  level: number;
  /** Hülle in Welt-XZ (Meer: unendlich) */
  box: { minX: number; maxX: number; minZ: number; maxZ: number };
  waves: WaveSet;
  look: WaterLook;
  /** Ruhehöhe und Strömung an (x, z); false = außerhalb */
  sample(x: number, z: number, out: WaterSample): boolean;
  /** pro Frame vor dem Rendern (Meer folgt der Kamera) */
  beforeRender?(cam: THREE.Vector3): void;
}

const bodies = new Set<WaterBody>();
/** gemeinsame Wasser-Zeit (Uniform aller Wasser-Materialien) */
export const WATER_TIME = { value: 0 };

export function registerWater(b: WaterBody): void {
  bodies.add(b);
}

export function unregisterWater(b: WaterBody): void {
  bodies.delete(b);
}

export function waterBodies(): ReadonlySet<WaterBody> {
  return bodies;
}

export function hasWater(): boolean {
  return bodies.size > 0;
}

/** Wasser-Zeit weiterzählen (einmal pro Frame, vor allen Abfragen) */
export function advanceWater(dt: number): void {
  WATER_TIME.value += dt;
}

const _s: WaterSample = { height: 0, base: 0, flowX: 0, flowZ: 0, fade: 1, body: null };

/**
 * Wasser an einem Welt-Punkt (höchste Fläche, falls sich mehrere überlappen), sonst null.
 * Das Ergebnis-Objekt wird wiederverwendet, wenn kein `out` übergeben wird.
 */
export function waterAt(x: number, z: number, out?: WaterSample): WaterSample | null {
  let best: WaterSample | null = null;
  const r = out ?? { height: 0, base: 0, flowX: 0, flowZ: 0, fade: 1, body: null };
  for (const b of bodies) {
    const bx = b.box;
    if (x < bx.minX || x > bx.maxX || z < bx.minZ || z > bx.maxZ) continue;
    _s.fade = 1;
    if (!b.sample(x, z, _s)) continue;
    const h = _s.base + heightAt(b.waves, x, z, WATER_TIME.value, _s.fade);
    if (best && h <= best.height) continue;
    r.height = h;
    r.base = _s.base;
    r.flowX = _s.flowX;
    r.flowZ = _s.flowZ;
    r.fade = _s.fade;
    r.body = b;
    best = r;
  }
  return best;
}

// ---------- Ereignisse: Wellenringe und Spritzer ----------

export interface WaterImpulse {
  x: number;
  z: number;
  /** Radius in m */
  radius: number;
  /** Stärke (m Auslenkung, negativ = eindrücken) */
  strength: number;
}

export interface WaterSplash {
  pos: THREE.Vector3;
  /** 0..~3: Tropfenmenge und Höhe */
  strength: number;
  /** optionale Richtung (Kugel-Einschlag, Wurf) */
  vel?: THREE.Vector3;
}

const impulses: WaterImpulse[] = [];
const splashes: WaterSplash[] = [];
const MAX_EVENTS = 64;

/** Wellenring an einer Stelle anstoßen (Schritte, Kugeln, Objekte, Scripts) */
export function waterImpulse(x: number, z: number, radius: number, strength: number): void {
  if (!bodies.size) return;
  if (impulses.length >= MAX_EVENTS) impulses.shift();
  impulses.push({ x, z, radius, strength });
}

/** Spritzer (Partikel) an einem Punkt auf der Wasseroberfläche */
export function waterSplash(pos: THREE.Vector3, strength: number, vel?: THREE.Vector3): void {
  if (!bodies.size) return;
  if (splashes.length >= MAX_EVENTS) splashes.shift();
  splashes.push({ pos: pos.clone(), strength, vel: vel?.clone() });
}

/** Bewegliches Hindernis im Wasser (Spieler, treibende Objekte) — gilt nur für den aktuellen Frame */
export interface WaterObstacle {
  x: number;
  z: number;
  /** Radius in m (innen: feste Wand für die Wellenringe) */
  radius: number;
  /** Strömung relativ zum Hindernis (Wasser − Hindernis) in m/s */
  flowX: number;
  flowZ: number;
  /** Stärke der Wellen an der Anströmseite/im Kielwasser (0..1) */
  strength: number;
}

export const MAX_OBSTACLES = 8;
const obstacles: WaterObstacle[] = [];

/** Hindernis für diesen Frame melden: Wellen werden daran reflektiert, Anströmung erzeugt Bugwelle und Wirbel */
export function waterObstacle(x: number, z: number, radius: number, flowX: number, flowZ: number, strength = 1): void {
  if (!bodies.size || obstacles.length >= MAX_OBSTACLES) return;
  obstacles.push({ x, z, radius, flowX, flowZ, strength });
}

/** Hindernisse abholen (leert die Liste) */
export function takeObstacles(): WaterObstacle[] {
  return obstacles.splice(0, obstacles.length);
}

/** Ereignisse abholen (leert die Liste) */
export function takeImpulses(): WaterImpulse[] {
  return impulses.splice(0, impulses.length);
}

export function takeSplashes(): WaterSplash[] {
  return splashes.splice(0, splashes.length);
}

/**
 * Schnittpunkt eines Strahls mit der Wasseroberfläche bis zur Distanz `far` (Kugeln, Blick).
 * Grob in Schritten abgetastet, dann halbiert; null, wenn der Strahl kein Wasser trifft.
 */
export function rayWater(origin: THREE.Vector3, dir: THREE.Vector3, far: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  if (!bodies.size) return null;
  const step = Math.max(0.5, far / 160);
  let prevT = 0;
  let prevAbove = true;
  const w0 = waterAt(origin.x, origin.z);
  if (w0 && origin.y < w0.height) return null; // Start unter Wasser
  for (let t = step; t <= far + 1e-6; t += step) {
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    const w = waterAt(x, z);
    const above = !w || y > w.height;
    if (!above && prevAbove) {
      let a = prevT;
      let b = t;
      for (let i = 0; i < 10; i++) {
        const m = (a + b) / 2;
        const wm = waterAt(origin.x + dir.x * m, origin.z + dir.z * m);
        if (wm && origin.y + dir.y * m <= wm.height) b = m;
        else a = m;
      }
      return out.copy(origin).addScaledVector(dir, b);
    }
    prevAbove = above;
    prevT = t;
  }
  return null;
}

// ---------- Form-Helfer ----------

/** Punkt in Polygon (XZ, Welt) — Strahl-Test */
export function insidePolygon(xs: Float64Array, zs: Float64Array, x: number, z: number): boolean {
  let inside = false;
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const zi = zs[i];
    const zj = zs[j];
    if (zi > z !== zj > z && x < ((xs[j] - xs[i]) * (z - zi)) / (zj - zi) + xs[i]) inside = !inside;
  }
  return inside;
}
