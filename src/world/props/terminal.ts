import * as THREE from 'three';
import { CanvasUI, THEME } from '../../ui/canvasUI.ts';
import type { Input } from '../../core/input.ts';
import type { BoxCollider } from '../collision.ts';
import type { FocusTarget } from '../../player/controller.ts';
import {
  ACTIONS,
  ACTION_LABELS,
  MM_MODES,
  MM_PARTY,
  MM_REGIONS,
  QUALITY_LABELS,
  SHADOW_LABELS,
  REFLECTION_LABELS,
  VOLUMETRIC_LABELS,
  AO_LABELS,
  AA_LABELS,
  TERRAIN_LABELS,
  FOLIAGE_LABELS,
  keyLabel,
  type Action,
  type Settings,
} from '../../core/settings.ts';

// In-World-Terminal: Monitor an der Wand, dessen Bildschirm das Hauptmenü zeigt.
// Bedienung über einen virtuellen Cursor (Mausbewegung im Pointer Lock), damit das Menü
// wirklich "im Bildschirm" lebt und mit Licht, Bloom und Bodycam-Effekt gerendert wird.

const CANVAS_W = 1280;
const CANVAS_H = 720;
const SCREEN_W = 1.2;
const SCREEN_H = SCREEN_W * (CANVAS_H / CANVAS_W);
const MENU_FOV = 50;
const CURSOR_SPEED = 1.1;

type Page = 'match' | 'keys' | 'mouse' | 'graphics' | 'bodycam' | 'system';
const PAGES: { id: Page; label: string }[] = [
  { id: 'match', label: 'MATCHMAKING' },
  { id: 'keys', label: 'TASTENBELEGUNG' },
  { id: 'mouse', label: 'MAUS & KAMERA' },
  { id: 'graphics', label: 'GRAFIK' },
  { id: 'bodycam', label: 'BODYCAM' },
  { id: 'system', label: 'SYSTEM' },
];

const MM_NEEDED = [10, 12, 4, 4];
const MM_PARTY_SIZE = [1, 2, 4];

const pct = (v: number) => `${Math.round(v * 100)} %`;

export class Terminal {
  readonly group = new THREE.Group();
  readonly screenMesh: THREE.Mesh;
  readonly collider: BoxCollider;
  active = false;

  private ui = new CanvasUI(CANVAS_W, CANVAS_H);
  private texture: THREE.CanvasTexture;
  private center: THREE.Vector3;
  private normal: THREE.Vector3;
  private page: Page = 'match';
  private capturing: Action | null = null;
  private confirmReset = 0;
  private redrawTimer = 0;
  private time = 0;

  // Matchmaking-Simulation (noch kein Server)
  private mm: 'idle' | 'searching' | 'found' = 'idle';
  private mmTime = 0;
  private mmFound = 0;
  private mmNext = 0;

  constructor(
    private settings: Settings,
    private input: Input,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    private onExit: () => void,
    anisotropy = 8,
  ) {
    this.center = center.clone();
    this.normal = normal.clone().normalize();

    this.texture = new THREE.CanvasTexture(this.ui.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;

    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(SCREEN_W + 0.12, SCREEN_H + 0.1, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85, metalness: 0.1 }),
    );
    bezel.castShadow = true;
    bezel.receiveShadow = true;
    this.group.add(bezel);

    this.screenMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(SCREEN_W, SCREEN_H),
      new THREE.MeshStandardMaterial({
        color: 0x000000,
        emissive: 0xffffff,
        emissiveMap: this.texture,
        emissiveIntensity: 1.05,
        roughness: 1, // matter Bildschirm: Licht wird breit gestreut statt gespiegelt
        metalness: 0,
      }),
    );
    this.screenMesh.position.z = 0.031;
    this.group.add(this.screenMesh);

    // Status-LED unten rechts am Rahmen
    const led = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.01, 0.005),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x3fff8a, emissiveIntensity: 5 }),
    );
    led.position.set(SCREEN_W / 2 - 0.02, -SCREEN_H / 2 - 0.028, 0.031);
    this.group.add(led);

    // Kaltes Bildschirmlicht auf Wand, Boden und Spieler
    const glow = new THREE.PointLight(0x5cbfff, 2.2, 4.5, 2);
    glow.position.z = 0.4;
    this.group.add(glow);

    // Mit Rückseite an die Wand (Mittelpunkt 3cm vor der Wandfläche)
    this.group.position.copy(this.center).addScaledVector(this.normal, 0.03);
    this.group.lookAt(this.group.position.clone().add(this.normal));
    this.group.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(bezel);
    this.collider = { type: 'box', min: box.min.clone(), max: box.max.clone() };

    this.draw();
  }

  /** Standpunkt + Blick, bei dem der Bildschirm das Kamerabild ausfüllt */
  focusTarget(aspect: number, cameraDrop: number, cameraForward: number): FocusTarget {
    const halfV = THREE.MathUtils.degToRad(MENU_FOV / 2);
    const halfH = Math.atan(Math.tan(halfV) * aspect);
    const dV = SCREEN_H / 2 / 0.93 / Math.tan(halfV);
    const dH = SCREEN_W / 2 / 0.95 / Math.tan(halfH);
    const d = Math.max(dV, dH) + 0.03 + cameraForward;
    const eyeY = this.center.y + cameraDrop;
    return {
      x: this.center.x + this.normal.x * d,
      z: this.center.z + this.normal.z * d,
      yaw: Math.atan2(this.normal.x, this.normal.z),
      pitch: Math.atan2(this.center.y - (eyeY - cameraDrop), d),
      fov: MENU_FOV,
    };
  }

  enter(): void {
    this.active = true;
    this.ui.cursorVisible = true;
  }

  exit(): void {
    this.active = false;
    this.ui.cursorVisible = false;
    this.capturing = null;
    this.input.cancelCapture();
    this.onExit();
  }

  moveCursor(dx: number, dy: number): void {
    if (this.active) this.ui.moveCursor(dx * CURSOR_SPEED, dy * CURSOR_SPEED);
  }

  pointerDown(): void {
    if (this.active) this.ui.pointerDown();
  }

  pointerUp(): void {
    this.ui.pointerUp();
  }

  /** Abbruch der Tastenbelegung (z. B. wenn Pointer Lock verloren geht) */
  cancelCapture(): void {
    this.capturing = null;
    this.input.cancelCapture();
  }

  update(dt: number): void {
    this.time += dt;
    this.updateMatchmaking(dt);
    this.confirmReset = Math.max(0, this.confirmReset - dt);
    // Aktiv: jeden Frame zeichnen; Standby: 4x pro Sekunde (Uhr, Blinken)
    this.redrawTimer -= dt;
    if (this.active || this.redrawTimer <= 0) {
      this.redrawTimer = 0.25;
      this.draw();
    }
  }

  private updateMatchmaking(dt: number): void {
    if (this.mm !== 'searching') return;
    this.mmTime += dt;
    this.mmNext -= dt;
    const needed = MM_NEEDED[this.settings.data.mmMode];
    if (this.mmNext <= 0 && this.mmFound < needed) {
      this.mmFound++;
      this.mmNext = 0.4 + Math.random() * 2.2;
    }
    if (this.mmFound >= needed && this.mmTime > 2) this.mm = 'found';
  }

  private draw(): void {
    const ui = this.ui;
    const c = ui.ctx;
    const d = this.settings.data;

    // Hintergrund mit feinem Raster
    ui.rect(0, 0, CANVAS_W, CANVAS_H, THEME.bg);
    c.strokeStyle = 'rgba(63,196,255,0.05)';
    c.lineWidth = 1;
    for (let x = 0; x < CANVAS_W; x += 40) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, CANVAS_H);
      c.stroke();
    }
    for (let y = 0; y < CANVAS_H; y += 40) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(CANVAS_W, y);
      c.stroke();
    }

    // Kopfzeile
    ui.rect(0, 0, CANVAS_W, 70, '#08161c');
    ui.rect(0, 70, CANVAS_W, 2, THEME.accent);
    ui.text('BC-TERMINAL', 32, 36, 28, THEME.accent, 'left', 'bold');
    ui.text('//  REVIER 7 · EINSATZZENTRALE', 250, 37, 20, THEME.dim);
    const now = new Date();
    const clock = now.toLocaleTimeString('de-DE');
    ui.text(clock, CANVAS_W - 32, 36, 24, THEME.text, 'right');

    // Navigation
    PAGES.forEach((p, i) => {
      if (ui.button(32, 100 + i * 64, 260, 54, p.label, { selected: this.page === p.id, align: 'left', size: 20 })) {
        this.page = p.id;
        this.cancelCapture();
      }
    });
    if (ui.button(32, CANVAS_H - 130, 260, 54, 'ZURÜCK INS SPIEL', { primary: true, size: 20 })) {
      this.exit();
    }

    // Inhalt
    const x = 330;
    const w = CANVAS_W - x - 32;
    switch (this.page) {
      case 'match':
        this.drawMatch(x, w);
        break;
      case 'keys':
        this.drawKeys(x, w);
        break;
      case 'mouse': {
        ui.text('MAUS & KAMERA', x, 112, 30, THEME.text, 'left', 'bold');
        const sens = ui.slider('sens', x, 150, w, 'Mausempfindlichkeit', d.mouseSensitivity, 0.2, 3, 0.05, (v) => v.toFixed(2));
        this.settings.set('mouseSensitivity', sens);
        this.settings.set('invertY', ui.toggle(x, 210, w, 'Y-Achse invertieren', d.invertY));
        this.settings.set('fov', ui.slider('fov', x, 270, w, 'Sichtfeld (FOV)', d.fov, 60, 100, 1, (v) => `${v}°`));
        this.settings.set('cameraShake', ui.slider('shake', x, 330, w, 'Kamera-Wackeln', d.cameraShake, 0, 1.5, 0.05, pct));
        ui.text('Kamera-Wackeln skaliert Kopfwippen, Neigung und Erschütterungen.', x, 410, 18, THEME.dim);
        break;
      }
      case 'graphics':
        this.drawGraphics(x, w);
        break;
      case 'bodycam':
        this.drawBodycam(x, w);
        break;
      case 'system':
        this.drawSystem(x, w);
        break;
    }

    // Fußzeile
    ui.rect(0, CANVAS_H - 44, CANVAS_W, 44, '#08161c');
    const exitKey = keyLabel(d.bindings.interact);
    ui.text(`[${exitKey}] Verlassen   ·   Maus: Cursor bewegen   ·   Klick: Auswählen`, 32, CANVAS_H - 22, 18, THEME.dim);
    ui.text('v0.1 · Blockout', CANVAS_W - 32, CANVAS_H - 22, 18, THEME.dim, 'right');

    // Standby-Hinweis, wenn niemand am Terminal steht
    if (!this.active) {
      const a = 0.55 + Math.sin(this.time * 3) * 0.25;
      c.fillStyle = `rgba(6,16,21,0.6)`;
      c.fillRect(0, 72, CANVAS_W, CANVAS_H - 116);
      ui.text(`[${exitKey}] TERMINAL BENUTZEN`, CANVAS_W / 2, CANVAS_H / 2, 44, `rgba(63,196,255,${a})`, 'center', 'bold');
    }

    ui.drawCursor();
    ui.endFrame();
    this.texture.needsUpdate = true;
  }

  private drawMatch(x: number, w: number): void {
    const ui = this.ui;
    const d = this.settings.data;
    ui.text('MATCHMAKING', x, 112, 30, THEME.text, 'left', 'bold');
    ui.text('Offline-Prototyp: noch kein Server angebunden — die Suche wird simuliert.', x, 148, 17, THEME.warn);

    const locked = this.mm !== 'idle';
    const mode = ui.select(x, 175, w, 'Spielmodus', MM_MODES, d.mmMode);
    const region = ui.select(x, 235, w, 'Region', MM_REGIONS, d.mmRegion);
    const party = ui.select(x, 295, w, 'Gruppe', MM_PARTY, d.mmParty);
    if (!locked) {
      this.settings.set('mmMode', mode);
      this.settings.set('mmRegion', region);
      this.settings.set('mmParty', party);
    }

    const py = 375;
    ui.rect(x, py, w, 220, THEME.panel, THEME.line);
    const needed = MM_NEEDED[d.mmMode];
    if (this.mm === 'idle') {
      ui.text('BEREIT', x + 30, py + 45, 26, THEME.text, 'left', 'bold');
      ui.text(`${MM_MODES[d.mmMode]} · ${MM_REGIONS[d.mmRegion]} · ${MM_PARTY[d.mmParty]} · ${needed} Spieler`, x + 30, py + 85, 19, THEME.dim);
      if (ui.button(x + 30, py + 130, 320, 60, 'SUCHE STARTEN', { primary: true })) {
        this.mm = 'searching';
        this.mmTime = 0;
        this.mmFound = Math.min(needed, MM_PARTY_SIZE[d.mmParty]);
        this.mmNext = 0.5;
      }
    } else {
      const secs = Math.floor(this.mmTime);
      const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (this.mm === 'searching') {
        const dots = '.'.repeat(1 + (Math.floor(this.time * 2) % 3));
        ui.text(`SUCHE LÄUFT${dots}`, x + 30, py + 45, 26, THEME.accent, 'left', 'bold');
      } else {
        ui.text('MATCH GEFUNDEN', x + 30, py + 45, 26, THEME.ok, 'left', 'bold');
      }
      ui.text(time, x + w - 30, py + 45, 26, THEME.text, 'right');
      // Spieler-Slots
      const slotW = Math.min(52, (w - 60) / needed - 8);
      for (let i = 0; i < needed; i++) {
        ui.rect(x + 30 + i * (slotW + 8), py + 80, slotW, 30, i < this.mmFound ? THEME.accent : THEME.line);
      }
      ui.text(`${this.mmFound} / ${needed} Spieler`, x + 30, py + 132, 19, THEME.dim);
      if (this.mm === 'found') {
        ui.text('Server-Anbindung folgt — Simulation beendet.', x + 300, py + 132, 19, THEME.warn);
        if (ui.button(x + 30, py + 155, 240, 50, 'OK', { primary: true })) this.mm = 'idle';
      } else if (ui.button(x + 30, py + 155, 240, 50, 'ABBRECHEN', { primary: true, danger: true })) {
        this.mm = 'idle';
      }
    }
  }

  private drawKeys(x: number, w: number): void {
    const ui = this.ui;
    const b = this.settings.data.bindings;
    ui.text('TASTENBELEGUNG', x, 112, 30, THEME.text, 'left', 'bold');
    ui.text('Zeile anklicken, dann neue Taste (oder Maustaste) drücken. Doppelte Belegungen werden getauscht.', x, 145, 17, THEME.dim);
    const colW = (w - 16) / 2;
    const rowH = 56;
    ACTIONS.forEach((a, i) => {
      const cx = x + (i % 2) * (colW + 16);
      const cy = 170 + Math.floor(i / 2) * rowH;
      const waiting = this.capturing === a;
      if (ui.button(cx, cy, colW, 48, ACTION_LABELS[a], { align: 'left', selected: waiting, size: 20 })) {
        this.capturing = a;
        this.input.capture((code) => {
          this.settings.setBinding(a, code);
          this.capturing = null;
        });
      }
      const label = waiting ? 'Taste…' : keyLabel(b[a]);
      const kw = 130;
      ui.rect(cx + colW - kw - 12, cy + 7, kw, 34, waiting ? THEME.warn : '#08161c', waiting ? undefined : THEME.accentDim);
      ui.text(label, cx + colW - kw / 2 - 12, cy + 25, 20, waiting ? THEME.bg : THEME.accent, 'center', 'bold');
    });
    const resetY = 170 + Math.ceil(ACTIONS.length / 2) * rowH + 4;
    if (ui.button(x, resetY, 340, 52, 'STANDARD WIEDERHERSTELLEN', { size: 19 })) {
      this.cancelCapture();
      this.settings.resetBindings();
    }
    if (this.capturing) ui.text('Esc bricht ab (gibt auch die Maus frei).', x + 370, resetY + 27, 17, THEME.warn);
  }

  private drawGraphics(x: number, w: number): void {
    const ui = this.ui;
    const d = this.settings.data;
    ui.text('GRAFIK', x, 112, 30, THEME.text, 'left', 'bold');
    // Preset-Auswahl: "Benutzerdefiniert" ist nur Anzeige, Weiterklicken springt zu den Presets
    const presets = QUALITY_LABELS.length - 1;
    // zwei Spalten (17 Optionen), kurze Beschriftungen
    const cw = (w - 16) / 2;
    const x2 = x + cw + 16;
    const y = (i: number) => 140 + i * 52;
    const q = ui.select(x, y(0), cw, 'Qualität', QUALITY_LABELS, d.quality);
    if (q !== d.quality) this.settings.applyQuality(q >= presets ? (d.quality === 0 ? presets - 1 : 0) : q);
    this.settings.set('shadows', ui.select(x, y(1), cw, 'Schatten', SHADOW_LABELS, d.shadows));
    this.settings.set('renderScale', ui.slider('scale', x, y(2), cw, 'Auflösung', d.renderScale, 0.5, 1.5, 0.25, pct));
    this.settings.set('bloom', ui.toggle(x, y(3), cw, 'Bloom', d.bloom));
    this.settings.set('bloomStrength', ui.slider('bloomStr', x, y(4), cw, 'Bloom-Stärke', d.bloomStrength, 0, 2, 0.05, pct));
    this.settings.set('brightness', ui.slider('bright', x, y(5), cw, 'Helligkeit', d.brightness, 0.5, 1.6, 0.05, pct));
    this.settings.set('fogEnabled', ui.toggle(x, y(6), cw, 'Nebel', d.fogEnabled));
    this.settings.set('godRays', ui.slider('godRays', x, y(7), cw, 'God-Rays', d.godRays, 0, 2, 0.05, pct));
    this.settings.set('antialias', ui.select(x, y(8), cw, 'Kantenglättung', AA_LABELS, d.antialias));
    const vs = this.settings.viewScale;
    this.settings.set('viewDistance', ui.slider('view', x2, y(0), cw, 'Sichtweite', d.viewDistance, 5, 60, 1, (v) => `${Math.round(v * vs)} m`));
    this.settings.set('reflections', ui.select(x2, y(1), cw, 'Spiegelungen', REFLECTION_LABELS, d.reflections));
    this.settings.set('volumetrics', ui.select(x2, y(2), cw, 'Volumetrik', VOLUMETRIC_LABELS, d.volumetrics));
    this.settings.set('terrainDetail', ui.select(x2, y(3), cw, 'Terrain', TERRAIN_LABELS, d.terrainDetail));
    this.settings.set('foliageDensity', ui.select(x2, y(4), cw, 'Foliage-Dichte', FOLIAGE_LABELS, d.foliageDensity));
    this.settings.set('foliageDistance', ui.select(x2, y(5), cw, 'Foliage-Weite', FOLIAGE_LABELS, d.foliageDistance));
    this.settings.set('grass', ui.toggle(x2, y(6), cw, 'Gras', d.grass));
    this.settings.set('ao', ui.select(x2, y(7), cw, 'Kontaktschatten', AO_LABELS, d.ao));
    ui.text('Auflösung bezieht sich auf die Pixeldichte des Displays (max. 2x).', x, y(9) + 14, 17, THEME.dim);
    ui.text('Foliage-Dichte dünnt nur Deko ohne Kollision und Sichtschutz aus (z. B. Grasbüschel).', x, y(9) + 40, 17, THEME.dim);
  }

  private drawBodycam(x: number, w: number): void {
    const ui = this.ui;
    const d = this.settings.data;
    const s = this.settings;
    ui.text('BODYCAM-EFFEKT', x, 112, 30, THEME.text, 'left', 'bold');
    const bw = (w - 16) / 2;
    if (ui.button(x, 140, bw, 50, 'IMMERSIV', { size: 20 })) {
      s.set('lensDistortion', 1);
      s.set('grain', 1);
      s.set('aberration', 1);
      s.set('vignette', 1);
      s.set('cameraShake', 1);
      s.set('motionBlur', 0.5);
    }
    if (ui.button(x + bw + 16, 140, bw, 50, 'KOMPETITIV', { size: 20 })) {
      s.set('lensDistortion', 0.3);
      s.set('grain', 0.3);
      s.set('aberration', 0.2);
      s.set('vignette', 0.4);
      s.set('cameraShake', 0.4);
      s.set('motionBlur', 0);
    }
    s.set('lensDistortion', ui.slider('dist', x, 206, w, 'Linsenverzerrung', d.lensDistortion, 0, 1.5, 0.05, pct));
    s.set('grain', ui.slider('grain', x, 262, w, 'Sensorrauschen', d.grain, 0, 2, 0.05, pct));
    s.set('aberration', ui.slider('ab', x, 318, w, 'Chromatische Aberration', d.aberration, 0, 2, 0.05, pct));
    s.set('vignette', ui.slider('vig', x, 374, w, 'Vignette', d.vignette, 0, 1.5, 0.05, pct));
    s.set('motionBlur', ui.slider('mblur', x, 430, w, 'Bewegungsunschärfe', d.motionBlur, 0, 1, 0.05, pct));
    s.set('hudOverlay', ui.toggle(x, 486, bw, 'REC-Overlay', d.hudOverlay));
    s.set('autoExposure', ui.toggle(x + bw + 16, 486, bw, 'Belichtungsautomatik', d.autoExposure));
    ui.text('Kompetitiv reduziert Effekte für bessere Sicht; Immersiv ist der volle Bodycam-Look.', x, 566, 17, THEME.dim);
  }

  private drawSystem(x: number, w: number): void {
    const ui = this.ui;
    ui.text('SYSTEM', x, 112, 30, THEME.text, 'left', 'bold');
    const label = this.confirmReset > 0 ? 'WIRKLICH ZURÜCKSETZEN?' : 'ALLE EINSTELLUNGEN ZURÜCKSETZEN';
    if (ui.button(x, 150, Math.min(w, 520), 56, label, { primary: this.confirmReset > 0, danger: true, size: 20 })) {
      if (this.confirmReset > 0) {
        this.settings.resetAll();
        this.confirmReset = 0;
      } else {
        this.confirmReset = 3;
      }
    }
    const lines = [
      'BodyCam — Blockout-Prototyp v0.1',
      'Einstellungen werden lokal im Browser gespeichert.',
      `Renderer: three.js r${THREE.REVISION}`,
      `Bildschirm: ${window.innerWidth} x ${window.innerHeight} @ ${window.devicePixelRatio.toFixed(2)}x`,
    ];
    lines.forEach((l, i) => ui.text(l, x, 260 + i * 34, 19, i === 0 ? THEME.text : THEME.dim));
  }
}
