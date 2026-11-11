import * as THREE from 'three';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { WorldRig } from '../mapLoader.ts';
import { MAX_WAKES, WATER_LAYER, waterShared } from './material.ts';
import { advanceWater, takeImpulses, takeObstacles, takeSplashes, waterAt, waterBodies, type WaterSample } from './registry.ts';
import { RippleMask } from './rippleMask.ts';
import { RippleSim } from './ripples.ts';
import { WaterSplashes } from './splash.ts';

// Wassersystem für Spiel und Editor: Zeit, Umgebung (Himmel/Sonne), Spiegelung, Wellenringe, Spritzer.
// Ablauf pro Frame: update() (nach der Kamera) → renderReflection() (vor dem Composer) → WaterPass im Composer.

export type WaterReflectionQuality = 0 | 1 | 2;

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _plane = new THREE.Plane();
const _clip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _size = new THREE.Vector2();

export interface WaterEnv {
  /** Himmelsfarben (Wetter graut sie bei Bewölkung ein) */
  sky?: () => { zenith: THREE.Color; horizon: THREE.Color } | null;
  /** in Spiegelung ausgeblendete Objekte (Spielerkörper, Wetter-Partikel, Helfer) */
  hidden?: () => THREE.Object3D[];
  /** bewegte Objekte, die nicht als feste Hindernisse in die Wellen-Maske sollen (melden sich per waterObstacle) */
  dynamic?: () => THREE.Object3D[];
}

export class WaterSystem {
  readonly ripples: RippleSim;
  readonly mask: RippleMask;
  readonly splashes = new WaterSplashes();
  private quality: WaterReflectionQuality = 2;
  private reflTarget: THREE.WebGLRenderTarget | null = null;
  private reflCamera = new THREE.PerspectiveCamera();
  private camSample: WaterSample = { height: 0, base: 0, flowX: 0, flowZ: 0, fade: 1, body: null };
  /** Kamera unter Wasser: Tiefe unter der Oberfläche (m), sonst 0 */
  underwater = 0;
  /** Wasser an der Kamera (falls vorhanden) */
  cameraWater: WaterSample | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private rig: WorldRig | null,
    private env: WaterEnv = {},
  ) {
    this.mask = new RippleMask(renderer);
    this.ripples = new RippleSim(renderer, { texture: this.mask.target.texture, area: this.mask.area });
    scene.add(this.splashes.points);
    waterShared.tRipple.value = this.ripples.texture;
    waterShared.uRippleArea.value = this.ripples.area;
    waterShared.tRippleMask.value = this.mask.target.texture;
    waterShared.uMaskArea.value = this.mask.area;
  }

  setRig(rig: WorldRig | null): void {
    this.rig = rig;
  }

  setReflectionQuality(q: WaterReflectionQuality): void {
    this.quality = q;
    if (q === 0) {
      this.reflTarget?.dispose();
      this.reflTarget = null;
    }
  }

  /** Nach Kamera-Update: Zeit, Umgebung, Ereignisse, Ripple-Simulation */
  update(dt: number, camera: THREE.Camera): void {
    advanceWater(dt);
    const cam = camera.getWorldPosition(_v);
    const bodies = waterBodies();
    for (const b of bodies) b.beforeRender?.(cam);

    // Umgebung
    const u = waterShared;
    const sky = this.env.sky?.();
    if (sky) {
      u.uSkyZenith.value.copy(sky.zenith);
      u.uSkyHorizon.value.copy(sky.horizon);
    }
    if (this.rig) {
      const sun = this.rig.sun;
      u.uSunDir.value.copy(sun.position).normalize();
      u.uSunColor.value.copy(sun.color).multiplyScalar(sun.visible ? sun.intensity : 0);
      const h = this.rig.hemi;
      u.uAmbient.value.copy(h.color).lerp(h.groundColor, 0.35).multiplyScalar(h.intensity);
    }

    // Kamera im Wasser?
    const w = bodies.size ? waterAt(cam.x, cam.z, this.camSample) : null;
    this.cameraWater = w;
    this.underwater = w && cam.y < w.height ? w.height - cam.y : 0;

    // Wellenringe nur, wenn Wasser in der Nähe ist
    let near = false;
    let refY = NaN;
    let best = Infinity;
    for (const b of bodies) {
      const bx = b.box;
      if (cam.x > bx.minX - 40 && cam.x < bx.maxX + 40 && cam.z > bx.minZ - 40 && cam.z < bx.maxZ + 40 && Math.abs(cam.y - b.level) < 60) {
        near = true;
        const dx = Math.max(bx.minX - cam.x, 0, cam.x - bx.maxX);
        const dz = Math.max(bx.minZ - cam.z, 0, cam.z - bx.maxZ);
        const score = Math.hypot(dx, dz) + Math.abs(cam.y - b.level) * 0.5;
        if (score < best) {
          best = score;
          refY = b.level;
        }
      }
    }
    // Hindernis-Maske (Ufer, Objekte, Strömung): Wasserhöhe an der Kamera ist genauer als die Ebene der Fläche
    if (near) {
      if (w && Math.abs(w.base - refY) < 20) refY = w.base;
      const hidden = [...(this.env.hidden?.() ?? []), ...(this.env.dynamic?.() ?? []), this.splashes.points];
      this.mask.update(dt, cam.x, cam.z, refY, this.scene, hidden);
    } else this.mask.reset();
    this.ripples.add(takeImpulses());
    const obstacles = takeObstacles();
    this.ripples.setObstacles(obstacles);
    // Heckwellen fürs Material: die am stärksten angeströmten Hindernisse
    {
      const list = obstacles
        .filter((o) => o.wake > 0 && Math.hypot(o.flowX, o.flowZ) > 0.06)
        .sort((a, b) => b.strength * b.wake - a.strength * a.wake)
        .slice(0, MAX_WAKES);
      const W = waterShared.uWake.value;
      const P = waterShared.uWakeP.value;
      list.forEach((o, i) => {
        W[i].set(o.x, o.z, o.flowX, o.flowZ);
        P[i].set(Math.min(1.2, o.strength * o.wake * 0.5), o.radius, (i * 0.618) % 1, 0);
      });
      waterShared.uWakeN.value = near ? list.length : 0;
    }
    this.ripples.update(dt, cam.x, cam.z, near);
    waterShared.tRipple.value = this.ripples.texture;
    for (const s of takeSplashes()) this.splashes.spawn(s);
    this.splashes.update(dt);
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) {
      this.renderer.getDrawingBufferSize(_size);
      this.splashes.setViewport(_size.y, pc.fov);
    }
  }

  /** Planare Spiegelung an der Ebene der nächsten Wasserfläche (vor dem Composer) */
  renderReflection(camera: THREE.PerspectiveCamera): void {
    const u = waterShared;
    u.uReflOn.value = 0;
    const bodies = waterBodies();
    if (this.quality === 0 || !bodies.size || this.underwater > 0) return;
    camera.updateMatrixWorld();
    const camPos = _v.setFromMatrixPosition(camera.matrixWorld);
    // nächste Fläche unterhalb der Kamera (in der Nähe)
    let planeY = NaN;
    let best = Infinity;
    for (const b of bodies) {
      const bx = b.box;
      const dx = Math.max(bx.minX - camPos.x, 0, camPos.x - bx.maxX);
      const dz = Math.max(bx.minZ - camPos.z, 0, camPos.z - bx.maxZ);
      const d = Math.hypot(dx, dz);
      if (d > 400 || camPos.y < b.level + 0.05) continue;
      const score = d + Math.abs(camPos.y - b.level) * 0.5;
      if (score < best) {
        best = score;
        planeY = b.level;
      }
    }
    if (!Number.isFinite(planeY)) return;

    const r = this.renderer;
    r.getDrawingBufferSize(_size);
    const f = this.quality === 2 ? 0.5 : 0.25;
    const w = Math.max(64, Math.round(_size.x * f));
    const h = Math.max(64, Math.round(_size.y * f));
    if (!this.reflTarget) {
      this.reflTarget = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
    } else if (this.reflTarget.width !== w || this.reflTarget.height !== h) this.reflTarget.setSize(w, h);

    // Spiegelkamera (wie three.js Reflector, mit Reversed-Z-Variante der schrägen Near-Plane)
    const rot = _m.extractRotation(camera.matrixWorld);
    const look = _v2.set(0, 0, -1).applyMatrix4(rot).add(camPos);
    const vc = this.reflCamera;
    vc.position.set(camPos.x, 2 * planeY - camPos.y, camPos.z);
    vc.up.set(0, 1, 0).applyMatrix4(rot);
    vc.up.y = -vc.up.y;
    vc.lookAt(look.x, 2 * planeY - look.y, look.z);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.layers.set(0);
    vc.updateMatrixWorld();
    const reversed = camera.reversedDepth;
    (vc as unknown as { _reversedDepth: boolean })._reversedDepth = reversed;
    vc.projectionMatrix.copy(camera.projectionMatrix);

    u.uReflMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    u.uReflMatrix.value.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);

    _plane.setFromNormalAndCoplanarPoint(UP, _n.set(0, planeY, 0)).applyMatrix4(vc.matrixWorldInverse);
    _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
    const p = vc.projectionMatrix.elements;
    if (reversed) {
      _q.set(Math.sign(_clip.x), Math.sign(_clip.y), 0, 1).applyMatrix4(vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert());
      const a = -_q.z / _clip.dot(_q);
      p[2] = -a * _clip.x;
      p[6] = -a * _clip.y;
      p[10] = -1 - a * _clip.z + 0.003;
      p[14] = -a * _clip.w;
    } else {
      _q.set((Math.sign(_clip.x) + p[8]) / p[0], (Math.sign(_clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
      _clip.multiplyScalar(2 / _clip.dot(_q));
      p[2] = _clip.x;
      p[6] = _clip.y;
      p[10] = _clip.z + 1 - 0.003;
      p[14] = _clip.w;
    }
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();

    const hidden = this.env.hidden?.() ?? [];
    const states = hidden.map((o) => o.visible);
    for (const o of hidden) o.visible = false;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.autoClear = true;
    r.setRenderTarget(this.reflTarget);
    r.render(this.scene, vc);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
    r.shadowMap.autoUpdate = prevShadow;
    hidden.forEach((o, i) => (o.visible = states[i]));

    u.tReflection.value = this.reflTarget.texture;
    u.uReflY.value = planeY;
    u.uReflOn.value = 1;
  }

  dispose(): void {
    this.scene.remove(this.splashes.points);
    this.splashes.dispose();
    this.ripples.dispose();
    this.mask.dispose();
    this.reflTarget?.dispose();
  }
}

/**
 * Zeichnet Wasserflächen und Spritzer (WATER_LAYER) direkt nach der opaken Szene in denselben Puffer.
 * Farbe und Tiefe der Szene kommen aus den aufgelösten Texturen des MSAA-Puffers (wie beim VolumePass);
 * das Wasser schreibt Tiefe, damit Nebel/Rauch danach an der Oberfläche enden.
 */
export class WaterPass extends Pass {
  constructor(
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    super();
    this.needsSwap = false;
  }

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const scene = this.scene;
    const camera = this.camera;
    if (scene.overrideMaterial || !waterBodies().size) return;
    const u = waterShared;
    const msrtt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
    const ok = !!readBuffer.depthTexture && readBuffer.samples > 0 && !msrtt;
    u.tScene.value = ok ? readBuffer.texture : null;
    u.tDepth.value = ok ? readBuffer.depthTexture : null;
    u.uSceneOn.value = ok ? 1 : 0;
    u.uScreen.value.set(readBuffer.width, readBuffer.height);
    const cam = camera as THREE.PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
    }

    const mask = camera.layers.mask;
    const background = scene.background;
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    camera.layers.set(WATER_LAYER);
    scene.background = null;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;

    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.render(scene, camera);

    camera.layers.mask = mask;
    scene.background = background;
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
    u.tScene.value = null;
    u.tDepth.value = null;
  }
}
