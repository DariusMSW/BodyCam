// Flachwasser-Simulation (Wasserquelle): „Virtual Pipes“ nach Mei, Decaudin & Hu (2007).
// Ein Höhenfeld-Gitter: je Zelle Bodenhöhe b, Wassertiefe d und vier Abflüsse (links/rechts/oben/unten) in m³/s.
// Je Schritt: Quellen füllen Wasser ein → Abflüsse beschleunigen mit dem Gefälle der Wasseroberfläche (b + d)
// → Tiefe ändert sich um Zu- minus Abfluss → Geschwindigkeit aus dem mittleren Durchfluss. Das Wasser läuft so
// bergab, sammelt sich in Senken (Seen) und läuft über, Flussbetten leiten es weiter. Am Gebietsrand und in
// Zellen ohne Boden (Abgrund) fließt es ab. Reibung bremst flaches Wasser stärker, Versickerung lässt dünne
// Filme verschwinden. Reines TypeScript ohne three.js — läuft im Web Worker.
// Wände zwischen Zellen: beim Abtasten wird die Verbindungslinie zweier Zellmitten fein abgetastet (Kanten-Daten).
// Ragt dort etwas über beide Böden hinaus (Mauer, Bordstein, Geländer), ist das eine Sperre: Wasser fließt nur
// über ihre Oberkante — auch wenn die Wand dünner als eine Zelle ist und keine Zellmitte trifft.

export const SIM_G = 9.81;
/** Ab dieser Tiefe gilt eine Zelle als nass (Darstellung, Abfragen) */
export const SIM_WET = 0.008;
const MAX_SPEED = 9;

export interface SimSource {
  /** Mitte in Zell-Koordinaten (Zellmitte = Index + 0.5) */
  x: number;
  z: number;
  /** Radius in Zellen */
  r: number;
  /** Zufluss in m³/s */
  rate: number;
}

export interface SimParams {
  /** Reibung 0..1 (Bodenrauheit) */
  friction: number;
  /** Versickerung/Verdunstung in m/s */
  loss: number;
  /** Courant-Zahl des Zeitschritts (kleiner = genauer, langsamer); Standard 0.5 */
  cfl?: number;
}

// ---------- Kanten-Daten (je Zelle, planar: EDGE_COUNT Blöcke à n Werte) ----------

/** höchster Boden auf der Linie zur rechten (+X) bzw. unteren (+Z) Nachbar-Mitte (ohne die Mitten selbst) */
export const E_WALL_R = 0;
export const E_WALL_B = 1;
/** Lage dieses Maximums (0..1 von der eigenen Mitte aus) */
export const E_POS_R = 2;
export const E_POS_B = 3;
/** Boden genau auf halbem Weg zur rechten/unteren Mitte und an der Ecke (+X +Z) — für die feinere Oberfläche */
export const E_MID_R = 4;
export const E_MID_B = 5;
export const E_CORNER = 6;
export const EDGE_COUNT = 7;
/** so viel muss eine Kante über beiden Böden liegen, um als Wand zu zählen (m) */
export const WALL_MIN = 0.02;

/** Kanten-Daten ohne Abtastung (alter Zustand): keine Wände, Zwischenpunkte = Mittel der Nachbarn */
export function fallbackEdges(ground: Float32Array, nx: number, nz: number): Float32Array {
  const n = nx * nz;
  const e = new Float32Array(n * EDGE_COUNT);
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const g = ground[i];
      const r = ix < nx - 1 ? ground[i + 1] : g;
      const b = iz < nz - 1 ? ground[i + nx] : g;
      const c = ix < nx - 1 && iz < nz - 1 ? ground[i + nx + 1] : g;
      e[E_WALL_R * n + i] = NaN;
      e[E_WALL_B * n + i] = NaN;
      e[E_POS_R * n + i] = 0.5;
      e[E_POS_B * n + i] = 0.5;
      e[E_MID_R * n + i] = (g + r) / 2;
      e[E_MID_B * n + i] = (g + b) / 2;
      e[E_CORNER * n + i] = (g + r + b + c) / 4;
    }
  return e;
}

/** Sperrhöhe je Zelle nach rechts/unten (-Infinity = keine Wand) */
export function wallHeights(ground: Float32Array, edges: Float32Array | null, nx: number, nz: number): { r: Float32Array; b: Float32Array } {
  const n = nx * nz;
  const r = new Float32Array(n).fill(-Infinity);
  const b = new Float32Array(n).fill(-Infinity);
  if (!edges) return { r, b };
  const top = (a: number, c: number) => (Number.isFinite(a) ? (Number.isFinite(c) ? Math.max(a, c) : a) : c);
  for (let iz = 0; iz < nz; iz++)
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      if (ix < nx - 1) {
        const w = edges[E_WALL_R * n + i];
        const g = top(ground[i], ground[i + 1]);
        if (Number.isFinite(w) && (!Number.isFinite(g) || w > g + WALL_MIN)) r[i] = w;
      }
      if (iz < nz - 1) {
        const w = edges[E_WALL_B * n + i];
        const g = top(ground[i], ground[i + nx]);
        if (Number.isFinite(w) && (!Number.isFinite(g) || w > g + WALL_MIN)) b[i] = w;
      }
    }
  return { r, b };
}

export class ShallowWater {
  readonly n: number;
  readonly depth: Float32Array;
  readonly fl: Float32Array;
  readonly fr: Float32Array;
  readonly ft: Float32Array;
  readonly fb: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
  /** 1 = kein Boden (Wasser verschwindet) */
  readonly drain: Uint8Array;
  time = 0;
  params: SimParams = { friction: 0.3, loss: 0.0002 };
  /** Kanten-Daten (siehe E_*), null = keine Wände bekannt */
  readonly edges: Float32Array | null;
  /** Sperrhöhe zur rechten/unteren Nachbarzelle */
  private wallR: Float32Array;
  private wallB: Float32Array;
  private srcCells: Int32Array = new Int32Array(0);
  private srcShare: Float32Array = new Float32Array(0);

  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  /** Bodenhöhe je Zelle (NaN = kein Boden) */
  readonly ground: Float32Array;

  constructor(nx: number, nz: number, cell: number, ground: Float32Array, edges: Float32Array | null = null) {
    this.nx = nx;
    this.nz = nz;
    this.cell = cell;
    this.ground = ground;
    const n = (this.n = nx * nz);
    this.depth = new Float32Array(n);
    this.fl = new Float32Array(n);
    this.fr = new Float32Array(n);
    this.ft = new Float32Array(n);
    this.fb = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.drain = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!Number.isFinite(ground[i])) this.drain[i] = 1;
    this.edges = edges && edges.length === n * EDGE_COUNT ? edges : null;
    const w = wallHeights(ground, this.edges, nx, nz);
    this.wallR = w.r;
    this.wallB = w.b;
  }

  /** Quellen setzen: Zellen im Radius bekommen je einen Anteil (zur Mitte hin mehr) */
  setSources(list: readonly SimSource[]): void {
    const cells: number[] = [];
    const share: number[] = [];
    for (const s of list) {
      const r = Math.max(0.5, s.r);
      const x0 = Math.max(0, Math.floor(s.x - r));
      const x1 = Math.min(this.nx - 1, Math.ceil(s.x + r));
      const z0 = Math.max(0, Math.floor(s.z - r));
      const z1 = Math.min(this.nz - 1, Math.ceil(s.z + r));
      const start = cells.length;
      let sum = 0;
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - s.x, z + 0.5 - s.z);
          if (d > r) continue;
          const i = z * this.nx + x;
          if (this.drain[i]) continue;
          const w = 1 - (d / r) * 0.7;
          cells.push(i);
          share.push(w);
          sum += w;
        }
      if (cells.length === start) {
        // Radius kleiner als eine Zelle: nächste Zelle
        const x = Math.min(this.nx - 1, Math.max(0, Math.floor(s.x)));
        const z = Math.min(this.nz - 1, Math.max(0, Math.floor(s.z)));
        const i = z * this.nx + x;
        if (this.drain[i]) continue;
        cells.push(i);
        share.push(1);
        sum = 1;
      }
      for (let k = start; k < share.length; k++) share[k] = (share[k] / sum) * s.rate;
    }
    this.srcCells = Int32Array.from(cells);
    this.srcShare = Float32Array.from(share);
  }

  /** größter stabiler Zeitschritt (CFL) */
  maxDt(): number {
    let dmax = 0.05;
    let vmax = 0;
    const { depth, vx, vz } = this;
    for (let i = 0; i < this.n; i++) {
      if (depth[i] > dmax) dmax = depth[i];
      const v = Math.abs(vx[i]) + Math.abs(vz[i]);
      if (v > vmax) vmax = v;
    }
    return Math.min(0.05, (this.cell * (this.params.cfl ?? 0.5)) / (Math.sqrt(SIM_G * dmax) + vmax));
  }

  /** `seconds` weiterrechnen (in stabilen Teilschritten) */
  advance(seconds: number): void {
    let left = seconds;
    let guard = 0;
    while (left > 1e-6 && guard++ < 100000) {
      const dt = Math.min(left, this.maxDt());
      this.step(dt);
      left -= dt;
    }
  }

  step(dt: number): void {
    const { nx, nz, cell, ground, depth, fl, fr, ft, fb, vx, vz, drain, wallR, wallB } = this;
    const A = cell * cell;
    const k = dt * cell * SIM_G;
    const fric = 0.004 + this.params.friction * 0.06;
    const fricV = this.params.friction * 0.15;

    // 1) Quellen
    const sc = this.srcCells;
    const ss = this.srcShare;
    for (let j = 0; j < sc.length; j++) depth[sc[j]] += (ss[j] * dt) / A;

    // 2) Abflüsse
    for (let z = 0; z < nz; z++) {
      const row = z * nx;
      for (let x = 0; x < nx; x++) {
        const i = row + x;
        if (drain[i]) continue;
        const d = depth[i];
        const b = ground[i];
        const H = b + d;
        // Nachbar fehlt (Rand) oder ohne Boden: Wasser fällt/fließt ab, als läge dort die eigene Bodenhöhe
        let n2 = i - 1;
        const hL = x > 0 && !drain[n2] ? ground[n2] + depth[n2] : b;
        n2 = i + 1;
        const hR = x < nx - 1 && !drain[n2] ? ground[n2] + depth[n2] : b;
        n2 = i - nx;
        const hT = z > 0 && !drain[n2] ? ground[n2] + depth[n2] : b;
        n2 = i + nx;
        const hB = z < nz - 1 && !drain[n2] ? ground[n2] + depth[n2] : b;
        // Reibung: flaches und schnelles Wasser wird stärker gebremst
        const sp = Math.abs(vx[i]) + Math.abs(vz[i]);
        const damp = 1 / (1 + (dt * (fric + fricV * sp)) / Math.max(d, 0.004));
        // Wand zwischen den Zellen: nur, was über ihre Oberkante reicht, fließt hinüber
        const wl = x > 0 ? wallR[i - 1] : -Infinity;
        const wr = wallR[i];
        const wt = z > 0 ? wallB[i - nx] : -Infinity;
        const wb = wallB[i];
        let l = H > wl ? Math.max(0, fl[i] * damp + k * (H - Math.max(hL, wl))) : 0;
        let r = H > wr ? Math.max(0, fr[i] * damp + k * (H - Math.max(hR, wr))) : 0;
        let t = H > wt ? Math.max(0, ft[i] * damp + k * (H - Math.max(hT, wt))) : 0;
        let bo = H > wb ? Math.max(0, fb[i] * damp + k * (H - Math.max(hB, wb))) : 0;
        const sum = (l + r + t + bo) * dt;
        const vol = d * A;
        if (sum > vol) {
          const s = sum > 0 ? vol / sum : 0;
          l *= s;
          r *= s;
          t *= s;
          bo *= s;
        }
        fl[i] = l;
        fr[i] = r;
        ft[i] = t;
        fb[i] = bo;
      }
    }

    // 3) Tiefe + Geschwindigkeit
    const loss = this.params.loss * dt;
    for (let z = 0; z < nz; z++) {
      const row = z * nx;
      for (let x = 0; x < nx; x++) {
        const i = row + x;
        if (drain[i]) {
          depth[i] = 0;
          vx[i] = 0;
          vz[i] = 0;
          continue;
        }
        const inL = x > 0 ? fr[i - 1] : 0;
        const inR = x < nx - 1 ? fl[i + 1] : 0;
        const inT = z > 0 ? fb[i - nx] : 0;
        const inB = z < nz - 1 ? ft[i + nx] : 0;
        const d0 = depth[i];
        let d1 = d0 + (dt * (inL + inR + inT + inB - fl[i] - fr[i] - ft[i] - fb[i])) / A;
        d1 = d1 > loss ? d1 - loss : 0;
        depth[i] = d1;
        const dm = (d0 + d1) * 0.5;
        if (dm > 1e-4) {
          // dünne Filme: Tiefe nach unten begrenzen, sonst entstehen riesige Scheingeschwindigkeiten
          const dv = cell * Math.max(dm, 0.02);
          const wx = (inL - fl[i] + fr[i] - inR) * 0.5;
          const wz = (inT - ft[i] + fb[i] - inB) * 0.5;
          let u = wx / dv;
          let v = wz / dv;
          const s = Math.hypot(u, v);
          if (s > MAX_SPEED) {
            u *= MAX_SPEED / s;
            v *= MAX_SPEED / s;
          }
          vx[i] = u;
          vz[i] = v;
        } else {
          vx[i] = 0;
          vz[i] = 0;
        }
      }
    }
    this.time += dt;
  }

  /** Wassermenge im Gebiet (m³) */
  volume(): number {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.depth[i];
    return s * this.cell * this.cell;
  }

  /** nasse Zellen */
  wetCount(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.depth[i] > SIM_WET) c++;
    return c;
  }
}

// ---------- Zustand speichern/laden ----------

export interface SimHeader {
  nx: number;
  nz: number;
  cell: number;
  minX: number;
  minZ: number;
  time: number;
  /** Kennung des Quellen-Verbunds (welche Quellen zusammen gerechnet wurden), 0 = alter Zustand */
  sig: number;
  /** Zeitpunkt der Berechnung (ms seit 1970), 0 = unbekannt */
  bakedAt: number;
  /** 1 = alter Zustand ohne Kanten-Daten */
  version: number;
}

const MAGIC = 0x57534d31; // "WSM1": 8 Felder
const MAGIC2 = 0x57534d32; // "WSM2": 8 Felder + Kanten-Daten, Verbund-Kennung, Zeitpunkt
const HEAD1 = 64;
const HEAD2 = 80;

/** Gitter + Zustand als Bytes (Boden, Tiefe, 4 Abflüsse, Geschwindigkeit, Kanten) — wird mit fflate komprimiert */
export function encodeSim(s: ShallowWater, minX: number, minZ: number, sig: number, bakedAt: number): Uint8Array {
  return encodeState({ nx: s.nx, nz: s.nz, cell: s.cell, minX, minZ, time: s.time, sig, bakedAt }, s.ground, s.depth, s.vx, s.vz, [s.fl, s.fr, s.ft, s.fb], s.edges);
}

/** Zustand aus einzelnen Feldern (ohne Abflüsse: starten bei null) */
export function encodeState(
  h: Omit<SimHeader, 'version'>,
  ground: Float32Array,
  depth: Float32Array,
  vx: Float32Array,
  vz: Float32Array,
  flux?: Float32Array[],
  edges?: Float32Array | null,
): Uint8Array {
  const n = h.nx * h.nz;
  const ne = edges && edges.length === n * EDGE_COUNT ? edges : null;
  const head = new Float64Array([MAGIC2, h.nx, h.nz, h.cell, h.minX, h.minZ, h.time, h.sig, h.bakedAt, ne ? 1 : 0]);
  const body = new Float32Array(n * (8 + (ne ? EDGE_COUNT : 0)));
  body.set(ground, 0);
  body.set(depth, n);
  if (flux) for (let k = 0; k < 4; k++) body.set(flux[k], n * (2 + k));
  body.set(vx, n * 6);
  body.set(vz, n * 7);
  if (ne) body.set(ne, n * 8);
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(new Uint8Array(head.buffer), 0);
  out.set(new Uint8Array(body.buffer), head.byteLength);
  return out;
}

function headerOf(bytes: Uint8Array): { h: SimHeader; size: number; edges: boolean } | null {
  if (bytes.byteLength < HEAD1) return null;
  const magic = new Float64Array(bytes.slice(0, 8).buffer)[0];
  if (magic === MAGIC) {
    const head = new Float64Array(bytes.slice(0, HEAD1).buffer);
    const nx = head[1];
    const nz = head[2];
    if (bytes.byteLength !== HEAD1 + nx * nz * 8 * 4) return null;
    return { h: { nx, nz, cell: head[3], minX: head[4], minZ: head[5], time: head[6], sig: 0, bakedAt: 0, version: 1 }, size: HEAD1, edges: false };
  }
  if (magic !== MAGIC2 || bytes.byteLength < HEAD2) return null;
  const head = new Float64Array(bytes.slice(0, HEAD2).buffer);
  const nx = head[1];
  const nz = head[2];
  const edges = head[9] === 1;
  if (bytes.byteLength !== HEAD2 + nx * nz * (8 + (edges ? EDGE_COUNT : 0)) * 4) return null;
  return { h: { nx, nz, cell: head[3], minX: head[4], minZ: head[5], time: head[6], sig: head[7], bakedAt: head[8], version: 2 }, size: HEAD2, edges };
}

export function decodeHeader(bytes: Uint8Array): SimHeader | null {
  return headerOf(bytes)?.h ?? null;
}

export interface SimFields {
  head: SimHeader;
  ground: Float32Array;
  depth: Float32Array;
  flux: Float32Array[];
  vx: Float32Array;
  vz: Float32Array;
  edges: Float32Array | null;
}

/** alle Felder eines Zustands (Kopien) */
export function decodeFields(bytes: Uint8Array): SimFields | null {
  const hd = headerOf(bytes);
  if (!hd) return null;
  const n = hd.h.nx * hd.h.nz;
  const body = new Float32Array(bytes.slice(hd.size).buffer);
  return {
    head: hd.h,
    ground: body.slice(0, n),
    depth: body.slice(n, n * 2),
    flux: [2, 3, 4, 5].map((k) => body.slice(n * k, n * (k + 1))),
    vx: body.slice(n * 6, n * 7),
    vz: body.slice(n * 7, n * 8),
    edges: hd.edges ? body.slice(n * 8, n * (8 + EDGE_COUNT)) : null,
  };
}

export function decodeSim(bytes: Uint8Array): { head: SimHeader; sim: ShallowWater } | null {
  const f = decodeFields(bytes);
  if (!f) return null;
  const sim = new ShallowWater(f.head.nx, f.head.nz, f.head.cell, f.ground, f.edges);
  sim.depth.set(f.depth);
  sim.fl.set(f.flux[0]);
  sim.fr.set(f.flux[1]);
  sim.ft.set(f.flux[2]);
  sim.fb.set(f.flux[3]);
  sim.vx.set(f.vx);
  sim.vz.set(f.vz);
  sim.time = f.head.time;
  return { head: f.head, sim };
}
