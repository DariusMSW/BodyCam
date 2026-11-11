import { audioOutput } from './footsteps.ts';

// Klänge für Scripts (Blöcke „Klang“). Wie die Schritte ohne Audiodateien: alles wird aus Oszillatoren und
// gefiltertem Rauschen zusammengesetzt. Zusätzlich lassen sich Dateien aus public/assets/audio abspielen.

/** Einmal-Klänge: [Anzeige, Kennung] */
export const SOUND_OPTIONS: [string, string][] = [
  ['Hupe', 'horn'],
  ['Tür auf', 'door_open'],
  ['Tür zu', 'door_close'],
  ['Anlasser', 'starter'],
  ['Motor aus', 'engine_off'],
  ['Quietschen', 'squeak'],
  ['Klick', 'click'],
  ['Schlag', 'thud'],
  ['Piep', 'beep'],
  ['Klingel', 'bell'],
];

/** Dauerklänge (laufen, bis sie gestoppt werden) */
export const LOOP_OPTIONS: [string, string][] = [
  ['Motor', 'engine'],
  ['Brummen', 'hum'],
  ['Alarm', 'alarm'],
  ['Rauschen', 'noise'],
];

type Out = NonNullable<ReturnType<typeof audioOutput>>;

function env(o: Out, t: number, peak: number, attack: number, hold: number, release: number): GainNode {
  const g = o.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.setValueAtTime(Math.max(0.0002, peak), t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  return g;
}

function osc(o: Out, type: OscillatorType, hz: number, t: number, len: number): OscillatorNode {
  const s = o.ctx.createOscillator();
  s.type = type;
  s.frequency.setValueAtTime(hz, t);
  s.start(t);
  s.stop(t + len + 0.05);
  return s;
}

function noise(o: Out, t: number, len: number): AudioBufferSourceNode {
  const s = o.ctx.createBufferSource();
  s.buffer = o.noise;
  s.loop = true;
  s.start(t, Math.random() * 1.5);
  s.stop(t + len + 0.05);
  return s;
}

function biquad(o: Out, type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode {
  const f = o.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

const ONE_SHOTS: Record<string, (o: Out, dst: AudioNode, t: number) => void> = {
  horn: (o, dst, t) => {
    // Zweiklang-Hupe: zwei Rechteck-Töne durch einen Bandpass
    const g = env(o, t, 0.5, 0.02, 0.5, 0.08);
    const f = biquad(o, 'bandpass', 900, 0.8);
    for (const hz of [349, 440]) osc(o, 'square', hz, t, 0.65).connect(f);
    f.connect(g).connect(dst);
  },
  door_open: (o, dst, t) => {
    noise(o, t, 0.06).connect(biquad(o, 'highpass', 2200)).connect(env(o, t, 0.35, 0.002, 0.01, 0.05)).connect(dst);
    const s = osc(o, 'sine', 160, t + 0.03, 0.12);
    s.frequency.exponentialRampToValueAtTime(90, t + 0.14);
    s.connect(env(o, t + 0.03, 0.4, 0.004, 0.02, 0.1)).connect(dst);
  },
  door_close: (o, dst, t) => {
    const s = osc(o, 'sine', 110, t, 0.25);
    s.frequency.exponentialRampToValueAtTime(45, t + 0.2);
    s.connect(env(o, t, 0.9, 0.003, 0.03, 0.2)).connect(dst);
    noise(o, t, 0.12).connect(biquad(o, 'lowpass', 900)).connect(env(o, t, 0.5, 0.002, 0.02, 0.1)).connect(dst);
    noise(o, t + 0.01, 0.04).connect(biquad(o, 'highpass', 3000)).connect(env(o, t + 0.01, 0.2, 0.001, 0.005, 0.03)).connect(dst);
  },
  starter: (o, dst, t) => {
    // Anlasser: Sägezahn, im Takt der Kurbelwelle moduliert
    const len = 1.1;
    const s = osc(o, 'sawtooth', 85, t, len);
    s.frequency.linearRampToValueAtTime(110, t + len);
    const am = o.ctx.createGain();
    am.gain.value = 0.5;
    const lfo = osc(o, 'sine', 9, t, len);
    const depth = o.ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(am.gain);
    s.connect(biquad(o, 'lowpass', 700)).connect(am).connect(env(o, t, 0.45, 0.03, len - 0.15, 0.1)).connect(dst);
    noise(o, t, len).connect(biquad(o, 'bandpass', 1800, 1.5)).connect(env(o, t, 0.08, 0.03, len - 0.15, 0.1)).connect(dst);
  },
  engine_off: (o, dst, t) => {
    const s = osc(o, 'sawtooth', 55, t, 0.7);
    s.frequency.exponentialRampToValueAtTime(14, t + 0.65);
    s.connect(biquad(o, 'lowpass', 300)).connect(env(o, t, 0.5, 0.01, 0.2, 0.45)).connect(dst);
  },
  squeak: (o, dst, t) => {
    const s = osc(o, 'sawtooth', 620, t, 0.5);
    s.frequency.linearRampToValueAtTime(980, t + 0.25);
    s.frequency.linearRampToValueAtTime(700, t + 0.5);
    s.connect(biquad(o, 'bandpass', 1500, 6)).connect(env(o, t, 0.25, 0.05, 0.3, 0.12)).connect(dst);
  },
  click: (o, dst, t) => {
    noise(o, t, 0.03).connect(biquad(o, 'bandpass', 2600, 2)).connect(env(o, t, 0.5, 0.001, 0.004, 0.025)).connect(dst);
  },
  thud: (o, dst, t) => {
    const s = osc(o, 'sine', 90, t, 0.25);
    s.frequency.exponentialRampToValueAtTime(38, t + 0.2);
    s.connect(env(o, t, 0.9, 0.004, 0.02, 0.2)).connect(dst);
  },
  beep: (o, dst, t) => {
    osc(o, 'sine', 880, t, 0.16).connect(env(o, t, 0.35, 0.005, 0.1, 0.04)).connect(dst);
  },
  bell: (o, dst, t) => {
    for (const [hz, v] of [[1320, 0.3], [1980, 0.15], [2640, 0.08]] as const) osc(o, 'sine', hz, t, 1.2).connect(env(o, t, v, 0.002, 0.02, 1.1)).connect(dst);
  },
};

/** Einmal-Klang abspielen; volume 0..1 (schon mit der Entfernung verrechnet) */
export function playSound(id: string, volume: number): void {
  const o = audioOutput();
  const make = ONE_SHOTS[id];
  if (!o || !make || volume <= 0.001) return;
  const g = o.ctx.createGain();
  g.gain.value = Math.min(2, volume);
  g.connect(o.out);
  make(o, g, o.ctx.currentTime + 0.01);
}

const files = new Map<string, Promise<AudioBuffer | null>>();

/** Audiodatei aus public/assets/audio abspielen (z. B. "hupe.mp3") */
export function playFile(name: string, volume: number): void {
  const o = audioOutput();
  if (!o || !/^[\w .\-/]+$/.test(name) || name.includes('..')) return;
  let p = files.get(name);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}assets/audio/${name}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => o.ctx.decodeAudioData(b))
      .catch((e) => {
        console.warn(`Audiodatei "${name}" konnte nicht geladen werden`, e);
        return null;
      });
    files.set(name, p);
  }
  void p.then((buf) => {
    if (!buf) return;
    const s = o.ctx.createBufferSource();
    s.buffer = buf;
    const g = o.ctx.createGain();
    g.gain.value = Math.min(2, Math.max(0, volume));
    s.connect(g).connect(o.out);
    s.start();
  });
}

/** Laufender Dauerklang: Lautstärke und Tonhöhe lassen sich nachführen */
export interface SoundLoop {
  setVolume(v: number): void;
  /** 1 = normal */
  setPitch(p: number): void;
  stop(): void;
}

export function startLoop(id: string, volume: number): SoundLoop | null {
  const o = audioOutput();
  if (!o) return null;
  const a = o.ctx;
  const t = a.currentTime;
  const out = a.createGain();
  out.gain.value = 0.0001;
  out.connect(o.out);
  const sources: AudioScheduledSourceNode[] = [];
  /** [Parameter, Grundfrequenz] — folgen der Tonhöhe */
  const pitched: [AudioParam, number][] = [];
  const tone = (type: OscillatorType, hz: number, dst: AudioNode) => {
    const s = a.createOscillator();
    s.type = type;
    s.frequency.value = hz;
    s.connect(dst);
    s.start(t);
    sources.push(s);
    pitched.push([s.frequency, hz]);
    return s;
  };
  const hiss = (dst: AudioNode) => {
    const s = a.createBufferSource();
    s.buffer = o.noise;
    s.loop = true;
    s.connect(dst);
    s.start(t, Math.random());
    sources.push(s);
  };
  if (id === 'engine') {
    // Reihensechszylinder im Leerlauf: Zündfolge als Sägezahn + Oberton, leicht unrund moduliert, dazu Auspuffrauschen
    const lp = biquad(o, 'lowpass', 520, 0.9);
    pitched.push([lp.frequency, 520]);
    const am = a.createGain();
    am.gain.value = 0.7;
    const depth = a.createGain();
    depth.gain.value = 0.3;
    tone('sine', 6.5, depth);
    depth.connect(am.gain);
    const g1 = a.createGain();
    g1.gain.value = 0.55;
    const g2 = a.createGain();
    g2.gain.value = 0.25;
    tone('sawtooth', 42, g1);
    tone('square', 63, g2);
    tone('sawtooth', 21, g1);
    g1.connect(lp);
    g2.connect(lp);
    lp.connect(am).connect(out);
    const nf = biquad(o, 'bandpass', 260, 0.8);
    pitched.push([nf.frequency, 260]);
    const ng = a.createGain();
    ng.gain.value = 0.22;
    hiss(nf);
    nf.connect(ng).connect(am);
  } else if (id === 'hum') {
    const g = a.createGain();
    g.gain.value = 0.4;
    tone('sine', 50, g);
    tone('sine', 100, g);
    tone('triangle', 150, g);
    g.connect(out);
  } else if (id === 'alarm') {
    const g = a.createGain();
    g.gain.value = 0.3;
    const s = tone('square', 760, g);
    const depth = a.createGain();
    depth.gain.value = 180;
    tone('sine', 2.2, depth);
    depth.connect(s.frequency);
    g.connect(biquad(o, 'bandpass', 1000, 0.7)).connect(out);
  } else {
    const f = biquad(o, 'lowpass', 1200);
    pitched.push([f.frequency, 1200]);
    hiss(f);
    f.connect(out);
  }
  const loop: SoundLoop = {
    setVolume: (v) => out.gain.setTargetAtTime(Math.min(2, Math.max(0.0001, v)), a.currentTime, 0.08),
    setPitch: (p) => {
      const k = Math.min(6, Math.max(0.2, p));
      for (const [param, base] of pitched) param.setTargetAtTime(base * k, a.currentTime, 0.1);
    },
    stop: () => {
      out.gain.setTargetAtTime(0.0001, a.currentTime, 0.06);
      for (const s of sources) s.stop(a.currentTime + 0.4);
      setTimeout(() => out.disconnect(), 600);
    },
  };
  loop.setVolume(volume);
  return loop;
}
