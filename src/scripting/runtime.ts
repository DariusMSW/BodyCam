import * as THREE from 'three';
import type { Collider } from '../world/collision.ts';
import { SCALE } from '../world/collision.ts';
import { refreshColliders, type MapNode } from '../world/mapLoader.ts';
import { isWeatherType, type WeatherType } from '../world/weather.ts';
import { playFile, playSound, startLoop, type SoundLoop } from '../audio/scriptSounds.ts';

// Script-Runtime für Map-Objekte. Die Blöcke aus dem Editor werden zu JavaScript übersetzt
// (scripting/blocks.ts), das hier gegen eine kleine API pro Objekt läuft:
//   api.on('start', async () => { await api.glideBy(0, 2, 0, 1); ... });
// Wie in Scratch geben Schleifen pro Durchlauf einen Frame ab (api.frame()), damit nichts einfriert.

export type ScriptEvent = 'start' | 'tick' | 'interact' | 'partInteract' | 'hit' | 'enter' | 'leave' | 'near' | 'key' | 'message';

export interface RuntimeHost {
  /** Fußposition des Spielers (bzw. der Editor-Kamera beim Simulieren) */
  playerPosition(): THREE.Vector3;
  teleportPlayer(feet: THREE.Vector3, yawDeg?: number): void;
  showMessage(text: string, seconds: number): void;
  keyDown(code: string): boolean;
  /** Wetter wechseln (weich überblendet) */
  setWeather?(type: WeatherType, intensity: number): void;
  log?(msg: string, isError: boolean): void;
  /** Jede Nachricht (auch an Bildschirme weiterreichen) */
  onBroadcast?(msg: string): void;
}

interface Handler {
  event: ScriptEvent;
  fn: () => Promise<void>;
  arg?: string | number;
  /** für 'partInteract': Name des Modell-Teils */
  part?: string;
  running: number;
  /** für 'near': war der Spieler zuletzt in Reichweite? */
  inside?: boolean;
}

interface Waiter {
  until: number; // Spielzeit
  resolve: () => void;
}

interface Tween {
  node: MapNode;
  kind: 'pos' | 'rot';
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  duration: number;
  resolve: () => void;
}

type Axis = 'x' | 'y' | 'z';

/** Ein benanntes Teil eines 3D-Modells (Knoten im glb), das ein Script bewegt */
interface PartState {
  obj: THREE.Object3D;
  basePos: THREE.Vector3;
  baseQuat: THREE.Quaternion;
  /** Drehung gegenüber der Ruhelage in Grad (Reihenfolge Y, X, Z) */
  ang: THREE.Vector3;
  /** Verschiebung gegenüber der Ruhelage in Metern */
  off: THREE.Vector3;
  /** Dauerdrehung in Grad pro Sekunde */
  spin: THREE.Vector3;
  ownMaterials: boolean;
}

interface PartTween {
  part: PartState;
  kind: 'ang' | 'off';
  axis?: Axis;
  from: THREE.Vector3;
  to: THREE.Vector3;
  start: number;
  duration: number;
  resolve: () => void;
}

/** Hörweite der Script-Klänge in Metern */
const SOUND_RANGE = 45;

class StopScript extends Error {}

const DEG = THREE.MathUtils.DEG2RAD;

interface ObjectScript {
  node: MapNode;
  handlers: Handler[];
  playerInside: boolean;
  /** Objekt hat eigene (geklonte) Materialien für Farbänderungen */
  ownMaterials: boolean;
  parts: Map<string, PartState | null>;
  /** Dauerklänge: Kennung → Klang + eingestellte Lautstärke (0..1) */
  loops: Map<string, { loop: SoundLoop; volume: number }>;
}

export class ScriptRuntime {
  time = 0;
  private scripts: ObjectScript[] = [];
  private byNode = new Map<MapNode, ObjectScript>();
  private frameWaiters: (() => void)[] = [];
  private timers: Waiter[] = [];
  private tweens: Tween[] = [];
  private partTweens: PartTween[] = [];
  private spinning = new Set<PartState>();
  private dt = 0;
  private euler = new THREE.Euler();
  private quat = new THREE.Quaternion();
  private dirty = new Set<MapNode>();
  private running = false;
  private box = new THREE.Box3();
  private nodesByName = new Map<string, MapNode>();

  constructor(
    private nodes: MapNode[],
    private colliders: Collider[],
    private host: RuntimeHost,
  ) {}

  /** Scripts kompilieren und 'start' auslösen */
  start(): void {
    this.running = true;
    for (const n of this.nodes) this.nodesByName.set(n.data.name, n);
    for (const node of this.nodes) {
      const code = node.data.script?.code;
      if (!code?.trim()) continue;
      const script: ObjectScript = { node, handlers: [], playerInside: false, ownMaterials: false, parts: new Map(), loops: new Map() };
      const api = this.makeApi(script);
      try {
        new Function('api', `"use strict";\n${code}`)(api);
      } catch (e) {
        this.report(node, e);
        continue;
      }
      if (script.handlers.length) {
        this.scripts.push(script);
        this.byNode.set(node, script);
      }
    }
    this.fireAll('start');
  }

  stop(): void {
    this.running = false;
    for (const s of this.scripts) {
      for (const l of s.loops.values()) l.loop.stop();
      s.loops.clear();
    }
    this.partTweens = [];
    this.spinning.clear();
    this.scripts = [];
    this.byNode.clear();
    this.frameWaiters = [];
    this.timers = [];
    this.tweens = [];
  }

  get hasScripts(): boolean {
    return this.scripts.length > 0;
  }

  update(dt: number): void {
    if (!this.running) return;
    this.time += dt;
    this.dt = dt;
    const t = this.time;

    // Modell-Teile: Tweens und Dauerdrehung
    for (let i = this.partTweens.length - 1; i >= 0; i--) {
      const tw = this.partTweens[i];
      const k = tw.duration <= 0 ? 1 : Math.min(1, (t - tw.start) / tw.duration);
      const e = k * k * (3 - 2 * k);
      if (tw.kind === 'off') tw.part.off.lerpVectors(tw.from, tw.to, e);
      else if (tw.axis) tw.part.ang[tw.axis] = THREE.MathUtils.lerp(tw.from[tw.axis], tw.to[tw.axis], e);
      else tw.part.ang.lerpVectors(tw.from, tw.to, e);
      this.applyPart(tw.part);
      if (k >= 1) {
        this.partTweens.splice(i, 1);
        tw.resolve();
      }
    }
    for (const p of this.spinning) {
      p.ang.x = (p.ang.x + p.spin.x * dt) % 360;
      p.ang.y = (p.ang.y + p.spin.y * dt) % 360;
      p.ang.z = (p.ang.z + p.spin.z * dt) % 360;
      this.applyPart(p);
    }

    // Tweens (gleiten / drehen über Zeit)
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      const k = tw.duration <= 0 ? 1 : Math.min(1, (t - tw.start) / tw.duration);
      const e = k * k * (3 - 2 * k);
      if (tw.kind === 'pos') tw.node.root.position.lerpVectors(tw.from, tw.to, e);
      else {
        const r = tw.from.clone().lerp(tw.to, e).multiplyScalar(DEG);
        tw.node.root.rotation.set(r.x, r.y, r.z);
      }
      this.dirty.add(tw.node);
      if (k >= 1) {
        this.tweens.splice(i, 1);
        tw.resolve();
      }
    }

    // Wartende Coroutinen fortsetzen
    const frames = this.frameWaiters;
    this.frameWaiters = [];
    for (const r of frames) r();
    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.timers[i].until <= t) {
        const w = this.timers[i];
        this.timers.splice(i, 1);
        w.resolve();
      }
    }

    // Spieler-bezogene Ereignisse
    const player = this.host.playerPosition();
    const body = player.clone();
    body.y += SCALE.playerHeight / 2;
    for (const s of this.scripts) {
      // Dauerklänge werden mit der Entfernung leiser
      if (s.loops.size) {
        const k = this.hearing(s.node);
        for (const l of s.loops.values()) l.loop.setVolume(l.volume * k);
      }
      let hasTrigger = false;
      for (const h of s.handlers) {
        if (h.event === 'tick' && h.running === 0) this.run(s, h);
        else if (h.event === 'enter' || h.event === 'leave') hasTrigger = true;
        else if (h.event === 'near') {
          const inside = s.node.root.getWorldPosition(new THREE.Vector3()).distanceTo(body) < Number(h.arg ?? 3);
          if (inside && !h.inside) this.run(s, h);
          h.inside = inside;
        }
      }
      if (hasTrigger) {
        this.boundsOf(s.node);
        const inside = this.box.distanceToPoint(body) <= SCALE.playerRadius;
        if (inside !== s.playerInside) {
          s.playerInside = inside;
          this.fire(s, inside ? 'enter' : 'leave');
        }
      }
    }

    // Kollision bewegter Objekte nachziehen
    for (const n of this.dirty) {
      n.root.updateMatrixWorld(true);
      refreshColliders(n, this.colliders);
    }
    this.dirty.clear();
  }

  // ---------- Ereignisse von außen ----------

  findNode(obj: THREE.Object3D | null): MapNode | null {
    for (let o = obj; o; o = o.parent) if (o.userData.mapNode) return o.userData.mapNode as MapNode;
    return null;
  }

  /** Text für die Benutzen-Anzeige, falls das Objekt ein 'interact'-Script hat */
  interactPrompt(node: MapNode | null, hit?: THREE.Object3D | null): string | null {
    const s = node && this.byNode.get(node);
    if (!s) return null;
    const h = this.partHandlers(s, hit)[0] ?? s.handlers.find((x) => x.event === 'interact');
    return h ? String(h.arg || 'Benutzen') : null;
  }

  /** `hit` = getroffenes Mesh: gehört es zu einem Teil mit eigenem „Wenn Spieler Teil … benutzt“, läuft nur das */
  interact(node: MapNode, hit?: THREE.Object3D | null): void {
    const s = this.byNode.get(node);
    if (!s) return;
    const parts = this.partHandlers(s, hit);
    if (parts.length) for (const h of parts) this.run(s, h);
    else this.fire(s, 'interact');
  }

  /** Handler des innersten Modell-Teils, zu dem das getroffene Mesh gehört */
  private partHandlers(s: ObjectScript, hit?: THREE.Object3D | null): Handler[] {
    if (!hit || !s.handlers.some((h) => h.event === 'partInteract')) return [];
    for (let o: THREE.Object3D | null = hit; o && o !== s.node.root; o = o.parent) {
      const name = o.name;
      if (!name) continue;
      const hs = s.handlers.filter((h) => h.event === 'partInteract' && h.part === name);
      if (hs.length) return hs;
    }
    return [];
  }

  hit(node: MapNode): void {
    const s = this.byNode.get(node);
    if (s) this.fire(s, 'hit');
  }

  keyPressed(code: string): void {
    for (const s of this.scripts) for (const h of s.handlers) if (h.event === 'key' && h.arg === code) this.run(s, h);
  }

  /** Objekt per Name zeigen/verstecken (für Bildschirm-Scripts) */
  setObjectVisible(name: string, show: boolean): void {
    const n = this.nodesByName.get(String(name));
    if (n) n.root.visible = !!show;
  }

  broadcast(msg: string): void {
    this.host.onBroadcast?.(msg);
    for (const s of this.scripts) for (const h of s.handlers) if (h.event === 'message' && h.arg === msg) this.run(s, h);
  }

  // ---------- intern ----------

  private fireAll(event: ScriptEvent): void {
    for (const s of this.scripts) this.fire(s, event);
  }

  private fire(s: ObjectScript, event: ScriptEvent): void {
    for (const h of s.handlers) if (h.event === event) this.run(s, h);
  }

  private run(s: ObjectScript, h: Handler): void {
    if (!this.running) return;
    h.running++;
    h.fn()
      .catch((e) => {
        if (!(e instanceof StopScript)) this.report(s.node, e);
      })
      .finally(() => h.running--);
  }

  private report(node: MapNode, e: unknown): void {
    const msg = `Script-Fehler in "${node.data.name}": ${e instanceof Error ? e.message : String(e)}`;
    console.warn(msg, e);
    this.host.log?.(msg, true);
  }

  private boundsOf(node: MapNode): THREE.Box3 {
    node.root.updateMatrixWorld(true);
    if (node.data.type === 'trigger') {
      return this.box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(node.root.matrixWorld);
    }
    this.box.makeEmpty();
    if (node.instance) this.box.expandByObject(node.instance.object, true);
    if (this.box.isEmpty()) this.box.setFromCenterAndSize(node.root.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(1, 1, 1));
    return this.box;
  }

  /** Lautstärke-Faktor 0..1 nach Entfernung des Objekts zum Spieler */
  private hearing(node: MapNode): number {
    const d = node.root.getWorldPosition(new THREE.Vector3()).distanceTo(this.host.playerPosition());
    const k = Math.max(0, 1 - d / SOUND_RANGE);
    return k * k;
  }

  private applyPart(p: PartState): void {
    p.obj.position.copy(p.basePos).add(p.off);
    this.euler.set(p.ang.x * DEG, p.ang.y * DEG, p.ang.z * DEG, 'YXZ');
    p.obj.quaternion.copy(p.baseQuat).multiply(this.quat.setFromEuler(this.euler));
  }

  private partTween(part: PartState, kind: 'ang' | 'off', to: THREE.Vector3, sec: number, axis?: Axis): Promise<void> {
    this.partTweens = this.partTweens.filter((t) => {
      if (t.part === part && t.kind === kind && (!t.axis || !axis || t.axis === axis)) {
        t.resolve();
        return false;
      }
      return true;
    });
    const from = (kind === 'ang' ? part.ang : part.off).clone();
    if (!this.running) return new Promise(() => {});
    return new Promise((resolve) => this.partTweens.push({ part, kind, axis, from, to, start: this.time, duration: sec, resolve }));
  }

  private frame(): Promise<void> {
    if (!this.running) return new Promise(() => {});
    return new Promise((r) => this.frameWaiters.push(r));
  }

  private wait(sec: number): Promise<void> {
    if (!this.running) return new Promise(() => {});
    return new Promise((resolve) => this.timers.push({ until: this.time + Math.max(0, sec), resolve }));
  }

  private tween(node: MapNode, kind: 'pos' | 'rot', to: THREE.Vector3, sec: number): Promise<void> {
    // laufende Tweens derselben Art ersetzen
    this.tweens = this.tweens.filter((t) => {
      if (t.node === node && t.kind === kind) {
        t.resolve();
        return false;
      }
      return true;
    });
    const r = node.root;
    const from = kind === 'pos' ? r.position.clone() : new THREE.Vector3(r.rotation.x / DEG, r.rotation.y / DEG, r.rotation.z / DEG);
    return new Promise((resolve) => this.tweens.push({ node, kind, from, to, start: this.time, duration: sec, resolve }));
  }

  private makeApi(s: ObjectScript) {
    const node = s.node;
    const root = node.root;
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
    const moved = () => this.dirty.add(node);
    const materials = (): THREE.MeshStandardMaterial[] => {
      const meshes = node.instance?.colorables ?? [];
      if (!s.ownMaterials) {
        for (const m of meshes) {
          const mat = m.material as THREE.MeshStandardMaterial;
          if (mat.userData.shared) m.material = mat.clone();
        }
        s.ownMaterials = true;
      }
      return meshes.map((m) => m.material as THREE.MeshStandardMaterial).filter((m) => m.isMeshStandardMaterial);
    };
    const light = () => node.instance?.light;
    const fx = () => node.instance?.effect;
    const other = (name: string) => this.nodesByName.get(String(name)) ?? null;
    const axisOf = (a: unknown): Axis => (a === 'x' || a === 'z' ? a : 'y');
    /** Modell-Teil per Knotenname; unbekannte Namen werden einmal gemeldet */
    const part = (name: unknown): PartState | null => {
      const key = String(name);
      let p = s.parts.get(key);
      if (p === undefined) {
        const obj = node.instance?.object.getObjectByName(key) ?? null;
        p = obj
          ? { obj, basePos: obj.position.clone(), baseQuat: obj.quaternion.clone(), ang: new THREE.Vector3(), off: new THREE.Vector3(), spin: new THREE.Vector3(), ownMaterials: false }
          : null;
        if (!p) this.host.log?.(`[${node.data.name}] Teil "${key}" gibt es in diesem Modell nicht`, true);
        s.parts.set(key, p);
      }
      return p;
    };
    const partMaterials = (p: PartState): THREE.MeshStandardMaterial[] => {
      const out: THREE.MeshStandardMaterial[] = [];
      p.obj.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        if (!p.ownMaterials) m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) out.push(mat as THREE.MeshStandardMaterial);
      });
      p.ownMaterials = true;
      return out;
    };
    const vol = (v: unknown) => Math.min(2, Math.max(0, num(v) / 100));

    return {
      on: (event: ScriptEvent, fn: () => Promise<void>, arg?: string | number, part?: string) => {
        s.handlers.push({ event, fn, arg, part, running: 0 });
      },
      /** Sekunden seit dem letzten Frame (für gleichmäßige Bewegung in „Jeden Frame“) */
      dt: () => this.dt,
      // Modell-Teile (Knoten im glb): Türen, Räder, Hauben …
      partTurnTo: (name: unknown, axis: unknown, deg: unknown, sec: unknown) => {
        const p = part(name);
        if (!p) return Promise.resolve();
        const a = axisOf(axis);
        const to = p.ang.clone();
        to[a] = num(deg);
        return this.partTween(p, 'ang', to, num(sec), a);
      },
      partTurnBy: (name: unknown, axis: unknown, deg: unknown, sec: unknown) => {
        const p = part(name);
        if (!p) return Promise.resolve();
        const a = axisOf(axis);
        const to = p.ang.clone();
        to[a] += num(deg);
        return this.partTween(p, 'ang', to, num(sec), a);
      },
      partSetAngle: (name: unknown, axis: unknown, deg: unknown) => {
        const p = part(name);
        if (!p) return;
        p.ang[axisOf(axis)] = num(deg);
        this.applyPart(p);
      },
      partSpin: (name: unknown, axis: unknown, degPerSec: unknown) => {
        const p = part(name);
        if (!p) return;
        p.spin[axisOf(axis)] = num(degPerSec);
        if (p.spin.lengthSq() > 0) this.spinning.add(p);
        else this.spinning.delete(p);
      },
      partMoveTo: (name: unknown, x: unknown, y: unknown, z: unknown, sec: unknown) => {
        const p = part(name);
        return p ? this.partTween(p, 'off', new THREE.Vector3(num(x), num(y), num(z)), num(sec)) : Promise.resolve();
      },
      partReset: (name: unknown, sec: unknown) => {
        const p = part(name);
        if (!p) return Promise.resolve();
        p.spin.set(0, 0, 0);
        this.spinning.delete(p);
        return Promise.all([this.partTween(p, 'ang', new THREE.Vector3(), num(sec)), this.partTween(p, 'off', new THREE.Vector3(), num(sec))]).then(() => {});
      },
      partAngle: (name: unknown, axis: unknown) => part(name)?.ang[axisOf(axis)] ?? 0,
      partShow: (name: unknown, show: boolean) => {
        const p = part(name);
        if (p) p.obj.visible = !!show;
      },
      partColor: (name: unknown, c: string) => {
        const p = part(name);
        if (p) partMaterials(p).forEach((m) => m.color.set(c));
      },
      partGlow: (name: unknown, c: string, intensity: unknown) => {
        const p = part(name);
        if (p)
          partMaterials(p).forEach((m) => {
            m.emissive.set(c);
            m.emissiveIntensity = num(intensity);
          });
      },
      // Klang
      sound: (id: unknown, volume: unknown) => playSound(String(id), vol(volume) * this.hearing(node)),
      soundFile: (name: unknown, volume: unknown) => playFile(String(name), vol(volume) * this.hearing(node)),
      loopStart: (id: unknown, volume: unknown) => {
        const key = String(id);
        const v = vol(volume);
        const cur = s.loops.get(key);
        if (cur) {
          cur.volume = v;
          return;
        }
        const loop = startLoop(key, v * this.hearing(node));
        if (loop) s.loops.set(key, { loop, volume: v });
      },
      loopStop: (id: unknown) => {
        const key = String(id);
        s.loops.get(key)?.loop.stop();
        s.loops.delete(key);
      },
      loopPitch: (id: unknown, percent: unknown) => s.loops.get(String(id))?.loop.setPitch(num(percent) / 100),
      loopVolume: (id: unknown, volume: unknown) => {
        const l = s.loops.get(String(id));
        if (l) l.volume = vol(volume);
      },
      loopIsOn: (id: unknown) => s.loops.has(String(id)),
      frame: () => this.frame(),
      wait: (sec: unknown) => this.wait(num(sec)),
      stop: () => {
        throw new StopScript();
      },
      // Bewegung
      moveBy: (x: unknown, y: unknown, z: unknown) => {
        root.position.add(new THREE.Vector3(num(x), num(y), num(z)));
        moved();
      },
      moveTo: (x: unknown, y: unknown, z: unknown) => {
        root.position.set(num(x), num(y), num(z));
        moved();
      },
      moveForward: (d: unknown) => {
        root.translateZ(-num(d));
        moved();
      },
      glideTo: (x: unknown, y: unknown, z: unknown, sec: unknown) =>
        this.tween(node, 'pos', new THREE.Vector3(num(x), num(y), num(z)), num(sec)),
      glideBy: (x: unknown, y: unknown, z: unknown, sec: unknown) =>
        this.tween(node, 'pos', root.position.clone().add(new THREE.Vector3(num(x), num(y), num(z))), num(sec)),
      rotateBy: (x: unknown, y: unknown, z: unknown) => {
        root.rotation.set(root.rotation.x + num(x) * DEG, root.rotation.y + num(y) * DEG, root.rotation.z + num(z) * DEG);
        moved();
      },
      setRotation: (x: unknown, y: unknown, z: unknown) => {
        root.rotation.set(num(x) * DEG, num(y) * DEG, num(z) * DEG);
        moved();
      },
      turnBy: (x: unknown, y: unknown, z: unknown, sec: unknown) => {
        const r = root.rotation;
        return this.tween(node, 'rot', new THREE.Vector3(r.x / DEG + num(x), r.y / DEG + num(y), r.z / DEG + num(z)), num(sec));
      },
      setScale: (x: unknown, y: unknown, z: unknown) => {
        if (node.def.fixedScale || node.def.rebuildOnScale) return;
        root.scale.set(num(x) || 0.001, num(y) || 0.001, num(z) || 0.001);
        moved();
      },
      pos: (axis: 'x' | 'y' | 'z') => root.position[axis],
      rot: (axis: 'x' | 'y' | 'z') => root.rotation[axis] / DEG,
      // Aussehen
      show: () => (root.visible = true),
      hide: () => (root.visible = false),
      setColor: (c: string) => materials().forEach((m) => m.color.set(c)),
      setGlow: (c: string, intensity: unknown) =>
        materials().forEach((m) => {
          m.emissive.set(c);
          m.emissiveIntensity = num(intensity);
        }),
      setCollision: (on: boolean) => {
        node.collisionEnabled = !!on;
        moved();
      },
      // Licht
      lightSet: (mode: 'on' | 'off' | 'toggle') => {
        const l = light();
        if (l) l.setOn(mode === 'toggle' ? !l.isOn() : mode === 'on');
      },
      lightIntensity: (v: unknown) => light()?.setIntensity(num(v)),
      lightChangeIntensity: (v: unknown) => {
        const l = light();
        if (l) l.setIntensity(l.getIntensity() + num(v));
      },
      lightColor: (c: string) => light()?.setColor(c),
      lightFlicker: (on: boolean) => light()?.setFlicker(!!on),
      lightIsOn: () => light()?.isOn() ?? false,
      // Effekte (Feuer, Rauch, Funken)
      fxSet: (mode: 'on' | 'off' | 'toggle') => {
        const e = fx();
        if (e) e.setOn(mode === 'toggle' ? !e.on : mode === 'on');
      },
      fxIntensity: (v: unknown) => fx()?.setIntensity(Math.min(3, Math.max(0, num(v) / 100))),
      fxBurst: (v: unknown) => fx()?.burst(Math.min(5, Math.max(0, num(v)))),
      fxIsOn: () => fx()?.on ?? false,
      // Ereignisse & Welt
      broadcast: (msg: unknown) => this.broadcast(String(msg)),
      teleportPlayer: (x: unknown, y: unknown, z: unknown) => this.host.teleportPlayer(new THREE.Vector3(num(x), num(y), num(z))),
      showText: (text: unknown, sec: unknown) => this.host.showMessage(String(text), num(sec)),
      setWeather: (type: unknown, intensity: unknown) => {
        if (isWeatherType(type)) this.host.setWeather?.(type, THREE.MathUtils.clamp(num(intensity), 0, 2));
      },
      log: (v: unknown) => this.host.log?.(`[${node.data.name}] ${String(v)}`, false),
      // Fühlen
      distanceToPlayer: () => {
        const p = this.host.playerPosition().clone();
        p.y += SCALE.playerHeight / 2;
        return root.getWorldPosition(new THREE.Vector3()).distanceTo(p);
      },
      playerPos: (axis: 'x' | 'y' | 'z') => this.host.playerPosition()[axis],
      keyDown: (code: string) => this.host.keyDown(code),
      time: () => this.time,
      playerInside: () => s.playerInside,
      // andere Objekte
      objPos: (name: string, axis: 'x' | 'y' | 'z') => other(name)?.root.position[axis] ?? 0,
      objShow: (name: string, show: boolean) => {
        const n = other(name);
        if (n) n.root.visible = !!show;
      },
    };
  }
}
