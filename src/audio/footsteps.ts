import { SURFACES, type StepSound, type SurfaceId } from '../world/surfaces.ts';

// Schrittgeräusche ohne Audiodateien: je Oberfläche aus Ferse (gedämpfter Sinus), gefiltertem Rauschen,
// kurzen Knirsch-Klicks (Kies, Schnee) und einem Schmatzen (Schlamm) zusammengesetzt (Parameter in surfaces.ts).
// Der AudioContext startet erst nach einer Benutzeraktion (Browser-Regel).

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let muffle: BiquadFilterNode | null = null;

function audio(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
  } catch {
    return null;
  }
  master = ctx.createGain();
  master.gain.value = 0.55;
  // Tiefpass am Ausgang: unter Wasser dumpf (setAudioUnderwater)
  muffle = ctx.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 20000;
  master.connect(muffle).connect(ctx.destination);
  // 2 s weißes Rauschen, jeder Schritt liest ab einer zufälligen Stelle
  noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Gemeinsamer Ausgang für andere Klangquellen (Script-Klänge): Kontext, Master-Regler, Rauschpuffer */
export function audioOutput(): { ctx: AudioContext; out: AudioNode; noise: AudioBuffer } | null {
  const a = audio();
  if (!a || !master || !noise) return null;
  if (a.state !== 'running') void a.resume();
  return { ctx: a, out: master, noise };
}

/** beim ersten Klick/Tastendruck freischalten */
export function unlockAudio(): void {
  const unlock = () => {
    const a = audio();
    if (a && a.state !== 'running') void a.resume();
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

function envelope(a: AudioContext, t: number, peak: number, attack: number, decay: number): GainNode {
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function noiseSource(a: AudioContext, t: number, len: number): AudioBufferSourceNode {
  const src = a.createBufferSource();
  src.buffer = noise;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  src.start(t, Math.random() * 1.5, len + 0.05);
  return src;
}

function filter(a: AudioContext, type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode {
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = hz;
  f.Q.value = q;
  return f;
}

function play(s: StepSound, vol: number, heavy: number): void {
  const a = audio();
  if (!a || !master || a.state !== 'running' || vol <= 0.001) return;
  const t = a.currentTime + 0.005;
  const pitch = 0.92 + Math.random() * 0.16;
  const out = a.createGain();
  out.gain.value = vol;
  out.connect(master);

  // Ferse: kurzer Sinus mit fallender Tonhöhe
  if (s.thump > 0) {
    const o = a.createOscillator();
    o.frequency.setValueAtTime(s.thumpHz * pitch * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(s.thumpHz * pitch * 0.6, t + 0.09);
    const g = envelope(a, t, s.thump * (1 + heavy), 0.004, 0.09 + heavy * 0.08);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.25);
  }
  // Sohle/Material: gefiltertes Rauschen
  if (s.noise > 0) {
    const len = s.dur * (1 + heavy * 0.6);
    const src = noiseSource(a, t, len);
    const g = envelope(a, t, s.noise, 0.006, len);
    src.connect(filter(a, 'highpass', s.hp * pitch)).connect(filter(a, 'lowpass', s.lp * pitch)).connect(g).connect(out);
  }
  // Knirschen: viele winzige Klicks
  const grains = Math.round(s.grains * (0.7 + Math.random() * 0.6) * (1 + heavy));
  for (let i = 0; i < grains; i++) {
    const tg = t + Math.random() * s.spread;
    const len = 0.004 + Math.random() * 0.01;
    const src = noiseSource(a, tg, len);
    const g = envelope(a, tg, s.noise * (0.3 + Math.random() * 0.7), 0.001, len);
    src.connect(filter(a, 'highpass', s.grainHp * (0.7 + Math.random() * 0.8))).connect(g).connect(out);
  }
  // Schmatzen: Bandpass gleitet nach oben
  if (s.squelch) {
    const len = 0.16 + Math.random() * 0.06;
    const src = noiseSource(a, t + 0.03, len);
    const bp = filter(a, 'bandpass', 260, 7);
    bp.frequency.setValueAtTime(260 * pitch, t + 0.03);
    bp.frequency.exponentialRampToValueAtTime(1500 * pitch, t + 0.03 + len);
    const g = envelope(a, t + 0.03, s.squelch * 2.2, 0.02, len);
    src.connect(bp).connect(g).connect(out);
  }
}

/** Schritt: Tempo in m/s (Gehen ≈ 2, Sprint ≈ 6) */
export function playFootstep(surface: SurfaceId, speed: number, crouching: boolean): void {
  const vol = Math.min(1, 0.35 + speed * 0.11) * (crouching ? 0.4 : 1);
  play(SURFACES[surface].step, vol, 0);
}

/** Landung: Aufprall in m/s */
export function playLanding(surface: SurfaceId, impact: number, crouching: boolean): void {
  const k = Math.min(1, (impact - 2) / 6);
  play(SURFACES[surface].step, (0.75 + k * 0.35) * (crouching ? 0.7 : 1), 0.4 + k * 0.6);
}

export type WaterSound = 'step' | 'stroke' | 'splash' | 'dive';

/**
 * Wassergeräusche (Phase 6): Platschen beim Waten, Schwimmzug, Eintauchen, Abtauchen (Blubbern).
 * Stärke 0..1 (Waten: Tiefe/Tempo, Eintauchen: Fallgeschwindigkeit).
 */
export function playWater(kind: WaterSound, strength: number): void {
  const a = audio();
  if (!a || !master || a.state !== 'running') return;
  const k = Math.max(0, Math.min(1, strength));
  const t = a.currentTime + 0.005;
  const pitch = 0.85 + Math.random() * 0.3;
  const out = a.createGain();
  out.gain.value = kind === 'splash' ? 0.5 + k * 0.6 : kind === 'step' ? 0.25 + k * 0.4 : 0.3 + k * 0.3;
  out.connect(master);
  // Platschen: Rauschen, Bandpass gleitet von hell nach dumpf
  const len = kind === 'splash' ? 0.35 + k * 0.5 : kind === 'stroke' ? 0.32 : kind === 'dive' ? 0.25 : 0.16 + k * 0.12;
  const src = noiseSource(a, t, len);
  const bp = filter(a, 'bandpass', 1800, 1.2);
  bp.frequency.setValueAtTime((kind === 'stroke' ? 1400 : 2600) * pitch, t);
  bp.frequency.exponentialRampToValueAtTime(380 * pitch, t + len);
  const g = envelope(a, t, kind === 'dive' ? 0.25 : 0.9, kind === 'stroke' ? 0.06 : 0.008, len);
  src.connect(bp).connect(g).connect(out);
  // Blubbern: kurze, steigende Sinus-Tröpfchen
  const drops = kind === 'step' ? 2 : kind === 'stroke' ? 3 : kind === 'dive' ? 9 : 6 + Math.round(k * 8);
  for (let i = 0; i < drops; i++) {
    const td = t + 0.02 + Math.random() * len * 1.2;
    const o = a.createOscillator();
    const f0 = (kind === 'dive' ? 300 : 600) + Math.random() * 900;
    o.frequency.setValueAtTime(f0 * pitch, td);
    o.frequency.exponentialRampToValueAtTime(f0 * pitch * 2.2, td + 0.04);
    const gd = envelope(a, td, 0.12 + Math.random() * 0.12, 0.003, 0.05);
    o.connect(gd).connect(out);
    o.start(td);
    o.stop(td + 0.1);
  }
}

/** Ausgang unter Wasser dämpfen (0 = normal, 1 = ganz unter Wasser) */
export function setAudioUnderwater(k: number): void {
  if (!ctx || !muffle) return;
  const hz = 20000 * Math.pow(500 / 20000, Math.max(0, Math.min(1, k)));
  muffle.frequency.setTargetAtTime(hz, ctx.currentTime, 0.05);
}
