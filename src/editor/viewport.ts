import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { EditorState } from './state.ts';
import type { AssetContext } from '../world/assets.ts';
import { Weather, isWeatherType } from '../world/weather.ts';
import { MapNode, WorldRig, applyTransform, buildInstance, computeColliders, createNode, nodeOf, readTransform } from '../world/mapLoader.ts';
import { ScriptRuntime } from '../scripting/runtime.ts';
import { ScreenRuntime } from '../scripting/screenRuntime.ts';
import { SCREEN_PX, defaultScreen } from '../world/screen.ts';
import type { ScreenSurface } from '../world/assets.ts';
import { SCALE, type Collider } from '../world/collision.ts';
import { findSun, sunWorld, writeSunToObject } from '../world/sun.ts';
import { findWeather, weatherWorld } from '../world/weatherObject.ts';
import { h } from './ui.ts';
import { volumeFX } from '../world/volumetrics.ts';
import { VolumePass } from '../rendering/volumePass.ts';
import { WaterPass, WaterSystem } from '../world/water/system.ts';
import type { ModeInput } from './modes/types.ts';
import { browserBlobs } from '../world/blobStore.ts';
import { updateLandscapes } from '../world/landscape/render.ts';
import { updateDeforms } from '../world/splines/deform.ts';
import { setFoliageRenderer, updateFoliage } from '../world/foliage/render.ts';
import { updateGrass } from '../world/foliage/grass.ts';
import { onBrushesUpdated, setBrushOrder } from '../world/brushes/manager.ts';

// 3D-Viewport des Editors: Navigation wie in UE5 (RMT + WASD fliegen, MMT schieben, Alt+LMT orbit,
// Mausrad vor/zurück), Gizmo (W/E/R), Auswahl mit Outline, Drag & Drop aus dem Content Browser.

export type GizmoMode = 'select' | 'translate' | 'rotate' | 'scale';
export type ViewMode = 'lit' | 'bright' | 'wire';

const CAMERA_SPEEDS = [0.5, 1, 2, 4, 7, 12, 20, 35, 60, 120, 250, 500];
const HELPER_LAYER = 1;
const EXPOSURE = 1.15;
const _feet = new THREE.Vector3();

interface Entry {
  node: MapNode;
  propsKey: string;
  scaleKey: string;
  xfKey: string;
}

interface Drag {
  mode: 'click' | 'fly' | 'pan' | 'orbit' | 'dolly';
  button: number;
  x: number;
  y: number;
  moved: number;
  pivot?: THREE.Vector3;
  orbitDist?: number;
  ctrl: boolean;
  shift: boolean;
}

export class Viewport {
  readonly container: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 4000);
  readonly ctx: AssetContext;

  mode: GizmoMode = 'translate';
  space: 'world' | 'local' = 'world';
  snap = { translate: true, translateStep: 0.5, rotate: true, rotateStep: 15, scale: false, scaleStep: 0.25 };
  viewMode: ViewMode = 'lit';
  showHelpers = true;
  showGrid = true;
  showFog = true;
  bloomEnabled = true;
  speedIndex = 3;
  showFps = false;

  onStatus?: (msg: string, error?: boolean) => void;
  onContextMenu?: (node: MapNode | null, x: number, y: number) => void;
  onSimulationChange?: () => void;

  private overlay = new THREE.Scene();
  private mapGroup = new THREE.Group();
  private entries = new Map<string, Entry>();
  private world: WorldRig;
  private weather: Weather;
  private water: WaterSystem;
  private fog = new THREE.Fog(0x000000, 1, 80);
  private grid = new THREE.Group();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private outline: OutlinePass;
  private gizmo: TransformControls;
  private pivot = new THREE.Object3D();
  private brightLight = new THREE.AmbientLight(0xffffff, 1.6);
  private selBoxes = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private timer = new THREE.Timer();
  private keys = new Set<string>();
  private yaw = 0;
  private pitch = -0.3;
  private drag: Drag | null = null;
  private altDown = false;
  private sunAdjust = false;
  private simSunQuat = new THREE.Quaternion();
  private simWeatherQuat = new THREE.Quaternion();
  private sunMoved = false;
  private gizmoMoved = false;
  private dragStart: { pivot: THREE.Matrix4; nodes: { node: MapNode; matrix: THREE.Matrix4 }[] } | null = null;
  private runtime: ScriptRuntime | null = null;
  /** Collider für die Partikel-Physik (Rauch an Decken, Funken an Wänden); im Editor ohne Physik-Welt gesammelt */
  private fxCollidersDirty = true;
  private fxColliderTimer = 0;
  /** Programmierbare Bildschirme während der Simulation */
  private screens: { node: MapNode; rt: ScreenRuntime; surf: ScreenSurface }[] = [];
  private screenHover: ScreenRuntime | null = null;
  private screenPress: ScreenRuntime | null = null;
  /** Eingaben des aktiven Editor-Modus (Landscape, Foliage …); null im Auswahl-Modus */
  modeInput: ModeInput | null = null;
  /** linke Maustaste gehört gerade dem Modus (Pinselstrich) */
  private modeStroke = false;
  private selectionEnabled = true;
  private simInfo: HTMLElement;
  private message: HTMLElement;
  private messageTimer = 0;
  private info: HTMLElement;
  private fpsEl: HTMLElement;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fpsWorst = 0;

  constructor(
    container: HTMLElement,
    private state: EditorState,
  ) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.autoClear = false;
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    container.append(canvas);
    this.ctx = { anisotropy: this.renderer.capabilities.getMaxAnisotropy(), editor: true, blobs: browserBlobs };

    this.camera.rotation.order = 'YXZ';
    this.camera.layers.enable(HELPER_LAYER);
    this.scene.add(this.camera, this.mapGroup);
    this.world = new WorldRig(state.map.world);
    this.scene.add(this.world.group);
    this.weather = new Weather(this.renderer, this.scene, this.world);
    // Wasser (Phase 6): Spiegelung in halber Qualität, Helfer und Wetter-Partikel fehlen darin
    this.water = new WaterSystem(this.renderer, this.scene, this.world, {
      sky: () => this.weather.skyColors,
      hidden: () => [...this.weather.passHidden, this.grid],
    });
    this.water.setReflectionQuality(1);
    setFoliageRenderer(this.renderer);

    // Raster: 1-m-Linien + 10-m-Linien
    const minor = new THREE.GridHelper(400, 400, 0x3a3a3a, 0x3a3a3a);
    const major = new THREE.GridHelper(400, 40, 0x6a6a6a, 0x5a5a5a);
    for (const g of [minor, major]) {
      const m = g.material as THREE.LineBasicMaterial;
      m.transparent = true;
      m.opacity = g === minor ? 0.22 : 0.4;
      m.depthWrite = false;
      g.position.y = 0.002;
      g.layers.set(HELPER_LAYER);
      g.userData.noPick = true;
      this.grid.add(g);
    }
    this.scene.add(this.grid);

    // Post-Processing: wie im Spiel (Bloom), dazu orange Auswahl-Outline wie in UE5
    // Tiefentextur für die Volumetrik (Nebel/Rauch/Feuer enden sauber an Geometrie)
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType) });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new WaterPass(this.scene, this.camera));
    this.composer.addPass(new VolumePass(this.scene, this.camera));
    volumeFX.setLamp(null);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.outline = new OutlinePass(new THREE.Vector2(1, 1), this.scene, this.camera);
    this.outline.visibleEdgeColor.set('#ffa500');
    this.outline.hiddenEdgeColor.set('#7a4f00');
    this.outline.edgeStrength = 4;
    this.outline.edgeThickness = 1;
    this.outline.edgeGlow = 0;
    this.composer.addPass(this.outline);
    this.composer.addPass(new OutputPass());

    // Gizmo + Auswahlboxen werden nach dem Post-Processing direkt darübergezeichnet
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.overlay.add(this.gizmo.getHelper(), this.pivot, this.selBoxes);
    this.gizmo.addEventListener('dragging-changed', (e) => this.onGizmoDrag(e.value as boolean));
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.applySnap();

    this.simInfo = h('div', { class: 'vp-sim hidden' }, h('span', {}, 'SIMULATION — Klick: Benutzen · Shift+Klick: Treffer · Esc: Stopp'));
    this.message = h('div', { class: 'vp-message hidden' });
    this.info = h('div', { class: 'vp-info' });
    this.fpsEl = h('div', { class: 'vp-fps hidden' });
    container.append(this.simInfo, this.message, this.info, this.fpsEl);

    this.bindInput(canvas);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    state.on('scene', () => {
      this.sync();
      this.fxCollidersDirty = true;
    });
    state.on('selection', () => {
      this.updateGizmo();
      this.updateSelectionVisuals();
    });
    state.on('world', () => {
      this.applyWorld();
      this.fxCollidersDirty = true;
    });
    // Geometry-Brushes: neue CSG-Ergebnisse → Kollision, Drahtgitter, Auswahl-Umriss nachziehen
    onBrushesUpdated(() => {
      this.fxCollidersDirty = true;
      if (this.viewMode === 'wire') this.setWire(this.mapGroup, true);
      this.updateSelectionVisuals();
    });
    state.on('transform', () => {
      this.fxCollidersDirty = true;
      this.updateSelectionVisuals();
      // Sonnen-Objekt gedreht → Sonnenstand live nachziehen
      const sun = findSun(this.state.map.objects);
      const wo = findWeather(this.state.map.objects);
      if ((sun && this.state.selection.includes(sun.id)) || (wo && this.state.selection.includes(wo.id))) this.applyWorld();
    });

    this.camera.position.set(0, 8, 14);
    this.applyCamera();
    this.renderer.setAnimationLoop(() => this.frameLoop());
  }

  // ---------- Szene abgleichen ----------

  /** Gleicht 3D-Szene mit den Map-Daten ab (nur Geändertes wird neu gebaut) */
  sync(): void {
    const objects = this.state.map.objects;
    setBrushOrder(objects.map((o) => o.id));
    const ids = new Set(objects.map((o) => o.id));
    for (const [id, e] of this.entries) {
      if (!ids.has(id)) {
        this.mapGroup.remove(e.node.root);
        e.node.instance?.dispose?.();
        this.entries.delete(id);
      }
    }
    for (const o of objects) {
      const propsKey = JSON.stringify([o.type, o.props, o.screen]);
      const scaleKey = o.scale.join(',');
      const xfKey = JSON.stringify([o.pos, o.rot, o.scale]);
      let e = this.entries.get(o.id);
      if (!e) {
        const node = createNode(o, this.ctx);
        this.mapGroup.add(node.root);
        e = { node, propsKey, scaleKey, xfKey };
        this.entries.set(o.id, e);
        this.prepareNode(node);
      } else {
        const node = e.node;
        node.data = o;
        let rebuild = e.propsKey !== propsKey || (node.def !== undefined && node.def.rebuildOnScale && e.scaleKey !== scaleKey);
        // Asset kann geänderte Eigenschaften selbst übernehmen (Landscape: Farben ohne Neuaufbau)
        if (rebuild && e.scaleKey === scaleKey && node.instance?.updateProps?.(o)) rebuild = false;
        if (e.xfKey !== xfKey) applyTransform(node);
        if (rebuild) {
          buildInstance(node, this.ctx);
          this.prepareNode(node);
        }
        e.propsKey = propsKey;
        e.scaleKey = scaleKey;
        e.xfKey = xfKey;
      }
      e.node.root.name = o.name;
      e.node.root.visible = !this.state.editorHidden.has(o.id);
    }
    this.updateGizmo();
    this.updateSelectionVisuals();
    this.applyWorld(); // Sonnen-Objekt kann sich geändert haben
  }

  private prepareNode(node: MapNode): void {
    node.instance?.helper?.traverse((c) => c.layers.set(HELPER_LAYER));
    if (this.viewMode === 'wire') this.setWire(node.root, true);
    node.instance?.ready?.then(() => {
      this.fxCollidersDirty = true;
      if (this.viewMode === 'wire') this.setWire(node.root, true);
      this.updateSelectionVisuals();
    });
  }

  /** Noch laufende asynchrone Ladevorgänge (Landscape-Höhen, Modelle) */
  pendingLoads(): Promise<void>[] {
    return [...this.entries.values()].map((e) => e.node.instance?.ready).filter((p): p is Promise<void> => !!p);
  }

  /** Shader aller Materialien vorab kompilieren, damit der erste Frame nicht hängt */
  async compileShaders(): Promise<void> {
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      console.warn('Shader-Vorkompilierung fehlgeschlagen', e);
    }
  }

  setShowFps(v: boolean): void {
    this.showFps = v;
    this.fpsEl.classList.toggle('hidden', !v);
    this.fpsFrames = this.fpsTime = this.fpsWorst = 0;
    this.fpsEl.textContent = '– FPS';
  }

  nodeById(id: string): MapNode | undefined {
    return this.entries.get(id)?.node;
  }

  private selectedNodes(): MapNode[] {
    return this.state.selection.map((id) => this.entries.get(id)?.node).filter((n): n is MapNode => !!n);
  }

  // ---------- Welt & Anzeige ----------

  applyWorld(): void {
    const w = this.state.map.world;
    const sun = findSun(this.state.map.objects);
    if (sun && this.runtime) {
      // Simulation: Scripts dürfen die Sonne drehen, die Map-Daten bleiben unverändert
      this.simSunQuat.copy(this.entries.get(sun.id)?.node.root.quaternion ?? this.simSunQuat);
      this.world.apply(sunWorld(w, sun, this.simSunQuat));
    } else {
      // Sonnen-Objekt ist maßgeblich; World Settings spiegeln seine Werte
      if (sun) Object.assign(w, sunWorld(w, sun));
      this.world.apply(w);
    }
    this.scene.background = new THREE.Color(w.background);
    this.fog.color.set(w.fogColor);
    this.fog.far = Math.max(80, w.viewDistance ?? 80);
    this.camera.far = Math.max(4000, this.fog.far * 1.5);
    this.camera.updateProjectionMatrix();
    this.scene.fog = this.showFog ? this.fog : null;
    this.world.setFog(this.showFog);
    this.renderer.toneMappingExposure = EXPOSURE * w.exposure;
    const wo = findWeather(this.state.map.objects);
    if (wo && this.runtime) {
      // Simulation: Scripts dürfen das Wetter-Objekt drehen (Wind), die Map-Daten bleiben unverändert
      this.simWeatherQuat.copy(this.entries.get(wo.id)?.node.root.quaternion ?? this.simWeatherQuat);
      this.weather.apply(weatherWorld(w, wo, this.simWeatherQuat));
    } else {
      // Wetter-Objekt ist maßgeblich; World Settings spiegeln seine Werte
      if (wo) Object.assign(w, weatherWorld(w, wo));
      this.weather.apply(w);
    }
  }

  setViewMode(m: ViewMode): void {
    if (this.viewMode === 'wire') this.setWire(this.mapGroup, false);
    this.viewMode = m;
    if (m === 'wire') this.setWire(this.mapGroup, true);
    if (m === 'bright') this.scene.add(this.brightLight);
    else this.scene.remove(this.brightLight);
  }

  private setWire(root: THREE.Object3D, on: boolean): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.editorHelper) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) (m as THREE.MeshStandardMaterial).wireframe = on;
      }
    });
  }

  setShowHelpers(on: boolean): void {
    this.showHelpers = on;
    if (on) this.camera.layers.enable(HELPER_LAYER);
    else this.camera.layers.disable(HELPER_LAYER);
    this.grid.visible = this.showGrid;
  }

  setShowGrid(on: boolean): void {
    this.showGrid = on;
    this.grid.visible = on;
  }

  setShowFog(on: boolean): void {
    this.showFog = on;
    this.applyWorld();
  }

  /** Sonne dorthin setzen, wohin die Kamera blickt */
  sunFromCamera(): void {
    const f = this.forward();
    const w = this.state.map.world;
    w.sunAzimuth = Math.round(THREE.MathUtils.radToDeg(Math.atan2(f.x, f.z)) * 10) / 10;
    w.sunElevation = Math.round(THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(Math.asin(f.y)), -89.5, 89.5) * 10) / 10;
    this.pushSunToObject();
    this.state.emit('world');
    this.state.commit();
  }

  /** Sonnenstand aus den World Settings ins Sonnen-Objekt übernehmen (Drehung) */
  private pushSunToObject(): void {
    const sun = findSun(this.state.map.objects);
    if (!sun) return;
    writeSunToObject(this.state.map.world, sun);
    const e = this.entries.get(sun.id);
    if (!e) return;
    applyTransform(e.node);
    e.xfKey = JSON.stringify([sun.pos, sun.rot, sun.scale]);
    this.updateGizmo();
    this.state.emit('transform');
  }

  /** Strg+L halten + Maus bewegen: Sonne drehen (wie in UE5) */
  private setSunAdjust(on: boolean): void {
    if (this.sunAdjust === on) return;
    this.sunAdjust = on;
    this.container.classList.toggle('sun-adjust', on);
    if (on) {
      this.sunMoved = false;
      this.onStatus?.('Sonne ausrichten: Maus bewegen, Strg+L loslassen zum Übernehmen');
    } else if (this.sunMoved) {
      this.state.commit();
      const w = this.state.map.world;
      this.onStatus?.(`Sonne: Richtung ${w.sunAzimuth}° · Höhe ${w.sunElevation}°`);
    }
  }

  setBloom(on: boolean): void {
    this.bloomEnabled = on;
    this.bloom.enabled = on;
  }

  setMode(m: GizmoMode): void {
    this.mode = m;
    this.updateGizmo();
  }

  setSpace(s: 'world' | 'local'): void {
    this.space = s;
    this.updateGizmo();
  }

  applySnap(): void {
    const s = this.snap;
    this.gizmo.setTranslationSnap(s.translate ? s.translateStep : null);
    this.gizmo.setRotationSnap(s.rotate ? THREE.MathUtils.degToRad(s.rotateStep) : null);
    this.gizmo.setScaleSnap(s.scale ? s.scaleStep : null);
  }

  get cameraSpeed(): number {
    return CAMERA_SPEEDS[this.speedIndex];
  }

  // ---------- Gizmo ----------

  /** Editor-Modus erlaubt Auswahl/Gizmo (Auswahl-Modus) oder übernimmt die linke Maustaste (Pinsel-Modi) */
  setSelectionEnabled(on: boolean): void {
    if (on === this.selectionEnabled) return;
    this.selectionEnabled = on;
    this.updateGizmo();
  }

  private updateGizmo(): void {
    if (this.dragStart) return;
    const nodes = this.selectedNodes().filter((n) => n.root.visible);
    const prim = nodes[nodes.length - 1];
    const scaleable = nodes.some((n) => !n.def.fixedScale);
    const rotatable = nodes.some((n) => !n.def.fixedRotation);
    if (!prim || !this.selectionEnabled || this.mode === 'select' || this.state.simulating || (this.mode === 'scale' && !scaleable) || (this.mode === 'rotate' && !rotatable)) {
      this.gizmo.detach();
      return;
    }
    this.pivot.position.copy(prim.root.position);
    this.pivot.quaternion.copy(prim.root.quaternion);
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.gizmo.attach(this.pivot);
    this.gizmo.setMode(this.mode);
    this.gizmo.setSpace(this.mode === 'scale' ? 'local' : this.space);
  }

  private onGizmoDrag(dragging: boolean): void {
    if (dragging) {
      this.gizmoMoved = false;
      // Alt + Ziehen: Auswahl duplizieren und die Kopien bewegen (wie in UE5)
      if (this.altDown && this.mode === 'translate') {
        const copies = this.state.duplicateSelected(false);
        if (copies.length) this.onStatus?.(`${copies.length} Objekt(e) dupliziert`);
      }
      this.pivot.updateMatrixWorld(true);
      this.dragStart = {
        pivot: this.pivot.matrixWorld.clone(),
        nodes: this.selectedNodes().map((node) => ({ node, matrix: node.root.matrixWorld.clone() })),
      };
    } else {
      this.dragStart = null;
      if (this.gizmoMoved) this.state.commit();
      this.updateGizmo();
    }
  }

  private onGizmoChange(): void {
    const ds = this.dragStart;
    if (!ds) return;
    this.gizmoMoved = true;
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(ds.pivot.clone().invert());
    const m = new THREE.Matrix4();
    for (const { node, matrix } of ds.nodes) {
      m.multiplyMatrices(delta, matrix);
      const oldScale = node.data.scale.join(',');
      m.decompose(node.root.position, node.root.quaternion, node.root.scale);
      if (node.def.fixedScale) node.root.scale.set(1, 1, 1);
      if (node.def.fixedRotation) node.root.quaternion.identity();
      node.root.updateMatrixWorld(true);
      readTransform(node);
      const e = this.entries.get(node.data.id);
      if (node.def.rebuildOnScale && node.data.scale.join(',') !== oldScale) {
        buildInstance(node, this.ctx);
        this.prepareNode(node);
      } else {
        node.instance?.onTransform?.(node.root);
      }
      if (e) {
        e.scaleKey = node.data.scale.join(',');
        e.xfKey = JSON.stringify([node.data.pos, node.data.rot, node.data.scale]);
        e.propsKey = JSON.stringify([node.data.type, node.data.props, node.data.screen]);
      }
    }
    this.state.emit('transform');
  }

  private updateSelectionVisuals(): void {
    const nodes = this.selectedNodes().filter((n) => n.root.visible);
    const meshes: THREE.Object3D[] = [];
    for (const c of [...this.selBoxes.children]) {
      this.selBoxes.remove(c);
      (c as THREE.Box3Helper).geometry.dispose();
    }
    for (const n of nodes) {
      let hasMesh = false;
      n.instance?.object.traverse((o) => {
        if ((o as THREE.Mesh).isMesh && !n.instance?.object.userData.noOutline) hasMesh = true;
      });
      if (hasMesh && n.instance) meshes.push(n.instance.object);
      else {
        const box = new THREE.Box3().setFromObject(n.root);
        if (box.isEmpty()) box.setFromCenterAndSize(n.root.position, new THREE.Vector3(0.5, 0.5, 0.5));
        const helper = new THREE.Box3Helper(box.expandByScalar(0.02), 0xffa500);
        (helper.material as THREE.LineBasicMaterial).toneMapped = false;
        this.selBoxes.add(helper);
      }
    }
    this.outline.selectedObjects = meshes;
  }

  // ---------- Kamera ----------

  private forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  private applyCamera(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  lookAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position).normalize();
    this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    this.yaw = Math.atan2(-d.x, -d.z);
    this.applyCamera();
  }

  /** Kamera auf Auswahl (F) bzw. ganze Map ausrichten */
  focus(ids: string[]): void {
    const box = new THREE.Box3();
    const nodes = ids.length ? ids.map((id) => this.entries.get(id)?.node).filter((n): n is MapNode => !!n) : [...this.entries.values()].map((e) => e.node);
    for (const n of nodes) {
      const b = new THREE.Box3().setFromObject(n.root);
      if (b.isEmpty()) b.setFromCenterAndSize(n.root.position, new THREE.Vector3(1, 1, 1));
      box.union(b);
    }
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(10, 2, 10));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 0.5);
    const dist = (r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * (ids.length ? 1.1 : 0.75);
    if (!ids.length) {
      this.yaw = Math.PI * 0.82;
      this.pitch = -0.6;
    }
    this.camera.position.copy(sphere.center).addScaledVector(this.forward(), -dist);
    this.applyCamera();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const hgt = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, hgt, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  // ---------- Eingabe ----------

  get isFlying(): boolean {
    return this.drag?.mode === 'fly';
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // vor TransformControls (Capture), damit Alt beim Gizmo-Start bekannt ist
    canvas.addEventListener('pointerdown', (e) => (this.altDown = e.altKey), { capture: true });
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      if (this.gizmo.dragging || (e.button === 0 && this.gizmo.axis !== null && this.gizmo.object)) return;
      if (e.button === 0 && !e.altKey && !this.runtime && this.modeInput?.pointerDown?.(e)) {
        this.modeStroke = true;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      if (this.runtime && e.button === 0 && !e.altKey) {
        const sc = this.screenAt(e.clientX, e.clientY);
        if (sc) {
          if (!sc.used) sc.enter();
          sc.pointerDown();
          this.screenPress = sc;
          canvas.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
      }
      let mode: Drag['mode'] = 'click';
      if (e.button === 2) mode = e.altKey ? 'dolly' : 'fly';
      else if (e.button === 1) mode = 'pan';
      else if (e.button === 0 && e.altKey) mode = 'orbit';
      this.drag = { mode, button: e.button, x: e.clientX, y: e.clientY, moved: 0, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      if (mode === 'orbit') {
        const sel = this.selectedNodes();
        const pivot = sel.length ? new THREE.Box3().setFromObject(sel[sel.length - 1].root).getCenter(new THREE.Vector3()) : this.camera.position.clone().addScaledVector(this.forward(), 10);
        this.drag.pivot = pivot;
        this.drag.orbitDist = pivot.distanceTo(this.camera.position);
      }
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.runtime && this.screens.length && (!this.drag || this.drag.mode === 'click')) this.hoverScreens(e.clientX, e.clientY);
      if (this.modeInput && !this.runtime && (this.modeStroke || !this.drag)) this.modeInput.pointerMove?.(e, this.modeStroke);
      const d = this.drag;
      if (!d) return;
      const dx = e.movementX;
      const dy = e.movementY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      const speed = this.cameraSpeed;
      if (d.mode === 'fly' || d.mode === 'orbit') {
        this.yaw -= dx * 0.0032;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0032, -1.55, 1.55);
        this.applyCamera();
        if (d.mode === 'orbit' && d.pivot) this.camera.position.copy(d.pivot).addScaledVector(this.forward(), -(d.orbitDist ?? 10));
      } else if (d.mode === 'pan') {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const k = 0.004 * speed + 0.004;
        this.camera.position.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else if (d.mode === 'dolly') {
        this.camera.position.addScaledVector(this.forward(), dx * 0.01 * speed);
      }
    });
    canvas.addEventListener('pointerleave', () => {
      if (!this.modeStroke) this.modeInput?.pointerLeave?.();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.modeStroke) {
        this.modeStroke = false;
        this.modeInput?.pointerUp?.(e);
        return;
      }
      if (this.screenPress) {
        this.screenPress.pointerUp();
        this.screenPress = null;
        return;
      }
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.moved < 4 && d.mode === 'click') {
        if (this.selectionEnabled || this.runtime) this.clickSelect(e, d);
      }
      else if (d.moved < 4 && d.mode === 'fly') {
        const node = this.pick(e.clientX, e.clientY);
        if (node && !this.state.selection.includes(node.data.id)) this.state.select([node.data.id]);
        this.onContextMenu?.(node, e.clientX, e.clientY);
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.isFlying && !this.runtime && this.modeInput?.wheel?.(e)) return;
      if (this.isFlying) {
        this.speedIndex = THREE.MathUtils.clamp(this.speedIndex + (e.deltaY < 0 ? 1 : -1), 0, CAMERA_SPEEDS.length - 1);
        this.onStatus?.(`Kamerageschwindigkeit ${this.speedIndex + 1} (${this.cameraSpeed} m/s)`);
      } else {
        this.camera.position.addScaledVector(this.forward(), -Math.sign(e.deltaY) * (0.4 + this.cameraSpeed * 0.35));
      }
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyL' && (e.ctrlKey || e.metaKey) && !this.runtime && !this.paused && !(e.target as HTMLElement).closest?.('input, select, textarea')) {
        e.preventDefault(); // sonst springt der Browser in die Adressleiste
        this.setSunAdjust(true);
      }
      this.keys.add(e.code);
      if (this.runtime && !e.repeat && document.activeElement === canvas) {
        this.runtime.keyPressed(e.code);
        for (const sc of this.screens) sc.rt.keyPressed(e.code);
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyL' || e.key === 'Control' || e.key === 'Meta') this.setSunAdjust(false);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.sunAdjust || (!e.movementX && !e.movementY)) return;
      const w = this.state.map.world;
      w.sunAzimuth = Math.round((((w.sunAzimuth + e.movementX * 0.25) % 360) + 360) % 360 * 10) / 10;
      w.sunElevation = Math.round(THREE.MathUtils.clamp(w.sunElevation - e.movementY * 0.25, -20, 89.5) * 10) / 10;
      this.sunMoved = true;
      this.pushSunToObject();
      this.state.emit('world');
    });
    window.addEventListener('blur', () => {
      this.setSunAdjust(false);
      this.keys.clear();
      this.drag = null;
    });
  }

  private clickSelect(e: PointerEvent, d: Drag): void {
    const node = this.pick(e.clientX, e.clientY);
    if (this.runtime) {
      if (node) {
        if (e.shiftKey) this.runtime.hit(node);
        else this.runtime.interact(node, this.pickedObject);
      }
      return;
    }
    if (!node) {
      if (!d.ctrl && !d.shift) this.state.select([]);
      return;
    }
    this.state.select([node.data.id], d.ctrl || d.shift ? 'toggle' : 'set');
  }

  private ndc(x: number, y: number): THREE.Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  }

  private pickable(o: THREE.Object3D): boolean {
    for (let c: THREE.Object3D | null = o; c && c !== this.mapGroup; c = c.parent) {
      if (!c.visible || c.userData.noPick) return false;
    }
    return true;
  }

  /** Bildschirm-Fläche unter dem Mauszeiger (Simulation), setzt dessen Cursor */
  private screenAt(x: number, y: number): ScreenRuntime | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    this.raycaster.layers.set(0);
    for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
      if (!this.pickable(hit.object) || !(hit.object as THREE.Mesh).isMesh) continue;
      const sc = hit.object.userData.screenSurface ? this.screens.find((s) => s.surf.mesh === hit.object) : undefined;
      if (!sc || !hit.uv || sc.node.data.props.control === 'none') return null;
      sc.rt.setCursorUV(hit.uv.x, hit.uv.y);
      return sc.rt;
    }
    return null;
  }

  private hoverScreens(x: number, y: number): void {
    const sc = this.screenAt(x, y);
    if (sc === this.screenHover) return;
    if (this.screenHover && this.screenHover !== this.screenPress) {
      this.screenHover.clearCursor();
      this.screenHover.exit();
    }
    this.screenHover = sc;
    this.renderer.domElement.style.cursor = sc ? 'pointer' : '';
  }

  /** Objekt unter dem Mauszeiger (inkl. Icons/Drahtgitter, wenn sichtbar) */
  /** Mesh des letzten pick()-Treffers (für Teil-Ereignisse beim Simulieren) */
  private pickedObject: THREE.Object3D | null = null;

  pick(x: number, y: number): MapNode | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    this.raycaster.layers.mask = this.camera.layers.mask;
    this.raycaster.params.Line.threshold = 0.06;
    for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
      if (this.pickable(hit.object)) {
        this.pickedObject = hit.object;
        return nodeOf(hit.object);
      }
    }
    this.pickedObject = null;
    return null;
  }

  /** Oberflächenpunkt für das Platzieren (nur echte Geometrie) */
  surfacePoint(x: number, y: number, exclude?: Set<string>): { point: THREE.Vector3; normal: THREE.Vector3 } {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    this.raycaster.layers.set(0);
    for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
      const node = nodeOf(hit.object);
      if (!node || exclude?.has(node.data.id) || !this.pickable(hit.object) || !(hit.object as THREE.Mesh).isMesh || !hit.face) continue;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      return { point: hit.point.clone(), normal };
    }
    const ray = this.raycaster.ray;
    const t = ray.direction.y < -0.02 ? -ray.origin.y / ray.direction.y : -1;
    if (t > 0 && t < 400) return { point: ray.at(t, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0) };
    return { point: ray.at(8, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0) };
  }

  /** Foliage: erste anklickbare Mesh-Fläche entlang eines Strahls (ohne Boden-Ersatz); skip = Objekt-IDs auslassen */
  castSurface(ray: THREE.Ray, far: number, skip?: (id: string, type: string) => boolean): { point: THREE.Vector3; normal: THREE.Vector3; id: string } | null {
    this.raycaster.ray.copy(ray);
    this.raycaster.near = 0;
    this.raycaster.far = far;
    this.raycaster.layers.set(0);
    const hits = this.raycaster.intersectObjects(this.mapGroup.children, true);
    this.raycaster.far = Infinity;
    for (const hit of hits) {
      const node = nodeOf(hit.object);
      if (!node || skip?.(node.data.id, node.data.type) || !this.pickable(hit.object) || !(hit.object as THREE.Mesh).isMesh || !hit.face) continue;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      return { point: hit.point.clone(), normal, id: node.data.id };
    }
    return null;
  }

  /** Setzt ein Objekt so auf eine Fläche, dass es aufliegt statt einzusinken */
  placeOnSurface(id: string, point: THREE.Vector3, normal: THREE.Vector3): void {
    const node = this.entries.get(id)?.node;
    if (!node?.instance) return;
    node.root.position.copy(point);
    node.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(node.instance.object);
    if (box.isEmpty()) {
      node.root.position.addScaledVector(normal, 0.4);
    } else {
      const a = Math.abs(normal.x) > Math.abs(normal.y) ? (Math.abs(normal.x) > Math.abs(normal.z) ? 'x' : 'z') : Math.abs(normal.y) > Math.abs(normal.z) ? 'y' : 'z';
      const n = normal[a];
      node.root.position[a] += n > 0 ? point[a] - box.min[a] : point[a] - box.max[a];
      if (this.snap.translate) {
        const s = this.snap.translateStep;
        for (const ax of ['x', 'y', 'z'] as const) if (ax !== a) node.root.position[ax] = Math.round(node.root.position[ax] / s) * s;
      }
    }
    if (node.data.type === 'spawn') node.root.position.y = point.y;
    node.root.updateMatrixWorld(true);
    readTransform(node);
    applyTransform(node);
    const e = this.entries.get(id)!;
    e.xfKey = JSON.stringify([node.data.pos, node.data.rot, node.data.scale]);
    this.state.emit('transform');
  }

  /** Punkt in der Bildmitte, auf dem neue Objekte landen */
  centerPoint(): { point: THREE.Vector3; normal: THREE.Vector3 } {
    const r = this.renderer.domElement.getBoundingClientRect();
    const hit = this.surfacePoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit.point.distanceTo(this.camera.position) > 40) hit.point.copy(this.camera.position).addScaledVector(this.forward(), 8);
    return hit;
  }

  /** Auswahl auf darunterliegende Fläche setzen (Ende-Taste) */
  snapToFloor(): number {
    let count = 0;
    const exclude = new Set(this.state.selection);
    for (const node of this.selectedNodes()) {
      if (!node.instance) continue;
      const box = new THREE.Box3().setFromObject(node.instance.object);
      if (box.isEmpty()) box.setFromCenterAndSize(node.root.position, new THREE.Vector3());
      const origin = box.getCenter(new THREE.Vector3());
      origin.y = box.min.y + 0.01;
      this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
      this.raycaster.layers.set(0);
      let ground = 0;
      for (const hit of this.raycaster.intersectObjects(this.mapGroup.children, true)) {
        const n = nodeOf(hit.object);
        if (!n || exclude.has(n.data.id) || !this.pickable(hit.object) || !(hit.object as THREE.Mesh).isMesh) continue;
        ground = hit.point.y;
        break;
      }
      if (ground > origin.y) ground = 0;
      node.root.position.y += ground - box.min.y;
      node.root.updateMatrixWorld(true);
      readTransform(node);
      count++;
    }
    if (count) this.state.update(() => {});
    return count;
  }

  // ---------- Simulieren ----------

  get simulating(): boolean {
    return this.runtime !== null;
  }

  startSimulation(): void {
    if (this.runtime) return;
    this.state.simulating = true;
    this.fxCollidersDirty = true;
    this.gizmo.detach();
    const nodes = [...this.entries.values()].map((e) => e.node);
    const camFeet = () => this.camera.position.clone().setY(this.camera.position.y - (SCALE.playerHeight - 0.3));
    this.runtime = new ScriptRuntime(nodes, [], {
      playerPosition: camFeet,
      teleportPlayer: (feet) => this.camera.position.copy(feet).setY(feet.y + SCALE.playerHeight - 0.3),
      showMessage: (text, sec) => {
        this.message.textContent = text;
        this.message.classList.remove('hidden');
        this.messageTimer = sec;
      },
      keyDown: (code) => this.keys.has(code),
      setWeather: (type, intensity) => this.weather.setWeather(type, intensity),
      log: (msg, err) => this.onStatus?.(msg, err),
      onBroadcast: (msg) => {
        for (const sc of this.screens) sc.rt.receive(msg);
      },
    });
    const world = this.runtime;
    this.screens = [];
    for (const node of nodes) {
      const surf = node.instance?.screen;
      if (!surf) continue;
      let rt: ScreenRuntime;
      rt = new ScreenRuntime(structuredClone(node.data.screen ?? defaultScreen()), surf.stageH, {
        broadcast: (msg) => world.broadcast(msg),
        showMessage: (text, sec) => {
          this.message.textContent = text;
          this.message.classList.remove('hidden');
          this.messageTimer = sec;
        },
        keyDown: (code) => this.keys.has(code),
        teleportPlayer: (x, y, z) => this.camera.position.set(x, y + SCALE.playerHeight - 0.3, z),
        objShow: (name, show) => world.setObjectVisible(name, show),
        setWeather: (type, intensity) => {
          if (isWeatherType(type)) this.weather.setWeather(type, intensity);
        },
        log: (msg, err) => this.onStatus?.(msg, err),
        exit: () => {
          rt.clearCursor();
          rt.exit();
        },
      }, node.data.name);
      this.screens.push({ node, rt, surf });
    }
    this.runtime.start();
    for (const sc of this.screens) sc.rt.start();
    this.simInfo.classList.remove('hidden');
    this.onStatus?.(this.runtime.hasScripts ? 'Simulation gestartet' : 'Simulation gestartet (keine Scripts in der Map)');
    this.onSimulationChange?.();
  }

  stopSimulation(): void {
    if (!this.runtime) return;
    this.runtime.stop();
    this.runtime = null;
    for (const sc of this.screens) sc.rt.stop();
    this.screens = [];
    this.screenHover = this.screenPress = null;
    this.renderer.domElement.style.cursor = '';
    // Script-Wetter zurück auf die Map-Einstellung
    const w = this.state.map.world;
    this.weather.setWeather(isWeatherType(w.weather) ? w.weather : 'klar', w.weatherIntensity);
    this.weather.clearTracks();
    this.state.simulating = false;
    this.fxCollidersDirty = true;
    // Alles auf den gespeicherten Zustand zurücksetzen
    for (const e of this.entries.values()) {
      e.node.collisionEnabled = true;
      applyTransform(e.node);
      buildInstance(e.node, this.ctx);
      this.prepareNode(e.node);
      e.node.root.visible = !this.state.editorHidden.has(e.node.data.id);
    }
    this.simInfo.classList.add('hidden');
    this.message.classList.add('hidden');
    this.updateGizmo();
    this.updateSelectionVisuals();
    this.applyWorld();
    this.onStatus?.('Simulation beendet');
    this.onSimulationChange?.();
  }

  // ---------- Frame ----------

  /** FPS zweimal pro Sekunde aktualisieren; dazu Ø- und längste Frame-Zeit */
  private countFps(dt: number): void {
    this.fpsFrames++;
    this.fpsTime += dt;
    this.fpsWorst = Math.max(this.fpsWorst, dt);
    if (this.fpsTime < 0.5) return;
    const fps = this.fpsFrames / this.fpsTime;
    const avg = (this.fpsTime / this.fpsFrames) * 1000;
    this.fpsEl.textContent = `${Math.round(fps)} FPS  ·  ${avg.toFixed(1)} ms  ·  max ${(this.fpsWorst * 1000).toFixed(1)} ms`;
    this.fpsEl.classList.toggle('low', fps < 30);
    this.fpsEl.classList.toggle('mid', fps >= 30 && fps < 55);
    this.fpsFrames = this.fpsTime = this.fpsWorst = 0;
  }

  /** Collider-Liste für Partikel nachziehen: nach Änderungen (gedrosselt) bzw. während der Simulation
   *  regelmäßig (Scripts bewegen Objekte und tauschen dabei node.colliders aus) */
  private updateFxColliders(dt: number): void {
    this.fxColliderTimer += dt;
    if (this.fxColliderTimer < 0.25) return;
    if (!this.runtime && !this.fxCollidersDirty) return;
    this.fxColliderTimer = 0;
    // computeColliders nimmt die aktuelle Lage – auch während der Simulation korrekt
    const recompute = this.fxCollidersDirty;
    this.fxCollidersDirty = false;
    const list: Collider[] = [];
    for (const e of this.entries.values()) {
      if (recompute) e.node.colliders = computeColliders(e.node);
      if (e.node.root.visible) list.push(...e.node.colliders);
    }
    volumeFX.setColliders(list, this.state.map.world.groundPlane);
  }

  /** Rendern anhalten (z. B. solange der Modeler-Tab offen ist) */
  private paused = false;
  setPaused(v: boolean): void {
    this.paused = v;
  }

  /** Modell wurde neu gespeichert: alle Objekte, die es benutzen, neu aufbauen */
  reloadModel(ref: string): void {
    let hit = false;
    for (const e of this.entries.values()) {
      if ((e.node.data.props as Record<string, unknown> | undefined)?.model === ref) {
        e.propsKey = '';
        hit = true;
      }
    }
    if (hit) this.sync();
  }

  private frameLoop(): void {
    if (this.paused) return;
    this.timer.update();
    const rawDt = this.timer.getDelta();
    const dt = Math.min(rawDt, 0.05);
    if (this.showFps) this.countFps(rawDt);
    const t = this.timer.getElapsed();
    if (!this.runtime) this.modeInput?.update?.(dt);

    if (this.isFlying) {
      const f = this.forward();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const move = new THREE.Vector3();
      const k = this.keys;
      if (k.has('KeyW')) move.add(f);
      if (k.has('KeyS')) move.sub(f);
      if (k.has('KeyD')) move.add(right);
      if (k.has('KeyA')) move.sub(right);
      if (k.has('KeyE')) move.y += 1;
      if (k.has('KeyQ')) move.y -= 1;
      if (move.lengthSq() > 0) {
        const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1;
        this.camera.position.addScaledVector(move.normalize(), this.cameraSpeed * boost * dt);
      }
    }

    // Volumetrik: Wind/Regen vom Wetter; beim Simulieren verdrängt die Kamera (= Spieler) Nebel und Rauch
    const cam = this.camera.position;
    volumeFX.wind.copy(this.weather.windVector);
    volumeFX.rain = this.weather.rainAmount;
    volumeFX.setPlayer(this.runtime ? _feet.set(cam.x, cam.y - SCALE.playerHeight, cam.z) : null, SCALE.playerHeight);
    volumeFX.setAmbient(this.world.hemi, this.world.sun);
    this.updateFxColliders(dt);
    volumeFX.update(dt, t, this.camera);
    for (const e of this.entries.values()) e.node.instance?.update?.(dt, t, this.simulating);
    if (this.runtime) {
      this.runtime.update(dt);
      for (const sc of this.screens) {
        sc.rt.update(dt);
        sc.rt.draw(sc.surf.ctx, SCREEN_PX);
        sc.surf.texture.needsUpdate = true;
      }
      const sun = findSun(this.state.map.objects);
      const q = sun && this.entries.get(sun.id)?.node.root.quaternion;
      const wo = findWeather(this.state.map.objects);
      const wq = wo && this.entries.get(wo.id)?.node.root.quaternion;
      if ((q && !q.equals(this.simSunQuat)) || (wq && !wq.equals(this.simWeatherQuat))) this.applyWorld();
      if (this.selBoxes.children.length) this.updateSelectionVisuals();
    }
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message.classList.add('hidden');
    }

    const p = this.camera.position;
    this.info.textContent = `${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}  ·  Kamera ${this.speedIndex + 1}`;

    if (this.runtime) {
      // Simulieren: Kamera = Spieler; Spuren nur, wenn sie in Augenhöhe über dem Boden ist
      const ground = this.weather.groundHeight;
      const grounded = p.y - ground < SCALE.playerHeight + 0.4 && p.y > ground;
      this.weather.trackFeet(_feet.set(p.x, ground, p.z), grounded);
    }
    this.weather.update(dt, t, this.camera);
    this.weather.render(this.camera, dt);
    this.water.update(dt, this.camera);
    this.water.renderReflection(this.camera);
    // Straßen formen das Gelände (vor dem Landscape-Update, damit neue Höhen sofort sichtbar sind)
    updateDeforms();
    updateLandscapes(this.camera);
    // Foliage und Layer-Gras: Wind vom Wetter; beim Simulieren biegt die Kamera (= Spieler) das Gras
    const wind = this.weather.windVector;
    updateFoliage(this.camera, dt, wind);
    updateGrass(this.camera, dt, wind, this.runtime ? [_feet.set(p.x, this.weather.groundHeight, p.z)] : []);
    this.renderer.clear();
    this.composer.render(dt);
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.camera);
  }
}
