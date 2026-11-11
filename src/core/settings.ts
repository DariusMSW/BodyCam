// Zentrale, persistente Spieleinstellungen (localStorage). Änderungen werden an Listener gemeldet.

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'crouch'
  | 'aim'
  | 'jump'
  | 'flashlight'
  | 'interact'
  | 'fog'
  | 'hud';

export const ACTIONS: Action[] = ['forward', 'back', 'left', 'right', 'sprint', 'crouch', 'aim', 'jump', 'flashlight', 'interact', 'fog', 'hud'];

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Vorwärts',
  back: 'Rückwärts',
  left: 'Links',
  right: 'Rechts',
  sprint: 'Sprinten',
  crouch: 'Schleichen / Ducken',
  aim: 'Zielen',
  jump: 'Springen',
  flashlight: 'Taschenlampe',
  interact: 'Benutzen',
  fog: 'Nebel (Debug)',
  hud: 'Debug-Text',
};

export const DEFAULT_BINDINGS: Record<Action, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  crouch: 'ControlLeft',
  aim: 'Mouse2',
  jump: 'Space',
  flashlight: 'KeyF',
  interact: 'KeyE',
  fog: 'KeyN',
  hud: 'KeyH',
};

export const QUALITY_LABELS = ['Niedrig', 'Mittel', 'Hoch', 'Ultra', 'Benutzerdefiniert'];
export const SHADOW_LABELS = ['Aus', 'Niedrig', 'Hoch'];
export const REFLECTION_LABELS = ['Aus', 'Niedrig', 'Hoch'];
export const VOLUMETRIC_LABELS = ['Niedrig', 'Mittel', 'Hoch'];
export const AO_LABELS = ['Aus', 'Niedrig', 'Hoch'];
export const AA_LABELS = ['Aus', '2x', '4x'];
/** MSAA-Samples des HDR-Szenenpuffers je Stufe (kostet auf schwachen GPUs viel Speicherbandbreite) */
export const AA_SAMPLES = [0, 2, 4];
export const TERRAIN_LABELS = ['Niedrig', 'Mittel', 'Hoch', 'Ultra'];
/** Detail-Faktor der Landscape-LODs (Abstand, ab dem eine gröbere Stufe benutzt wird) */
export const TERRAIN_DETAIL = [1.5, 2, 2.5, 3.5];
export const FOLIAGE_LABELS = ['Niedrig', 'Mittel', 'Hoch', 'Ultra'];
/** Faktor auf die Dichte von Deko-Foliage und Layer-Gras */
export const FOLIAGE_DENSITY = [0.3, 0.55, 0.8, 1];
/** Faktor auf Sichtweite, LOD- und Impostor-Abstände der Foliage */
export const FOLIAGE_DISTANCE = [0.5, 0.75, 1, 1.4];
export const MM_MODES = ['Team Deathmatch', 'Extraction', 'Horde (Koop)', 'Hunt (PvE)'];
export const MM_REGIONS = ['Automatisch', 'EU-West', 'EU-Ost', 'Nordamerika', 'Asien'];
export const MM_PARTY = ['Solo', 'Duo', 'Squad (4)'];

export interface SettingsData {
  bindings: Record<Action, string>;
  // Maus & Kamera
  mouseSensitivity: number; // Faktor
  invertY: boolean;
  fov: number;
  cameraShake: number; // Faktor für Kopfwippen/Wackeln
  // Grafik
  quality: number; // Index in QUALITY_LABELS
  shadows: number; // Index in SHADOW_LABELS
  renderScale: number; // Faktor auf devicePixelRatio
  bloom: boolean;
  bloomStrength: number; // Faktor auf die Basisstärke (1 = alter Wert, Standard 0.5)
  godRays: number; // Stärke der Sonnenstrahlen (0 = aus)
  reflections: number; // Index in REFLECTION_LABELS (Pfützen-Spiegelungen)
  volumetrics: number; // Index in VOLUMETRIC_LABELS (Nebel-Schritte, Partikelmenge)
  ao: number; // Index in AO_LABELS (Umgebungsverdeckung / Kontaktschatten)
  antialias: number; // Index in AA_LABELS (MSAA der Szene)
  terrainDetail: number; // Index in TERRAIN_LABELS (Landscape-LOD)
  foliageDensity: number; // Index in FOLIAGE_LABELS (FOLIAGE_DENSITY)
  foliageDistance: number; // Index in FOLIAGE_LABELS (FOLIAGE_DISTANCE)
  grass: boolean; // Layer-Gras der Landscapes
  brightness: number;
  fogEnabled: boolean;
  viewDistance: number;
  // Bodycam-Effekt
  lensDistortion: number;
  grain: number;
  aberration: number;
  vignette: number;
  hudOverlay: boolean;
  motionBlur: number; // Bewegungsunschärfe der Kamera (0 = aus, 1 = volle Verschlusszeit)
  autoExposure: boolean; // Belichtungsautomatik (Kamera regelt hell/dunkel träge nach)
  // Matchmaking
  mmMode: number;
  mmRegion: number;
  mmParty: number;
}

/** Optionen, die das Qualitäts-Preset setzt */
const PRESET_KEYS = ['shadows', 'renderScale', 'bloom', 'reflections', 'volumetrics', 'ao', 'antialias', 'terrainDetail', 'foliageDensity', 'foliageDistance', 'grass'] as const;
type PresetKey = (typeof PRESET_KEYS)[number];

export const QUALITY_PRESETS: Pick<SettingsData, PresetKey>[] = [
  { shadows: 0, renderScale: 0.75, bloom: false, reflections: 0, volumetrics: 0, ao: 0, antialias: 0, terrainDetail: 0, foliageDensity: 0, foliageDistance: 0, grass: false },
  { shadows: 1, renderScale: 1.0, bloom: true, reflections: 1, volumetrics: 1, ao: 1, antialias: 1, terrainDetail: 1, foliageDensity: 1, foliageDistance: 1, grass: true },
  { shadows: 2, renderScale: 1.0, bloom: true, reflections: 2, volumetrics: 2, ao: 2, antialias: 2, terrainDetail: 2, foliageDensity: 2, foliageDistance: 2, grass: true },
  { shadows: 2, renderScale: 1.5, bloom: true, reflections: 2, volumetrics: 2, ao: 2, antialias: 2, terrainDetail: 3, foliageDensity: 3, foliageDistance: 3, grass: true },
];

const DEFAULTS: SettingsData = {
  bindings: { ...DEFAULT_BINDINGS },
  mouseSensitivity: 1,
  invertY: false,
  fov: 80,
  cameraShake: 1,
  quality: 2,
  shadows: 2,
  renderScale: 1,
  bloom: true,
  bloomStrength: 0.5,
  godRays: 1,
  reflections: 2,
  volumetrics: 2,
  ao: 2,
  antialias: 2,
  terrainDetail: 2,
  foliageDensity: 2,
  foliageDistance: 2,
  grass: true,
  brightness: 1,
  fogEnabled: true,
  viewDistance: 25,
  lensDistortion: 1,
  grain: 1,
  aberration: 1,
  vignette: 1,
  hudOverlay: true,
  motionBlur: 0.5,
  autoExposure: true,
  mmMode: 0,
  mmRegion: 0,
  mmParty: 0,
};

const STORAGE_KEY = 'bodycam.settings.v1';

type Listener = (key: keyof SettingsData) => void;

export class Settings {
  data: SettingsData;
  /** Faktor der Map auf die Sichtweite (große Landscapes: Map-Sichtweite / 60); nur Anzeige */
  viewScale = 1;
  private listeners: Listener[] = [];

  constructor() {
    this.data = structuredClone(DEFAULTS);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SettingsData>;
        this.data = { ...this.data, ...parsed, bindings: { ...DEFAULT_BINDINGS, ...(parsed.bindings ?? {}) } };
        // Kantenglättung kam später dazu: alte Speicherstände übernehmen den Wert ihres Presets (Niedrig = aus)
        if (parsed.antialias === undefined) this.data.antialias = QUALITY_PRESETS[this.data.quality]?.antialias ?? DEFAULTS.antialias;
      }
    } catch {
      // Speicher nicht verfügbar → Standardwerte
    }
  }

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    if (this.data[key] === value) return;
    this.data[key] = value;
    // Einzelne Grafikoption geändert → Preset wird "Benutzerdefiniert"
    if ((PRESET_KEYS as readonly string[]).includes(key)) {
      const d = this.data;
      const match = QUALITY_PRESETS.findIndex((p) => PRESET_KEYS.every((k) => p[k] === d[k]));
      this.data.quality = match === -1 ? QUALITY_LABELS.length - 1 : match;
    }
    this.save();
    this.emit(key);
  }

  applyQuality(index: number): void {
    const preset = QUALITY_PRESETS[index];
    if (!preset) return;
    this.data.quality = index;
    Object.assign(this.data, preset);
    this.save();
    for (const k of PRESET_KEYS) this.emit(k);
    this.emit('quality');
  }

  /** Belegt eine Aktion neu; hatte eine andere Aktion dieselbe Taste, werden beide getauscht */
  setBinding(action: Action, code: string): void {
    const b = this.data.bindings;
    const other = ACTIONS.find((a) => a !== action && b[a] === code);
    if (other) b[other] = b[action];
    b[action] = code;
    this.save();
    this.emit('bindings');
  }

  resetBindings(): void {
    this.data.bindings = { ...DEFAULT_BINDINGS };
    this.save();
    this.emit('bindings');
  }

  resetAll(): void {
    this.data = structuredClone(DEFAULTS);
    this.save();
    for (const k of Object.keys(DEFAULTS) as (keyof SettingsData)[]) this.emit(k);
  }

  onChange(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(key: keyof SettingsData): void {
    for (const fn of this.listeners) fn(key);
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // ignorieren
    }
  }
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Leertaste',
  ShiftLeft: 'L-Shift',
  ShiftRight: 'R-Shift',
  ControlLeft: 'L-Strg',
  ControlRight: 'R-Strg',
  AltLeft: 'L-Alt',
  AltRight: 'Alt Gr',
  Tab: 'Tab',
  CapsLock: 'Feststell',
  Enter: 'Enter',
  Backspace: 'Rücktaste',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Mouse0: 'Linksklick',
  Mouse1: 'Mausrad-Klick',
  Mouse2: 'Rechtsklick',
  Mouse3: 'Maus 4',
  Mouse4: 'Maus 5',
};

export function keyLabel(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
