import * as THREE from 'three';
import { unzlibSync } from 'fflate';
import { MeshBVH } from 'three-mesh-bvh';
import type { AssetContext, AssetDef, AssetInstance, PropDef } from '../assets.ts';
import type { MapObjectData } from '../mapFormat.ts';
import { blobRef, browserBlobs, parseBlobRef } from '../blobStore.ts';
import { liveLandscapes } from '../landscape/render.ts';
import { particleWorld } from '../particleCollision.ts';
import { SOURCE_TYPE, bool, disposeTree, lookProps, num, readLook, str, waterHelper, waterMesh, type LookDefaults } from './asset.ts';
import { createWaterMaterial, type WaterMaterial } from './material.ts';
import { registerWater, unregisterWater, type WaterBody, type WaterSample } from './registry.ts';
import {
  EDGE_COUNT,
  E_CORNER,
  E_MID_B,
  E_MID_R,
  E_POS_B,
  E_POS_R,
  E_WALL_B,
  E_WALL_R,
  SIM_WET,
  decodeFields,
  decodeHeader,
  encodeState,
  fallbackEdges,
  wallHeights,
  type SimHeader,
  type SimParams,
  type SimSource,
} from './shallow.ts';
import type { SimFrame, SimRequest, SimResponse } from './shallow.worker.ts';

// Wasserquelle (watersource): echte Flachwasser-Simulation auf dem Gelände (shallow.ts, im Web Worker).
// Die Quelle speist Wasser ein; es läuft bergab, folgt Flussbetten und Senken und bildet so Bäche, Flüsse und
// Seen. Gerechnet wird in einem rechteckigen Gebiet um die Quelle; am Rand fließt das Wasser ab.
//  - Verbund: Quellen, deren Gebiete sich überlappen oder berühren, rechnen gemeinsam in EINEM Gitter (Vereinigung
//    der Gebiete, feinste Zellgröße, höchste Genauigkeit). Ihr Wasser fließt zusammen, es gibt eine Oberfläche.
//    Die führende Quelle (kleinste ID) rechnet und zeichnet; der Zustand trägt eine Verbund-Kennung und den
//    Berechnungs-Zeitpunkt, damit bei mehreren gespeicherten Zuständen der neueste passende gilt.
//  - Editor: „Simulation berechnen“ tastet den Boden ab (Landscape-Höhen, andere Objekte per Raycast) — dazu die
//    Linien zwischen den Zellmitten fein, damit dünne Wände als Sperren erkannt werden — und rechnet den Vorlauf vor;
//    der Zustand wird als Blob gespeichert (props.state).
//  - Spiel und Editor-Simulation (Alt+S): rechnet ab dem gespeicherten Zustand in Echtzeit weiter.
// Die Oberfläche ist ein Gitter (je nach Genauigkeit doppelt so fein wie die Simulation) mit dem normalen
// Wasser-Material; an Stufenkanten legt es sich über die Kante, an Wänden wird es genau an der Wand abgeschnitten.
// Spieler, Props und Spritzer fragen sie über die Wasser-Registry ab (Höhe, Strömung).

type Quality = 'low' | 'medium' | 'high' | 'ultra';

interface QualityDef {
  /** höchstens so viele Zellen (sonst wird die Zelle größer) */
  cells: number;
  /** Abtastpunkte je Zellabstand auf den Linien zwischen den Zellmitten (Wand-Erkennung, gerade) */
  wallSamples: number;
  /** bis zu so vielen Zellen wird die Oberfläche doppelt so fein gezeichnet */
  fineSurface: number;
  /** Courant-Zahl des Zeitschritts */
  cfl: number;
  rank: number;
}

const QUALITY: Record<Quality, QualityDef> = {
  low: { cells: 40_000, wallSamples: 2, fineSurface: 0, cfl: 0.5, rank: 0 },
  medium: { cells: 90_000, wallSamples: 4, fineSurface: 40_000, cfl: 0.5, rank: 1 },
  high: { cells: 180_000, wallSamples: 6, fineSurface: 90_000, cfl: 0.4, rank: 2 },
  ultra: { cells: 360_000, wallSamples: 8, fineSurface: 160_000, cfl: 0.35, rank: 3 },
};

function qualityOf(o: MapObjectData): Quality {
  const q = str(o, 'quality', 'medium');
  return q in QUALITY ? (q as Quality) : 'medium';
}

/** dünne Filme zählen als nass, solange sie fließen (Wasser auf Treppenstufen, an Hängen) */
const FILM = 0.0025;
const FILM_SPEED = 0.08;

const SOURCE_LOOK: LookDefaults = { color: '#4f8a80', murk: 0.35, clarity: 2.5, foam: 0.55, waveHeight: 0.02, waveLength: 2.5 };

const SOURCE_PROPS: PropDef[] = [
  { key: 'rate', label: 'Zufluss (m³/s)', type: 'number', default: 1.5, min: 0.01, max: 200, step: 0.1, group: 'Quelle' },
  { key: 'radius', label: 'Quellradius (m)', type: 'number', default: 1, min: 0.2, max: 30, step: 0.1, group: 'Quelle' },
  { key: 'sizeX', label: 'Breite X (m)', type: 'number', default: 60, min: 4, max: 600, step: 1, group: 'Gebiet' },
  { key: 'sizeZ', label: 'Länge Z (m)', type: 'number', default: 60, min: 4, max: 600, step: 1, group: 'Gebiet' },
  { key: 'offsetX', label: 'Versatz X (m)', type: 'number', default: 0, min: -300, max: 300, step: 0.5, group: 'Gebiet' },
  { key: 'offsetZ', label: 'Versatz Z (m)', type: 'number', default: 0, min: -300, max: 300, step: 0.5, group: 'Gebiet' },
  { key: 'cell', label: 'Zellgröße (m, kleiner = genauer)', type: 'number', default: 0.5, min: 0.1, max: 4, step: 0.05, group: 'Gebiet' },
  {
    key: 'quality',
    label: 'Genauigkeit',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'low', label: 'Niedrig (schnell, max. 40 000 Zellen)' },
      { value: 'medium', label: 'Mittel (max. 90 000 Zellen)' },
      { value: 'high', label: 'Hoch (max. 180 000 Zellen, feine Wände)' },
      { value: 'ultra', label: 'Sehr hoch (max. 360 000 Zellen, langsam)' },
    ],
    group: 'Gebiet',
  },
  { key: 'duration', label: 'Vorlauf (s)', type: 'number', default: 90, min: 5, max: 1800, step: 5, group: 'Simulation' },
  { key: 'friction', label: 'Reibung', type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, group: 'Simulation' },
  { key: 'loss', label: 'Versickerung (mm/s)', type: 'number', default: 0.2, min: 0, max: 20, step: 0.05, group: 'Simulation' },
  { key: 'live', label: 'Im Spiel weiterrechnen', type: 'bool', default: true, group: 'Simulation' },
  { key: 'bake', label: 'Simulation berechnen', type: 'action', default: '', group: 'Simulation' },
  { key: 'clear', label: 'Wasser entfernen', type: 'action', default: '', group: 'Simulation' },
  { key: 'state', label: 'Zustand', type: 'text', default: '', hidden: true },
  ...lookProps(SOURCE_LOOK),
];

interface Domain {
  nx: number;
  nz: number;
  cell: number;
  minX: number;
  minZ: number;
  key: string;
}

function makeDomain(minX: number, minZ: number, nx: number, nz: number, cell: number): Domain {
  return { nx, nz, cell, minX, minZ, key: `${nx}|${nz}|${cell.toFixed(4)}|${minX.toFixed(3)}|${minZ.toFixed(3)}` };
}

/** Rechengebiet einer Quelle: Rechteck um sie (+ Versatz), Zellgröße so, dass die Genauigkeit eingehalten wird */
function domainOf(o: MapObjectData, px: number, pz: number): Domain {
  const sx = THREE.MathUtils.clamp(num(o, 'sizeX', 60), 4, 600);
  const sz = THREE.MathUtils.clamp(num(o, 'sizeZ', 60), 4, 600);
  const cell = Math.max(THREE.MathUtils.clamp(num(o, 'cell', 0.5), 0.1, 4), Math.sqrt((sx * sz) / QUALITY[qualityOf(o)].cells));
  const nx = Math.max(4, Math.round(sx / cell));
  const nz = Math.max(4, Math.round(sz / cell));
  return makeDomain(px + num(o, 'offsetX', 0) - (nx * cell) / 2, pz + num(o, 'offsetZ', 0) - (nz * cell) / 2, nx, nz, cell);
}

/** Eigenschaften, die einen gespeicherten Zustand ungültig machen bzw. einen Neuaufbau brauchen (ohne props.state) */
function propsKey(o: MapObjectData): string {
  const p = { ...o.props };
  delete p.state;
  return JSON.stringify(p);
}

// ---------- Boden abtasten ----------

const _ray = new THREE.Ray();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();

interface GroundMesh {
  mesh: THREE.Mesh;
  bvh: MeshBVH;
  inv: THREE.Matrix4;
  nrm: THREE.Matrix3;
  box: THREE.Box3;
}

/** sichtbar, kein Editor-Helfer, kein Wasser, kein simuliertes (bewegliches) Objekt */
function solidMesh(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  const mesh = o as THREE.Mesh;
  if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || !mesh.geometry?.attributes.position) return false;
  if (!mesh.layers.isEnabled(0)) return false;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (!mats.some((m) => m && m.visible && m.side !== THREE.BackSide)) return false;
  for (let c: THREE.Object3D | null = o; c && c !== stop; c = c.parent) {
    if (!c.visible || c.userData.editorHelper || c.userData.noPick) return false;
    const node = c.userData.mapNode as { data?: MapObjectData } | undefined;
    if (node?.data?.props.simulate === true) return false;
  }
  return true;
}

interface Ground {
  ground: Float32Array;
  edges: Float32Array;
}

/** Ausgangspunkt der Abtastung: Quelle (Weltposition, Radius) */
export interface GroundSeed {
  x: number;
  y: number;
  z: number;
  r: number;
}

/** so hoch kann Wasser über einen Boden steigen bzw. eine Stufe hinauf gelangen (m) */
const CLIMB = 0.8;
/** so viel Luft muss über einer Fläche sein, damit sie als Boden darunter zählt (m) */
const CLEAR = 0.25;
const EPS = 0.002;

/**
 * Bodenhöhe je Zelle aus Landscapes (Höhenfeld, inkl. Löcher) und anderen Objekten (BVH). Pro Abtastpunkt werden
 * alle Flächen übereinander gesammelt (mit Richtung oben/unten). Als Boden zählt eine nach oben zeigende Fläche,
 * über der genug Luft ist (unter einem Türsturz, Tisch, einer Brücke, Decke …). Welche dieser Ebenen gilt, ergibt
 * sich von den Quellen aus: Wasser kommt nur dorthin, wo es von einem Nachbarn aus hinabfließen bzw. bis zu
 * CLIMB hinaufsteigen kann. Ein Türsturz über der Öffnung ist so keine Wand mehr, eine echte Wand schon.
 * Ohne Treffer: unendlicher Boden (y = 0), falls aktiv, sonst NaN (Wasser fällt in den Abgrund).
 * Dazu die Kanten-Daten: höchster Punkt auf der Linie zur rechten/unteren Nachbar-Mitte (`samples` Schritte),
 * Boden auf halbem Weg und an der Zellecke.
 */
function sampleGround(world: THREE.Object3D, skip: ReadonlySet<THREE.Object3D>, d: Domain, seeds: readonly GroundSeed[], samples: number): Ground {
  world.updateMatrixWorld(true);
  const lands = [...liveLandscapes()].filter((r) => r.mesh.visible);
  const landMeshes = new Set<THREE.Object3D>(lands.map((r) => r.mesh));
  const landInv = lands.map((r) => new THREE.Matrix4().copy(r.mesh.matrixWorld).invert());
  const maxX = d.minX + d.nx * d.cell;
  const maxZ = d.minZ + d.nz * d.cell;
  const meshes: GroundMesh[] = [];
  let srcTop = -Infinity;
  for (const s of seeds) srcTop = Math.max(srcTop, s.y);
  if (!Number.isFinite(srcTop)) srcTop = 0;
  const top = srcTop + 200;
  const visit = (o: THREE.Object3D) => {
    if (skip.has(o) || landMeshes.has(o) || !o.visible || o.userData.editorHelper) return;
    if (solidMesh(o, world)) {
      const mesh = o as THREE.Mesh;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = _box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      if (box.max.x >= d.minX && box.min.x <= maxX && box.max.z >= d.minZ && box.min.z <= maxZ && box.min.y < top) {
        meshes.push({
          mesh,
          bvh: new MeshBVH(mesh.geometry, { indirect: true }),
          inv: new THREE.Matrix4().copy(mesh.matrixWorld).invert(),
          nrm: new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
          box: box.clone(),
        });
      }
    }
    for (const c of o.children) visit(c);
  };
  for (const c of world.children) visit(c);

  // Fächer (ca. 4 m), damit jeder Abtastpunkt nur die Objekte in seiner Nähe prüft
  const bin = Math.max(4, d.cell * 8);
  const bnx = Math.max(1, Math.ceil((maxX - d.minX) / bin));
  const bnz = Math.max(1, Math.ceil((maxZ - d.minZ) / bin));
  const bins: GroundMesh[][] = Array.from({ length: bnx * bnz }, () => []);
  for (const m of meshes) {
    const x0 = THREE.MathUtils.clamp(Math.floor((m.box.min.x - d.minX) / bin), 0, bnx - 1);
    const x1 = THREE.MathUtils.clamp(Math.floor((m.box.max.x - d.minX) / bin), 0, bnx - 1);
    const z0 = THREE.MathUtils.clamp(Math.floor((m.box.min.z - d.minZ) / bin), 0, bnz - 1);
    const z1 = THREE.MathUtils.clamp(Math.floor((m.box.max.z - d.minZ) / bin), 0, bnz - 1);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) bins[z * bnx + x].push(m);
  }

  const plane = particleWorld.groundPlane;
  const hitY: number[] = [];
  const hitUp: boolean[] = [];
  const order: number[] = [];
  const _n = new THREE.Vector3();
  /** mögliche Böden an (x, z), aufsteigend; leer = Abgrund */
  const floorsAt = (x: number, z: number): number[] => {
    hitY.length = 0;
    hitUp.length = 0;
    for (let k = 0; k < lands.length; k++) {
      _v.set(x, 0, z).applyMatrix4(landInv[k]);
      const lh = lands[k].data.heightAt(_v.x, _v.z);
      if (lh === null) continue;
      _v.y = lh;
      _v.applyMatrix4(lands[k].mesh.matrixWorld);
      hitY.push(_v.y);
      hitUp.push(true);
    }
    const bx = THREE.MathUtils.clamp(Math.floor((x - d.minX) / bin), 0, bnx - 1);
    const bz = THREE.MathUtils.clamp(Math.floor((z - d.minZ) / bin), 0, bnz - 1);
    for (const m of bins[bz * bnx + bx]) {
      if (x < m.box.min.x || x > m.box.max.x || z < m.box.min.z || z > m.box.max.z) continue;
      _ray.origin.set(x, top, z);
      _ray.direction.set(0, -1, 0);
      _ray.applyMatrix4(m.inv);
      for (const hit of m.bvh.raycast(_ray, THREE.DoubleSide)) {
        const ny = hit.face ? _n.copy(hit.face.normal).applyMatrix3(m.nrm).y : 1;
        if (Math.abs(ny) < 1e-4) continue; // senkrechte Fläche
        hitY.push(_v.copy(hit.point).applyMatrix4(m.mesh.matrixWorld).y);
        hitUp.push(ny > 0);
      }
    }
    if (plane) {
      hitY.push(0);
      hitUp.push(true);
    }
    const out: number[] = [];
    const cnt = hitY.length;
    if (cnt === 0) return out;
    if (cnt === 1) {
      if (hitUp[0]) out.push(hitY[0]);
      return out;
    }
    // absteigend; bei gleicher Höhe zuerst die Unterseiten (eine Wand, die genau auf dem Boden steht, deckt ihn ab)
    order.length = 0;
    for (let k = 0; k < cnt; k++) order.push(k);
    order.sort((a, b) => hitY[b] - hitY[a] || (hitUp[a] ? 1 : 0) - (hitUp[b] ? 1 : 0));
    // von oben nach unten: oberste Fläche gilt immer; darunter nur, wenn direkt darüber eine Unterseite mit Luft liegt
    // (fehlt die Unterseite, ist das Objekt unten offen — dann lieber als massiv behandeln)
    let above = Infinity;
    let aboveDown = true;
    for (const k of order) {
      const y = hitY[k];
      if (hitUp[k]) {
        if (above - y > EPS) {
          if (aboveDown && above - y >= CLEAR) out.push(y);
          above = y;
          aboveDown = false;
        }
      } else {
        above = y;
        aboveDown = true;
      }
    }
    out.reverse();
    return out;
  };
  /** Boden für Wasser, das bis `ref` reicht: höchster Boden darunter; sonst der niedrigste darüber (Wand/Hang) */
  const pickFloor = (floors: readonly number[], ref: number): number => {
    if (floors.length === 0) return NaN;
    let best = NaN;
    for (const f of floors) if (f <= ref) best = f;
    return Number.isNaN(best) ? floors[0] : best;
  };

  const { nx, nz, cell } = d;
  const n = nx * nz;

  // 1) mögliche Böden je Zellmitte
  const cand: number[][] = new Array(n);
  let multi = false;
  for (let iz = 0; iz < nz; iz++) {
    const z = d.minZ + (iz + 0.5) * cell;
    for (let ix = 0; ix < nx; ix++) {
      const f = floorsAt(d.minX + (ix + 0.5) * cell, z);
      cand[iz * nx + ix] = f;
      if (f.length > 1) multi = true;
    }
  }

  // 2) Ebene wählen: von den Quellen aus ausbreiten, höchste Wasserstände zuerst
  const ground = new Float32Array(n).fill(NaN);
  if (!multi) {
    for (let i = 0; i < n; i++) ground[i] = cand[i].length ? cand[i][cand[i].length - 1] : NaN;
  } else {
    const done = new Uint8Array(n);
    const refOf = new Float32Array(n).fill(-Infinity);
    // Max-Heap nach Bezugshöhe
    const hRef: number[] = [];
    const hIdx: number[] = [];
    const swap = (a: number, b: number) => {
      const r = hRef[a];
      hRef[a] = hRef[b];
      hRef[b] = r;
      const i = hIdx[a];
      hIdx[a] = hIdx[b];
      hIdx[b] = i;
    };
    const push = (ref: number, i: number) => {
      let c = hRef.length;
      hRef.push(ref);
      hIdx.push(i);
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (hRef[p] >= hRef[c]) break;
        swap(p, c);
        c = p;
      }
    };
    const pop = (): number => {
      const i = hIdx[0];
      const lr = hRef.pop()!;
      const li = hIdx.pop()!;
      if (hRef.length) {
        hRef[0] = lr;
        hIdx[0] = li;
        let c = 0;
        for (;;) {
          const a = c * 2 + 1;
          let m = c;
          if (a < hRef.length && hRef[a] > hRef[m]) m = a;
          if (a + 1 < hRef.length && hRef[a + 1] > hRef[m]) m = a + 1;
          if (m === c) break;
          swap(m, c);
          c = m;
        }
      }
      return i;
    };
    const offer = (i: number, ref: number) => {
      if (done[i] || ref <= refOf[i]) return;
      refOf[i] = ref;
      push(ref, i);
    };
    for (const s of seeds) {
      const cx = (s.x - d.minX) / cell - 0.5;
      const cz = (s.z - d.minZ) / cell - 0.5;
      const rr = Math.max(0.5, s.r / cell);
      for (let iz = Math.max(0, Math.floor(cz - rr)); iz <= Math.min(nz - 1, Math.ceil(cz + rr)); iz++)
        for (let ix = Math.max(0, Math.floor(cx - rr)); ix <= Math.min(nx - 1, Math.ceil(cx + rr)); ix++)
          if ((ix - cx) ** 2 + (iz - cz) ** 2 <= rr * rr + 0.5) offer(iz * nx + ix, s.y + CLIMB);
    }
    while (hRef.length) {
      const i = pop();
      if (done[i]) continue;
      done[i] = 1;
      const ref = refOf[i];
      const f = pickFloor(cand[i], ref);
      ground[i] = f;
      // Wand/Hang zu hoch oder Abgrund: hier geht es nicht weiter
      if (!(f <= ref)) continue;
      const nr = f + CLIMB;
      const ix = i % nx;
      if (ix > 0) offer(i - 1, nr);
      if (ix < nx - 1) offer(i + 1, nr);
      if (i >= nx) offer(i - nx, nr);
      if (i + nx < n) offer(i + nx, nr);
    }
    // nicht erreichbare Zellen: Ebene unter der höchsten Quelle
    for (let i = 0; i < n; i++) if (!done[i]) ground[i] = pickFloor(cand[i], srcTop + CLIMB);
  }

  // 3) Kanten-Daten, jeweils auf der Ebene der beteiligten Zellen
  const edges = new Float32Array(n * EDGE_COUNT);
  const m = Math.max(2, samples & ~1);
  const refAt = (...g: number[]) => {
    let r = -Infinity;
    for (const v of g) if (Number.isFinite(v) && v > r) r = v;
    return (Number.isFinite(r) ? r : srcTop) + CLIMB;
  };
  const heightAt = (x: number, z: number, ref: number) => {
    const f = floorsAt(x, z);
    return multi ? pickFloor(f, ref) : f.length ? f[f.length - 1] : NaN;
  };
  /** höchster Punkt auf der Linie von (x, z) in Richtung (dx, dz), ohne die Endpunkte; mid = Punkt auf halbem Weg */
  const line = (x: number, z: number, dx: number, dz: number, ref: number): [number, number, number] => {
    let max = -Infinity;
    let pos = 0.5;
    let mid = NaN;
    for (let k = 1; k < m; k++) {
      const y = heightAt(x + (dx * k) / m, z + (dz * k) / m, ref);
      if (k * 2 === m) mid = y;
      if (y > max) {
        max = y;
        pos = k / m;
      }
    }
    return [Number.isFinite(max) ? max : NaN, pos, mid];
  };
  for (let iz = 0; iz < nz; iz++) {
    const z = d.minZ + (iz + 0.5) * cell;
    for (let ix = 0; ix < nx; ix++) {
      const x = d.minX + (ix + 0.5) * cell;
      const i = iz * nx + ix;
      const g = ground[i];
      if (ix < nx - 1) {
        const [w, p, mid] = line(x, z, cell, 0, refAt(g, ground[i + 1]));
        edges[E_WALL_R * n + i] = w;
        edges[E_POS_R * n + i] = p;
        edges[E_MID_R * n + i] = mid;
      } else {
        edges[E_WALL_R * n + i] = NaN;
        edges[E_POS_R * n + i] = 0.5;
        edges[E_MID_R * n + i] = g;
      }
      if (iz < nz - 1) {
        const [w, p, mid] = line(x, z, 0, cell, refAt(g, ground[i + nx]));
        edges[E_WALL_B * n + i] = w;
        edges[E_POS_B * n + i] = p;
        edges[E_MID_B * n + i] = mid;
      } else {
        edges[E_WALL_B * n + i] = NaN;
        edges[E_POS_B * n + i] = 0.5;
        edges[E_MID_B * n + i] = g;
      }
      edges[E_CORNER * n + i] =
        ix < nx - 1 && iz < nz - 1 ? heightAt(x + cell / 2, z + cell / 2, refAt(g, ground[i + 1], ground[i + nx], ground[i + nx + 1])) : g;
    }
  }
  return { ground, edges };
}

// ---------- Zustand (Blob) ----------

/** entpackte Zustände je Blob-Verweis (Editor: Neuaufbau/Undo ohne erneutes Laden) */
const rawCache = new Map<string, Uint8Array>();

async function loadRaw(ref: string, ctx: AssetContext): Promise<Uint8Array | null> {
  const hit = rawCache.get(ref);
  if (hit) return hit;
  const id = parseBlobRef(ref);
  if (!id || !ctx.blobs) return null;
  const bytes = await ctx.blobs.get(id);
  if (!bytes) return null;
  try {
    const raw = unzlibSync(bytes);
    if (ctx.editor) rawCache.set(ref, raw);
    return raw;
  } catch {
    return null;
  }
}

/** „Wasser entfernen“ speichert einen Vermerk mit Zeitpunkt statt eines Zustands (gilt auch für den Verbund) */
const CLEARED = 'none@';

interface SimArrays {
  ground: Float32Array;
  depth: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
  edges: Float32Array;
  /** Kanten-Daten stammen aus einer Abtastung (sonst Ersatz ohne Wände) */
  sampled: boolean;
  time: number;
}

function fits(h: SimHeader, d: Domain): boolean {
  return h.nx === d.nx && h.nz === d.nz && Math.abs(h.cell - d.cell) < 1e-4 && Math.abs(h.minX - d.minX) < 1e-3 && Math.abs(h.minZ - d.minZ) < 1e-3;
}

/** Felder aus einem Zustand lesen, falls er zum Gebiet passt */
function readArrays(raw: Uint8Array, d: Domain): SimArrays | null {
  const f = decodeFields(raw);
  if (!f || !fits(f.head, d)) return null;
  return { ground: f.ground, depth: f.depth, vx: f.vx, vz: f.vz, edges: f.edges ?? fallbackEdges(f.ground, d.nx, d.nz), sampled: !!f.edges, time: f.head.time };
}

/** Kennung eines Verbunds aus den IDs seiner Quellen (FNV-1a) */
function signature(ids: string[]): number {
  let h = 0x811c9dc5;
  for (const c of ids.join('|')) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

// ---------- Abgerundete Wasserkante ----------

let maskA = new Float32Array(0);
let maskB = new Float32Array(0);
let maskC = new Float32Array(0);

/** Box-Unschärfe mit Radius `r` (getrennt in X und Z) von `src` nach `dst`; Rand = Randwert. `dst` darf `src` sein. */
function boxBlur(src: Float32Array, dst: Float32Array, tmp: Float32Array, nx: number, nz: number, r: number): void {
  const k = 1 / (2 * r + 1);
  for (let iz = 0; iz < nz; iz++) {
    const row = iz * nx;
    for (let ix = 0; ix < nx; ix++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += src[row + Math.min(Math.max(ix + d, 0), nx - 1)];
      tmp[row + ix] = s * k;
    }
  }
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += tmp[Math.min(Math.max(iz + d, 0), nz - 1) * nx + ix];
      dst[iz * nx + ix] = s * k;
    }
  }
}

/**
 * Kanten-Maske je Zelle, der Shader schneidet bei 0.5. Grundlage ist die weichgezeichnete Nässe (3 × 3er-Box ≈
 * Gauß mit Radius 3 Zellen): gerade Ufer bleiben, wo sie sind, Ecken und Zellen-Treppen werden rund, Buchten füllen
 * sich. Damit schmale Rinnsale (1–2 Zellen) dabei nicht verschwinden, bleiben nasse Punkte mit dünner Umgebung
 * (5 × 5-Mittel < 0.45) immer sichtbar.
 */
function edgeMask(wet: Uint8Array, nx: number, nz: number, out: Float32Array): void {
  const n = nx * nz;
  if (maskA.length < n) {
    maskA = new Float32Array(n);
    maskB = new Float32Array(n);
    maskC = new Float32Array(n);
  }
  const wide = maskA;
  const thin = maskB;
  const tmp = maskC;
  for (let i = 0; i < n; i++) out[i] = wet[i];
  boxBlur(out, wide, tmp, nx, nz, 1);
  boxBlur(wide, wide, tmp, nx, nz, 1);
  boxBlur(wide, wide, tmp, nx, nz, 1);
  boxBlur(out, thin, tmp, nx, nz, 2);
  for (let i = 0; i < n; i++) {
    const w = wide[i];
    out[i] = out[i] > 0 && thin[i] < 0.45 ? Math.max(w, 0.55) : w;
  }
}

// ---------- Quellen und Verbünde ----------

interface Member {
  id: string;
  o: MapObjectData;
  ctx: AssetContext;
  object: THREE.Group;
  root: THREE.Object3D | null;
  /** eigener gespeicherter Zustand (Verweis + entpackt) */
  ref: string;
  raw: Uint8Array | null;
  group: SimGroup | null;
  disposed: boolean;
}

const members = new Set<Member>();

function worldOf(o: THREE.Object3D): THREE.Object3D {
  let w = o;
  while (w.parent) w = w.parent;
  return w;
}

function memberDomain(m: Member): Domain {
  const p = m.root!.getWorldPosition(_v);
  return domainOf(m.o, p.x, p.z);
}

/** Gebiet eines Verbunds: Vereinigung, feinste Zelle, höchste Genauigkeit */
function groupDomain(list: Member[], q: QualityDef): Domain {
  if (list.length === 1) return memberDomain(list[0]);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let cell = Infinity;
  for (const m of list) {
    const d = memberDomain(m);
    minX = Math.min(minX, d.minX);
    minZ = Math.min(minZ, d.minZ);
    maxX = Math.max(maxX, d.minX + d.nx * d.cell);
    maxZ = Math.max(maxZ, d.minZ + d.nz * d.cell);
    cell = Math.min(cell, d.cell);
  }
  cell = Math.max(cell, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / q.cells));
  const nx = Math.max(4, Math.ceil((maxX - minX) / cell - 1e-6));
  const nz = Math.max(4, Math.ceil((maxZ - minZ) / cell - 1e-6));
  return makeDomain(minX, minZ, nx, nz, cell);
}

/** Quellen neu zu Verbünden ordnen (nach Anlegen, Verschieben, Entfernen) */
function regroup(): void {
  const active = [...members].filter((m) => m.root && !m.disposed);
  const doms = new Map(active.map((m) => [m, memberDomain(m)]));
  const worlds = new Map(active.map((m) => [m, worldOf(m.root!)]));
  // Zusammenhangskomponenten über sich überlappende/berührende Gebiete
  const parent = new Map(active.map((m) => [m, m]));
  const find = (m: Member): Member => {
    let r = m;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(m, r);
    return r;
  };
  for (let a = 0; a < active.length; a++)
    for (let b = a + 1; b < active.length; b++) {
      const A = active[a];
      const B = active[b];
      if (worlds.get(A) !== worlds.get(B)) continue;
      const da = doms.get(A)!;
      const db = doms.get(B)!;
      const eps = 1e-3;
      if (da.minX <= db.minX + db.nx * db.cell + eps && db.minX <= da.minX + da.nx * da.cell + eps && da.minZ <= db.minZ + db.nz * db.cell + eps && db.minZ <= da.minZ + da.nz * da.cell + eps)
        parent.set(find(A), find(B));
    }
  const comps = new Map<Member, Member[]>();
  for (const m of active) {
    const r = find(m);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(m);
  }
  const keep = new Set<SimGroup>();
  const assign = new Map<Member, SimGroup>();
  for (const list of comps.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const key = list.map((m) => `${m.id}@${doms.get(m)!.key}#${propsKey(m.o)}`).join('|');
    const old = list[0].group;
    if (old && !old.disposed && old.key === key && old.members.length === list.length && old.members.every((m, i) => m === list[i])) {
      keep.add(old);
      for (const m of list) assign.set(m, old);
      continue;
    }
    const g = new SimGroup(list, key);
    keep.add(g);
    for (const m of list) assign.set(m, g);
  }
  const old = new Set<SimGroup>();
  for (const m of members) if (m.group) old.add(m.group);
  for (const g of old) if (!keep.has(g)) g.dispose();
  for (const m of members) m.group = assign.get(m) ?? null;
  for (const g of keep) {
    if (g.fresh) g.start();
    else g.meshDirty = true; // z. B. nur in der Höhe verschoben
  }
}

class SimGroup {
  readonly members: Member[];
  readonly leader: Member;
  readonly key: string;
  readonly sig: number;
  readonly q: QualityDef;
  readonly dom: Domain;
  readonly sub: 1 | 2;
  fresh = true;
  disposed = false;
  meshDirty = false;

  private mat: WaterMaterial;
  private body: WaterBody;
  private arrays: SimArrays | null = null;
  /** Verweis, aus dem `arrays` stammt ('' = selbst abgetastet/leer) */
  private arraysRef = '';
  private raw: Uint8Array | null = null;
  private rawRef = '';
  private walls: { r: Float32Array; b: Float32Array } | null = null;
  private mesh: THREE.Mesh | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private registered = false;

  private worker: Worker | null = null;
  private busy = false;
  private acc = 0;
  private spare: SimFrame | undefined;
  private baking: { resolve: (r: { bytes: Uint8Array; time: number; volume: number; wet: number }) => void; reject: (e: Error) => void; progress: (f: number, text?: string) => void } | null = null;

  constructor(list: Member[], key: string) {
    this.members = list;
    this.leader = list[0];
    this.key = key;
    this.sig = signature(list.map((m) => m.id));
    let q = QUALITY.low;
    for (const m of list) if (QUALITY[qualityOf(m.o)].rank > q.rank) q = QUALITY[qualityOf(m.o)];
    this.q = q;
    this.dom = groupDomain(list, q);
    this.sub = this.dom.nx * this.dom.nz <= q.fineSurface ? 2 : 1;
    const { look, waves, dir } = readLook(this.leader.o, SOURCE_LOOK);
    // Simulationswasser ist oft nur Zentimeter tief — Uferschaum nur am äußersten Rand
    this.mat = createWaterMaterial({ look, waves, waveFar: 120, detailScale: 3, detailStrength: 0.55, windDir: dir, shoreFoam: 0.03 + look.foam * 0.08, edgeClip: true });
    const d = this.dom;
    const self = this;
    this.body = {
      kind: 'sim',
      level: 0,
      box: { minX: d.minX, maxX: d.minX + d.nx * d.cell, minZ: d.minZ, maxZ: d.minZ + d.nz * d.cell },
      waves,
      look,
      sample(x, z, out: WaterSample) {
        return self.sample(x, z, out);
      },
    };
  }

  /** nach dem Zuordnen: gespeicherten Zustand übernehmen */
  start(): void {
    this.fresh = false;
    this.applyState();
  }

  private sample(x: number, z: number, out: WaterSample): boolean {
    const a = this.arrays;
    const dom = this.dom;
    if (!a) return false;
    const { ground, depth, vx, vz } = a;
    const fx = (x - dom.minX) / dom.cell - 0.5;
    const fz = (z - dom.minZ) / dom.cell - 0.5;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    let D = 0;
    let S = 0;
    let W = 0;
    let FX = 0;
    let FZ = 0;
    for (let k = 0; k < 4; k++) {
      const cx = ix + (k & 1);
      const cz = iz + (k >> 1);
      if (cx < 0 || cz < 0 || cx >= dom.nx || cz >= dom.nz) continue;
      const w = (k & 1 ? tx : 1 - tx) * (k >> 1 ? tz : 1 - tz);
      const i = cz * dom.nx + cx;
      const d = depth[i];
      D += w * d;
      FX += w * vx[i];
      FZ += w * vz[i];
      if (d > SIM_WET) {
        S += w * (ground[i] + d);
        W += w;
      }
    }
    if (D < 0.02 || W < 1e-4) return false;
    out.base = S / W;
    out.flowX = FX;
    out.flowZ = FZ;
    out.fade = Math.min(1, D / 0.6);
    return true;
  }

  private params(): SimParams {
    let f = 0;
    let l = 0;
    for (const m of this.members) {
      f += THREE.MathUtils.clamp(num(m.o, 'friction', 0.3), 0, 1);
      l += Math.max(0, num(m.o, 'loss', 0.2)) / 1000;
    }
    return { friction: f / this.members.length, loss: l / this.members.length, cfl: this.q.cfl };
  }

  private sources(): SimSource[] {
    const d = this.dom;
    const out: SimSource[] = [];
    for (const m of this.members) {
      if (!m.root) continue;
      const p = m.root.getWorldPosition(_v);
      out.push({ x: (p.x - d.minX) / d.cell, z: (p.z - d.minZ) / d.cell, r: Math.max(0.2, num(m.o, 'radius', 1)) / d.cell, rate: Math.max(0, num(m.o, 'rate', 1.5)) });
    }
    return out;
  }

  /** neuester passender Zustand aller Mitglieder (oder ein „entfernt“-Vermerk); null = keiner */
  private pick(): { ref: string; raw: Uint8Array | null; head: SimHeader | null } | null {
    let best: { ref: string; raw: Uint8Array | null; head: SimHeader | null; at: number } | null = null;
    for (const m of this.members) {
      let at: number;
      let head: SimHeader | null = null;
      if (m.ref.startsWith(CLEARED)) at = Number(m.ref.slice(CLEARED.length)) || 0;
      else {
        if (!m.raw) continue;
        head = decodeHeader(m.raw);
        if (!head || !fits(head, this.dom)) continue;
        // alter Zustand ohne Kennung: nur für eine einzelne Quelle
        if (head.sig ? head.sig !== this.sig : this.members.length > 1) continue;
        at = head.bakedAt;
      }
      if (!best || at > best.at) best = { ref: m.ref, raw: head ? m.raw : null, head, at };
    }
    return best;
  }

  /** Zustand übernehmen, wenn er zum Gebiet passt */
  applyState(): void {
    if (this.disposed || this.baking) return;
    const best = this.pick();
    const a = best?.raw ? readArrays(best.raw, this.dom) : null;
    if (a && best) {
      this.raw = best.raw;
      this.rawRef = best.ref;
      this.setArrays(a, best.ref);
      if (this.worker) this.startWorker(); // Editor-Simulation läuft: ab dem neuen Zustand weiter
      return;
    }
    this.raw = null;
    this.rawRef = '';
    // passt nicht (Quelle verschoben, Gebiet geändert), entfernt oder noch nie berechnet
    if (this.arraysRef || !this.worker) this.clearArrays();
  }

  private setArrays(a: SimArrays, ref: string): void {
    this.arrays = a;
    this.arraysRef = ref;
    this.walls = wallHeights(a.ground, a.edges, this.dom.nx, this.dom.nz);
    this.meshDirty = true;
    if (!this.registered) {
      registerWater(this.body);
      this.registered = true;
    }
  }

  private clearArrays(): void {
    this.arrays = null;
    this.arraysRef = '';
    this.walls = null;
    if (this.registered) unregisterWater(this.body);
    this.registered = false;
    if (this.mesh) this.mesh.visible = false;
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.acc = 0;
    this.spare = undefined;
  }

  private newWorker(): Worker {
    const w = new Worker(new URL('./shallow.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<SimResponse>) => {
      if (w !== this.worker || this.disposed) return;
      const m = e.data;
      switch (m.type) {
        case 'frame': {
          const a = this.arrays;
          if (a && a.depth.length === m.depth.length) {
            this.spare = { depth: a.depth, vx: a.vx, vz: a.vz };
            a.depth = m.depth;
            a.vx = m.vx;
            a.vz = m.vz;
            a.time = m.time;
            this.meshDirty = true;
            if (!this.registered) {
              registerWater(this.body);
              this.registered = true;
            }
          }
          this.busy = false;
          break;
        }
        case 'progress':
          this.baking?.progress(m.f, `${Math.round(m.time)} s gerechnet · ${m.volume.toFixed(0)} m³ Wasser`);
          break;
        case 'baked':
          this.baking?.resolve(m);
          break;
        case 'error':
          console.warn('Wasser-Simulation:', m.message);
          this.baking?.reject(new Error(m.message));
          break;
      }
    };
    w.onerror = (e) => {
      console.warn('Wasser-Simulation:', e.message);
      this.baking?.reject(new Error(e.message || 'Worker-Fehler'));
    };
    return w;
  }

  private skipSet(): Set<THREE.Object3D> {
    return new Set(this.members.map((m) => m.root).filter((r): r is THREE.Object3D => !!r));
  }

  /** Quellen als Ausgangspunkte der Boden-Abtastung */
  private seeds(): GroundSeed[] {
    const out: GroundSeed[] = [];
    for (const m of this.members) {
      if (!m.root) continue;
      const p = m.root.getWorldPosition(_v);
      out.push({ x: p.x, y: p.y, z: p.z, r: Math.max(0.2, num(m.o, 'radius', 1)) });
    }
    return out;
  }

  /** Worker mit dem aktuellen Zustand (oder frisch abgetastetem, trockenem Boden) starten */
  private startWorker(): void {
    const root = this.leader.root;
    if (!root) return;
    this.stopWorker();
    this.worker = this.newWorker();
    const d = this.dom;
    const n = d.nx * d.nz;
    if (!this.arrays) {
      const g = sampleGround(root.parent ?? root, this.skipSet(), d, this.seeds(), this.q.wallSamples);
      this.setArrays({ ground: g.ground, depth: new Float32Array(n), vx: new Float32Array(n), vz: new Float32Array(n), edges: g.edges, sampled: true, time: 0 }, '');
    }
    const a = this.arrays!;
    // gespeicherter Zustand enthält auch die Abflüsse → nahtlos weiter; sonst ab Tiefe/Geschwindigkeit
    const state =
      this.raw && this.arraysRef && this.arraysRef === this.rawRef
        ? this.raw.slice()
        : encodeState({ ...d, time: a.time, sig: this.sig, bakedAt: 0 }, a.ground, a.depth, a.vx, a.vz, undefined, a.sampled ? a.edges : null);
    const msg: SimRequest = { type: 'init', nx: d.nx, nz: d.nz, cell: d.cell, minX: d.minX, minZ: d.minZ, state, sources: this.sources(), params: this.params(), sig: this.sig };
    this.worker.postMessage(msg, [state.buffer]);
    this.busy = true; // init antwortet mit einem Frame
  }

  /** pro Frame (von der führenden Quelle) */
  update(dt: number, live: boolean, editor: boolean): void {
    if (this.disposed) return;
    const run = live && bool(this.leader.o, 'live', true) && !this.baking;
    if (run) {
      if (!this.worker) this.startWorker();
      this.acc += dt;
      if (this.worker && !this.busy) {
        const msg: SimRequest = { type: 'step', dt: this.acc, reuse: this.spare };
        if (this.spare) this.worker.postMessage(msg, [this.spare.depth.buffer, this.spare.vx.buffer, this.spare.vz.buffer]);
        else this.worker.postMessage(msg);
        this.spare = undefined;
        this.busy = true;
        this.acc = 0;
      }
    } else if (this.worker && !this.baking && editor) {
      // Editor-Simulation beendet: zurück zum gespeicherten Zustand
      this.stopWorker();
      if (this.arraysRef !== this.rawRef || !this.raw) this.clearArrays();
      this.applyState();
    }
    if (this.meshDirty) this.rebuildMesh();
  }

  clear(): void {
    this.stopWorker();
    this.clearArrays();
  }

  async bake(progress: (f: number, text?: string) => void, by: Member): Promise<string> {
    const root = this.leader.root;
    if (!root) throw new Error('Quelle ist noch nicht bereit');
    if (this.baking) throw new Error('Simulation läuft bereits');
    const d = this.dom;
    const n = d.nx * d.nz;
    const many = this.members.length > 1 ? ` (Verbund aus ${this.members.length} Quellen)` : '';
    progress(0, `Boden und Wände werden abgetastet${many} …`);
    await new Promise((r) => setTimeout(r, 30));
    if (this.disposed) throw new Error('Objekt wurde neu aufgebaut');
    const g = sampleGround(root.parent ?? root, this.skipSet(), d, this.seeds(), this.q.wallSamples);
    let dry = 0;
    for (let i = 0; i < n; i++) if (!Number.isFinite(g.ground[i])) dry++;
    const walls = wallHeights(g.ground, g.edges, d.nx, d.nz);
    let wallCount = 0;
    for (let i = 0; i < n; i++) if (walls.r[i] > -Infinity || walls.b[i] > -Infinity) wallCount++;
    this.stopWorker();
    this.setArrays({ ground: g.ground, depth: new Float32Array(n), vx: new Float32Array(n), vz: new Float32Array(n), edges: g.edges, sampled: true, time: 0 }, '');
    const w = (this.worker = this.newWorker());
    const seconds = THREE.MathUtils.clamp(num(by.o, 'duration', 90), 1, 3600);
    const t0 = performance.now();
    try {
      const result = await new Promise<{ bytes: Uint8Array; time: number; volume: number; wet: number }>((resolve, reject) => {
        this.baking = { resolve, reject, progress };
        const init: SimRequest = {
          type: 'init',
          nx: d.nx,
          nz: d.nz,
          cell: d.cell,
          minX: d.minX,
          minZ: d.minZ,
          ground: g.ground.slice(),
          edges: g.edges.slice(),
          sources: this.sources(),
          params: this.params(),
          sig: this.sig,
        };
        w.postMessage(init, [init.ground!.buffer, init.edges!.buffer]);
        w.postMessage({ type: 'bake', seconds, reset: true } satisfies SimRequest);
      });
      const r = unzlibSync(result.bytes);
      const id = await browserBlobs.put(result.bytes);
      const ref = blobRef(id);
      rawCache.set(ref, r);
      by.ref = ref;
      by.raw = r;
      this.raw = r;
      this.rawRef = ref;
      const a = readArrays(r, d);
      if (a) this.setArrays(a, ref);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      progress(
        1,
        `${Math.round(result.time)} s in ${secs} s gerechnet${many} · ${result.volume.toFixed(0)} m³ Wasser · ${((result.wet / n) * 100).toFixed(0)} % des Gebiets nass` +
          `${wallCount ? ` · ${wallCount} Wand-Kanten` : ''}${dry ? ` · ${dry} Zellen ohne Boden` : ''}`,
      );
      return ref;
    } finally {
      this.baking = null;
      if (this.worker === w) this.stopWorker();
    }
  }

  /** Status-Zeile für das Wasser-Panel */
  note(): string {
    const many = this.members.length > 1 ? `Verbund aus ${this.members.length} Quellen (gemeinsame Simulation). ` : '';
    const best = this.pick();
    const d = this.dom;
    const grid = `Gitter ${d.nx} × ${d.nz} (${d.cell.toFixed(2)} m)`;
    if (!best) {
      const any = this.members.some((m) => m.ref && !m.ref.startsWith(CLEARED));
      if (any) return `${many}Veraltet: Quelle, Gebiet oder Verbund wurde geändert — „Simulation berechnen“ erneut ausführen (${grid}).`;
      return `${many}Noch nicht berechnet: „Simulation berechnen“ lässt das Wasser von der Quelle aus über das Gelände laufen (${grid}).`;
    }
    if (!best.head) return `${many}Wasser entfernt — „Simulation berechnen“ füllt es neu (${grid}).`;
    const old = best.head.version < 2 ? ' · ohne Wand-Erkennung (älterer Zustand, neu berechnen)' : '';
    return `${many}Berechnet: ${Math.round(best.head.time)} s · ${grid}${old}. Nach Verschieben oder Gebiets-Änderung neu berechnen.`;
  }

  // ---------- Oberfläche ----------

  private ensureMesh(): void {
    const d = this.dom;
    const s = this.sub;
    const fw = s * (d.nx - 1) + 1;
    const fh = s * (d.nz - 1) + 1;
    const key = `${d.key}|${s}`;
    if (this.geo && this.geo.userData.key === key) return;
    if (this.mesh) {
      this.mesh.parent?.remove(this.mesh);
      this.geo?.dispose();
    }
    const n = fw * fh;
    const geo = new THREE.BufferGeometry();
    geo.userData.key = key;
    const nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('aFlow', new THREE.BufferAttribute(new Float32Array(n * 2), 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array((fw - 1) * (fh - 1) * 6), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere();
    this.geo = geo;
    this.mesh = waterMesh(geo, this.mat, 0);
    this.mesh.name = this.members.length > 1 ? 'Wasser (simuliert, Verbund)' : 'Wasser (simuliert)';
    this.leader.object.add(this.mesh);
  }

  private rebuildMesh(): void {
    this.meshDirty = false;
    const root = this.leader.root;
    const a = this.arrays;
    const walls = this.walls;
    if (!root || !a || !walls) return;
    this.ensureMesh();
    const g = this.geo!;
    const { nx, nz, cell, minX, minZ } = this.dom;
    const n = nx * nz;
    const s = this.sub;
    const fw = s * (nx - 1) + 1;
    const fh = s * (nz - 1) + 1;
    const rp = root.getWorldPosition(new THREE.Vector3());
    const { ground: G, depth: D, vx, vz, edges: E } = a;
    const wr = walls.r;
    const wb = walls.b;

    // 1) nass je Zelle — dünne, fließende Filme zählen mit (Wasser über Stufen und Kanten)
    const wet = new Uint8Array(n);
    for (let i = 0; i < n; i++) wet[i] = D[i] > SIM_WET || (D[i] > FILM && Math.abs(vx[i]) + Math.abs(vz[i]) > FILM_SPEED) ? 1 : 0;
    const em = new Float32Array(n);
    edgeMask(wet, nx, nz, em);

    // 2) Wände: trockene Zelle hinter einer Wand → Kante genau an der Wand (statt auf halbem Weg) abschneiden
    const midR = new Float32Array(s === 2 ? n : 0).fill(NaN);
    const midB = new Float32Array(s === 2 ? n : 0).fill(NaN);
    const blocked = new Uint8Array(n);
    const clip = (di: number, t: number, mids: Float32Array, mi: number) => {
      t = THREE.MathUtils.clamp(t, 0.08, 0.95);
      blocked[di] = 1;
      if (s === 1) {
        em[di] = Math.min(em[di], 1 - 0.5 / t);
        return;
      }
      if (t < 0.5) {
        mids[mi] = 1 - 0.25 / t;
        em[di] = Math.min(em[di], -1);
      } else {
        mids[mi] = 0.75;
        em[di] = Math.min(em[di], 0.75 - 0.125 / Math.max(t - 0.5, 0.02));
      }
    };
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (ix < nx - 1 && wr[i] > -Infinity && wet[i] !== wet[i + 1]) {
          const p = E[E_POS_R * n + i];
          if (wet[i]) clip(i + 1, p, midR, i);
          else clip(i, 1 - p, midR, i);
        }
        if (iz < nz - 1 && wb[i] > -Infinity && wet[i] !== wet[i + nx]) {
          const p = E[E_POS_B * n + i];
          if (wet[i]) clip(i + nx, p, midB, i);
          else clip(i, 1 - p, midB, i);
        }
      }

    // 3) Höhe je Zelle
    const Hc = new Float32Array(n);
    let y0 = Infinity;
    let y1 = -Infinity;
    let sumY = 0;
    let wetN = 0;
    for (let iz = 0; iz < nz; iz++)
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        const b = G[i];
        if (wet[i]) {
          const y = b + D[i];
          Hc[i] = y;
          sumY += y;
          wetN++;
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          continue;
        }
        // trockene Randzelle: auf Höhe der nassen Nachbarn, aber unter dem Boden → Wasserkante schneidet das Gelände
        let sH = 0;
        let c = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const x2 = ix + dx;
            const z2 = iz + dz;
            if ((dx || dz) && x2 >= 0 && z2 >= 0 && x2 < nx && z2 < nz) {
              const j = z2 * nx + x2;
              if (wet[j]) {
                sH += G[j] + D[j];
                c++;
              }
            }
          }
        // hinter einer Wand waagrecht bleiben (sonst liefe die Fläche schräg durch die Wand zum Boden dahinter)
        if (c) Hc[i] = Number.isFinite(b) && !blocked[i] ? Math.min(sH / c, b + 0.01) : sH / c;
        else Hc[i] = Number.isFinite(b) ? b - 0.1 : rp.y;
      }

    // 4) Vertices (bei s = 2 zusätzlich auf halbem Weg und an den Zellecken)
    const pos = g.attributes.position.array as Float32Array;
    const flow = g.attributes.aFlow.array as Float32Array;
    const fade = g.attributes.aFade.array as Float32Array;
    const edge = g.attributes.aEdge.array as Float32Array;
    const vWet = new Uint8Array(fw * fh);
    const adj = [0, 0, 0, 0];
    for (let fz = 0; fz < fh; fz++) {
      const iz = Math.min(Math.floor(fz / s), nz - 1);
      const rz = fz - iz * s;
      for (let fx = 0; fx < fw; fx++) {
        const ix = Math.min(Math.floor(fx / s), nx - 1);
        const rx = fx - ix * s;
        const v = fz * fw + fx;
        const a0 = iz * nx + ix;
        let y: number;
        let e: number;
        let fX = 0;
        let fZ = 0;
        let dAvg: number;
        if (!rx && !rz) {
          y = Hc[a0];
          e = em[a0];
          if (wet[a0]) {
            fX = vx[a0];
            fZ = vz[a0];
            vWet[v] = 1;
          }
          dAvg = D[a0];
        } else {
          let k = 0;
          adj[k++] = a0;
          if (rx) adj[k++] = a0 + 1;
          if (rz) adj[k++] = a0 + nx;
          if (rx && rz) adj[k++] = a0 + nx + 1;
          let wc = 0;
          let sH = 0;
          let sD = 0;
          let gMax = -Infinity;
          let sE = 0;
          let sHc = 0;
          for (let j = 0; j < k; j++) {
            const c = adj[j];
            sE += em[c];
            sHc += Hc[c];
            if (wet[c]) {
              wc++;
              sH += Hc[c];
              sD += D[c];
              fX += vx[c];
              fZ += vz[c];
              if (G[c] > gMax) gMax = G[c];
            }
          }
          dAvg = sD / k;
          // Mitte zwischen zwei Zellen über eine Wand: Schnitt-Wert aus Schritt 2
          const mid = rx && !rz ? midR[a0] : !rx && rz ? midB[a0] : NaN;
          e = Number.isFinite(mid) ? mid : sE / k;
          if (wc) {
            y = sH / wc;
            fX /= wc;
            fZ /= wc;
            vWet[v] = 1;
            // über Stufenkanten legen: Boden an diesem Punkt + Film (nicht auf Wänden, nicht höher als die Nachbarböden)
            const onWall = rx && !rz ? wr[a0] > -Infinity : !rx && rz ? wb[a0] > -Infinity : wr[a0] > -Infinity || wr[a0 + nx] > -Infinity || wb[a0] > -Infinity || wb[a0 + 1] > -Infinity;
            const gF = rx && rz ? E[E_CORNER * n + a0] : rx ? E[E_MID_R * n + a0] : E[E_MID_B * n + a0];
            if (!onWall && Number.isFinite(gF)) y = Math.max(y, Math.min(gF, gMax) + THREE.MathUtils.clamp(sD / wc, 0.01, 0.05));
          } else y = sHc / k;
        }
        pos[v * 3] = minX + (fx / s + 0.5) * cell - rp.x;
        pos[v * 3 + 1] = y - rp.y;
        pos[v * 3 + 2] = minZ + (fz / s + 0.5) * cell - rp.z;
        flow[v * 2] = fX;
        flow[v * 2 + 1] = fZ;
        fade[v] = THREE.MathUtils.smoothstep(dAvg, 0, 0.4);
        edge[v] = e;
      }
    }

    // 5) Vierecke mit mindestens einer nassen Ecke
    const idx = g.index!.array as Uint32Array;
    let k = 0;
    for (let fz = 0; fz < fh - 1; fz++) {
      for (let fx = 0; fx < fw - 1; fx++) {
        const p = fz * fw + fx;
        const q = p + 1;
        const c = p + fw;
        const e = c + 1;
        if (!vWet[p] && !vWet[q] && !vWet[c] && !vWet[e]) continue;
        idx[k++] = p;
        idx[k++] = c;
        idx[k++] = q;
        idx[k++] = q;
        idx[k++] = c;
        idx[k++] = e;
      }
    }
    g.setDrawRange(0, k);
    g.attributes.position.needsUpdate = true;
    g.attributes.aFlow.needsUpdate = true;
    g.attributes.aFade.needsUpdate = true;
    g.attributes.aEdge.needsUpdate = true;
    g.index!.needsUpdate = true;
    if (wetN) {
      this.body.level = sumY / wetN;
      const cx = minX + (nx * cell) / 2 - rp.x;
      const cz = minZ + (nz * cell) / 2 - rp.z;
      g.boundingSphere!.center.set(cx, (y0 + y1) / 2 - rp.y, cz);
      g.boundingSphere!.radius = Math.hypot(nx * cell, nz * cell, y1 - y0) / 2 + this.body.waves.maxAmp * 2 + 0.5;
    }
    this.mesh!.visible = k > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopWorker();
    this.baking?.reject(new Error('Objekt wurde neu aufgebaut'));
    if (this.registered) unregisterWater(this.body);
    this.registered = false;
    if (this.mesh) this.mesh.parent?.remove(this.mesh);
    this.geo?.dispose();
    this.mat.dispose();
  }
}

// ---------- Asset ----------

function createSource(data: MapObjectData, ctx: AssetContext): AssetInstance {
  const object = new THREE.Group();
  const key = propsKey(data);
  const m: Member = { id: data.id, o: data, ctx, object, root: null, ref: '', raw: null, group: null, disposed: false };
  members.add(m);

  // Zustand laden (Spiel wartet über `ready` darauf)
  const loadState = async (ref: string) => {
    const r = ref && !ref.startsWith(CLEARED) ? await loadRaw(ref, ctx) : null;
    if (m.disposed) return;
    m.ref = ref;
    m.raw = r;
    m.group?.applyState();
  };
  const ready = loadState(str(data, 'state', ''));

  // ---------- Editor-Helfer: Gebiet + Quelle ----------

  let helper: THREE.Object3D | undefined;
  if (ctx.editor) {
    const d0 = domainOf(data, 0, 0);
    const x0 = d0.minX;
    const z0 = d0.minZ;
    const x1 = x0 + d0.nx * d0.cell;
    const z1 = z0 + d0.nz * d0.cell;
    const rect = [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1)];
    const r = Math.max(0.2, num(data, 'radius', 1));
    helper = waterHelper(rect, [new THREE.Vector3()], new THREE.CircleGeometry(Math.max(0.8, r), 24).rotateX(-Math.PI / 2), true);
    // Quellring + senkrechter Strich
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i <= 32; i++) ring.push(new THREE.Vector3(Math.cos((i / 32) * Math.PI * 2) * r, 0.08, Math.sin((i / 32) * Math.PI * 2) * r));
    const lm = new THREE.LineBasicMaterial({ color: '#9be7ff', transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
    const ringL = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), lm);
    const stick = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1.6, 0)]), lm);
    for (const l of [ringL, stick]) {
      l.renderOrder = 5;
      l.userData.editorHelper = true;
      helper.add(l);
    }
  }

  return {
    object,
    helper,
    ready: ready.catch(() => undefined),
    onTransform(r) {
      m.root = r;
      regroup();
    },
    update(dt, _t, live) {
      const g = m.group;
      if (!g || m.disposed || g.leader !== m) return;
      g.update(dt, live, ctx.editor);
    },
    updateProps(next) {
      if (propsKey(next) !== key) return false;
      m.o = next;
      const ref = str(next, 'state', '');
      if (ref !== m.ref) void loadState(ref);
      return true;
    },
    async action(name, progress) {
      const g = m.group;
      if (name === 'clear') {
        g?.clear();
        const ref = `${CLEARED}${Date.now()}`;
        m.ref = ref;
        m.raw = null;
        return { state: ref };
      }
      if (name !== 'bake' || !g) return;
      return { state: await g.bake(progress, m) };
    },
    dispose() {
      m.disposed = true;
      members.delete(m);
      const g = m.group;
      m.group = null;
      g?.dispose();
      regroup();
      disposeTree(object);
      disposeTree(helper);
    },
  };
}

export const SOURCE_ASSETS: Record<string, AssetDef> = {
  [SOURCE_TYPE]: { label: 'Wasserquelle', category: 'Wasser', fixedRotation: true, fixedScale: true, props: SOURCE_PROPS, create: createSource },
};

/** Status-Zeile für das Wasser-Panel: gespeicherter Zustand (Zeit, Verbund) oder Hinweis */
export function sourceStateNote(o: MapObjectData): string {
  for (const m of members) if (m.id === o.id && m.group) return m.group.note();
  if (!str(o, 'state', '')) return 'Noch nicht berechnet: „Simulation berechnen“ lässt das Wasser von der Quelle aus über das Gelände laufen.';
  return 'Berechneter Zustand gespeichert.';
}
