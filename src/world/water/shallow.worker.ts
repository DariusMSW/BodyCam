import { zlibSync } from 'fflate';
import { ShallowWater, decodeSim, encodeSim, type SimParams, type SimSource } from './shallow.ts';

// Web Worker der Wasserquelle: rechnet die Flachwasser-Simulation abseits des Haupt-Threads.
//  - init:  Gitter (Boden) oder Zustand (encodeState), Quellen, Parameter
//  - step:  `dt` Sekunden weiter (Echtzeit im Spiel / Editor-Simulation) → frame (Tiefe + Geschwindigkeit)
//  - bake:  vom trockenen Zustand `seconds` vorrechnen; zwischendurch progress + frame, am Ende baked (komprimiert)

export type SimRequest =
  | {
      type: 'init';
      nx: number;
      nz: number;
      cell: number;
      minX: number;
      minZ: number;
      ground?: Float32Array;
      /** Kanten-Daten zu `ground` (Wände zwischen Zellen) */
      edges?: Float32Array;
      state?: Uint8Array;
      sources: SimSource[];
      params: SimParams;
      /** Kennung des Quellen-Verbunds (wird mit dem Zustand gespeichert) */
      sig: number;
    }
  | { type: 'step'; dt: number; reuse?: SimFrame }
  | { type: 'bake'; seconds: number; reset: boolean };

export interface SimFrame {
  depth: Float32Array;
  vx: Float32Array;
  vz: Float32Array;
}

export type SimResponse =
  | ({ type: 'frame'; time: number; volume: number } & SimFrame)
  | { type: 'progress'; f: number; time: number; volume: number; wet: number }
  | { type: 'baked'; bytes: Uint8Array; time: number; volume: number; wet: number }
  | { type: 'error'; message: string };

interface WorkerScope {
  postMessage(m: SimResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<SimRequest>) => void) | null;
}
const ctx = self as unknown as WorkerScope;
let sim: ShallowWater | null = null;
let minX = 0;
let minZ = 0;
let sig = 0;

function frame(reuse?: SimFrame): void {
  if (!sim) return;
  const n = sim.n;
  const f: SimFrame = reuse && reuse.depth.length === n ? reuse : { depth: new Float32Array(n), vx: new Float32Array(n), vz: new Float32Array(n) };
  f.depth.set(sim.depth);
  f.vx.set(sim.vx);
  f.vz.set(sim.vz);
  const msg: SimResponse = { type: 'frame', time: sim.time, volume: sim.volume(), ...f };
  ctx.postMessage(msg, [f.depth.buffer, f.vx.buffer, f.vz.buffer]);
}

ctx.onmessage = (e: MessageEvent<SimRequest>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        minX = m.minX;
        minZ = m.minZ;
        sig = m.sig;
        const loaded = m.state ? decodeSim(m.state) : null;
        sim = loaded ? loaded.sim : new ShallowWater(m.nx, m.nz, m.cell, m.ground ?? new Float32Array(m.nx * m.nz), m.edges ?? null);
        sim.params = m.params;
        sim.setSources(m.sources);
        frame();
        break;
      }
      case 'step':
        if (!sim) break;
        sim.advance(Math.min(0.1, m.dt));
        frame(m.reuse);
        break;
      case 'bake': {
        if (!sim) break;
        const s = sim;
        if (m.reset) {
          s.depth.fill(0);
          s.fl.fill(0);
          s.fr.fill(0);
          s.ft.fill(0);
          s.fb.fill(0);
          s.vx.fill(0);
          s.vz.fill(0);
          s.time = 0;
        }
        const end = s.time + m.seconds;
        const start = s.time;
        let last = performance.now();
        let lastFrame = last;
        while (s.time < end - 1e-6) {
          s.advance(Math.min(0.25, end - s.time));
          const now = performance.now();
          if (now - last > 120) {
            last = now;
            const p: SimResponse = { type: 'progress', f: (s.time - start) / m.seconds, time: s.time, volume: s.volume(), wet: s.wetCount() };
            ctx.postMessage(p);
          }
          // Zwischenstand sichtbar machen
          if (now - lastFrame > 400) {
            lastFrame = now;
            frame();
          }
        }
        frame();
        const bytes = zlibSync(encodeSim(s, minX, minZ, sig, Date.now()), { level: 6 });
        const done: SimResponse = { type: 'baked', bytes, time: s.time, volume: s.volume(), wet: s.wetCount() };
        ctx.postMessage(done, [bytes.buffer]);
        break;
      }
    }
  } catch (err) {
    const r: SimResponse = { type: 'error', message: (err as Error).message };
    ctx.postMessage(r);
  }
};
