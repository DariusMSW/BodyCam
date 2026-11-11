import * as THREE from 'three';
import { liveLandscapes, updateLandscapes } from '../landscape/render.ts';
import { WATER_LAYER } from './material.ts';

// Hindernis-Maske der Wellenringe: Draufsicht auf 96 m × 96 m um die Kamera, damit die Ripple-Simulation
// an Ufern, Mauern, Pfeilern und Steinen reflektiert, im flachen Wasser ausläuft und die Strömung kennt.
// Drei kleine Renderings aus orthografischen Kameras (gestaffelt über mehrere Frames, alle ~1,5 s oder beim
// Weiterwandern), danach ein Kombinier-Pass:
//  1) Szene von oben (echte Materialien, Landscape verschiebt im Vertex-Shader) → Tiefe = höchste feste Fläche
//  2) Szene von der Wasser-Ebene aus nach oben (nur nach unten zeigende Flächen) → Unterseite von Brücken, Stegen,
//     Decken (dort ist Wasser darunter); die Kamera sitzt auf Wasserhöhe, damit Böden darunter nicht zählen
//  3) Wasserflächen von oben → Wasserhöhe und Strömung (Attribut aFlow)
// Ergebnis (RGBA, Half-Float):
//  R = 1 → Wand (festes Objekt ragt durch die Oberfläche oder kein Wasser); sonst 0..0.5 = Nähe zur nächsten Wand
//      (0.5 = direkt daneben, 0 = über ~2,3 m entfernt) — für Detail/Schaum im Wasser-Material
//  G = Wassertiefe in m (bis 4)
//  BA = Strömung in m/s (Welt-XZ)

export const MASK_RES = 320;
export const MASK_SIZE = 96;
/** Kamerahöhe über/unter der Wasser-Ebene; der Tiefenbereich deckt ±ABOVE ab */
const ABOVE = 40;
const REFRESH = 1.5;
/** neu rendern, wenn die Ripple-Mitte so weit von der Masken-Mitte weg ist (Maske ±48 m, Ripple-Feld ±32 m) */
const MOVE = 12;

const waterVert = /* glsl */ `
uniform float uRef;
attribute vec2 aFlow;
varying float vY;
varying vec2 vFlow;
#ifdef EDGE_CLIP
attribute float aEdge;
varying float vEdge;
#endif
void main() {
#ifdef EDGE_CLIP
  vEdge = aEdge;
#endif
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vY = wp.y - uRef;
  vFlow = aFlow;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const waterFrag = /* glsl */ `
varying float vY;
varying vec2 vFlow;
#ifdef EDGE_CLIP
varying float vEdge;
#endif
void main() {
#ifdef EDGE_CLIP
  if (vEdge < 0.5) discard;
#endif
  gl_FragColor = vec4(1.0, vY, vFlow);
}
`;

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const combineFrag = /* glsl */ `
precision highp float;
uniform sampler2D tTop;
uniform sampler2D tBot;
uniform sampler2D tWater;
uniform mat4 uTopVP;
uniform mat4 uBotVP;
uniform vec2 uCenter;
uniform float uSize, uRef, uNear, uFar, uRevTop, uRevBot;
varying vec2 vUv;

vec2 proj(mat4 m, vec2 xz) {
  vec4 c = m * vec4(xz.x, uRef, xz.y, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}
float dist(float d, float rev) {
  return uNear + (rev > 0.5 ? 1.0 - d : d) * (uFar - uNear);
}
/** höchste feste Fläche relativ zu uRef (-1e3 = nichts) */
float topY(vec2 xz) {
  float l = dist(texture2D(tTop, proj(uTopVP, xz)).x, uRevTop);
  return l > uFar * 0.999 ? -1e3 : ${ABOVE.toFixed(1)} - l;
}
/** tiefste nach unten zeigende Fläche über der Wasser-Ebene, relativ zu uRef (-1e3 = nichts) */
float botY(vec2 xz) {
  float l = dist(texture2D(tBot, proj(uBotVP, xz)).x, uRevBot);
  return l > uFar * 0.999 ? -1e3 : l;
}
/** 1 = Wand; info = (Wand, Tiefe, Strömung) */
float classify(vec2 xz, out vec4 info) {
  vec4 w = texture2D(tWater, proj(uTopVP, xz));
  if (w.x < 0.5) {
    info = vec4(1.0, 0.0, 0.0, 0.0);
    return 1.0;
  }
  float t = topY(xz);
  float depth = t < -500.0 ? 4.0 : clamp(w.y - t, 0.0, 4.0);
  float wall = 0.0;
  if (t > w.y + 0.03) {
    // ragt etwas aus dem Wasser — oder ist es eine Brücke mit Wasser darunter?
    if (botY(xz) > w.y + 0.05) depth = 4.0;
    else wall = 1.0;
  }
  info = vec4(wall, depth, w.zw);
  return wall;
}
void main() {
  vec2 xz = uCenter + (vUv - 0.5) * uSize;
  vec4 info;
  if (classify(xz, info) > 0.5) {
    gl_FragColor = vec4(1.0, 0.0, info.zw);
    return;
  }
  // Nähe zur nächsten Wand: drei Ringe à 8 Richtungen (0,45 / 1,1 / 2,0 m)
  float prox = 0.0;
  vec4 tmp;
  for (int ring = 0; ring < 3; ring++) {
    float r = ring == 0 ? 0.45 : (ring == 1 ? 1.1 : 2.0);
    float k = 1.0 - r / 2.3;
    if (k <= prox) break;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398 + float(ring) * 0.39;
      if (classify(xz + vec2(cos(a), sin(a)) * r, tmp) > 0.5) {
        prox = k;
        break;
      }
    }
  }
  gl_FragColor = vec4(prox * 0.5, info.y, info.zw);
}
`;

const _cc = new THREE.Color();

function depthTarget(): THREE.WebGLRenderTarget {
  const t = new THREE.WebGLRenderTarget(MASK_RES, MASK_RES, { depthBuffer: true, generateMipmaps: false });
  t.depthTexture = new THREE.DepthTexture(MASK_RES, MASK_RES, THREE.FloatType);
  t.depthTexture.minFilter = t.depthTexture.magFilter = THREE.NearestFilter;
  return t;
}

function isWaterMaterial(m: THREE.Material): m is THREE.ShaderMaterial {
  return (m as THREE.ShaderMaterial).isShaderMaterial === true && !!(m as THREE.ShaderMaterial).uniforms?.uWaveA;
}

export class RippleMask {
  readonly target: THREE.WebGLRenderTarget;
  /** xy = Mitte, z = Größe, w = gültig */
  readonly area = new THREE.Vector4(0, 0, MASK_SIZE, 0);
  private top = depthTarget();
  private bot = depthTarget();
  private water: THREE.WebGLRenderTarget;
  private topCam = new THREE.OrthographicCamera(-MASK_SIZE / 2, MASK_SIZE / 2, MASK_SIZE / 2, -MASK_SIZE / 2, 0.05, ABOVE * 2);
  private botCam = new THREE.OrthographicCamera(-MASK_SIZE / 2, MASK_SIZE / 2, MASK_SIZE / 2, -MASK_SIZE / 2, 0.05, ABOVE * 2);
  private downFaces = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.FrontSide });
  private waterMat: THREE.ShaderMaterial;
  private waterMatClip: THREE.ShaderMaterial;
  private combine: THREE.ShaderMaterial;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private phase = -1;
  private timer = 0;
  private cx = 0;
  private cz = 0;
  private ref = 0;
  private hide: THREE.Object3D[] = [];

  constructor(private renderer: THREE.WebGLRenderer) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.target = new THREE.WebGLRenderTarget(MASK_RES, MASK_RES, opts);
    this.water = new THREE.WebGLRenderTarget(MASK_RES, MASK_RES, { type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const ref = { value: 0 };
    this.waterMat = new THREE.ShaderMaterial({ uniforms: { uRef: ref }, vertexShader: waterVert, fragmentShader: waterFrag, side: THREE.DoubleSide });
    this.waterMatClip = new THREE.ShaderMaterial({ uniforms: { uRef: ref }, vertexShader: waterVert, fragmentShader: waterFrag, side: THREE.DoubleSide, defines: { EDGE_CLIP: '' } });
    this.combine = new THREE.ShaderMaterial({
      uniforms: {
        tTop: { value: this.top.depthTexture },
        tBot: { value: this.bot.depthTexture },
        tWater: { value: this.water.texture },
        uTopVP: { value: new THREE.Matrix4() },
        uBotVP: { value: new THREE.Matrix4() },
        uCenter: { value: new THREE.Vector2() },
        uSize: { value: MASK_SIZE },
        uRef: { value: 0 },
        uNear: { value: 0.05 },
        uFar: { value: ABOVE * 2 },
        uRevTop: { value: 0 },
        uRevBot: { value: 0 },
      },
      vertexShader: quadVert,
      fragmentShader: combineFrag,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.combine);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
    // von unten: Up so wählen, dass Bild-X = Welt-X (die Abbildung geht ohnehin über die Matrizen)
    this.botCam.up.set(0, 0, 1);
    this.topCam.up.set(0, 0, -1);
  }

  /**
   * Pro Frame (nur wenn Wasser in der Nähe): bei Bedarf einen Teilschritt rendern.
   * `refY` = Höhe der nächsten Wasserfläche, `hidden` = nie als Hindernis (Spieler, Partikel, bewegte Objekte).
   */
  update(dt: number, x: number, z: number, refY: number, scene: THREE.Scene, hidden: THREE.Object3D[]): void {
    this.timer -= dt;
    if (this.phase < 0) {
      const far = this.area.w < 0.5 || Math.abs(x - this.area.x) > MOVE || Math.abs(z - this.area.y) > MOVE || Math.abs(refY - this.ref) > 4;
      if (!far && this.timer > 0) return;
      this.timer = REFRESH;
      const texel = MASK_SIZE / MASK_RES;
      this.cx = Math.round(x / texel) * texel;
      this.cz = Math.round(z / texel) * texel;
      this.ref = refY;
      this.hide = this.collectHidden(scene, hidden);
      this.phase = 0;
    }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevXr = r.xr.enabled;
    const prevShadow = r.shadowMap.autoUpdate;
    const cc = r.getClearColor(_cc);
    const ca = r.getClearAlpha();
    const bg = scene.background;
    const fog = scene.fog;
    const override = scene.overrideMaterial;
    r.xr.enabled = false;
    r.autoClear = false;
    r.shadowMap.autoUpdate = false;
    r.setClearColor(0x000000, 0);
    scene.background = null;
    scene.fog = null;
    const states = this.hide.map((o) => o.visible);
    for (const o of this.hide) o.visible = false;

    try {
      if (this.phase === 0) this.renderTop(scene);
      else if (this.phase === 1) this.renderBottom(scene);
      else if (this.phase === 2) this.renderWater(scene);
      else this.renderCombine();
    } finally {
      this.hide.forEach((o, i) => (o.visible = states[i]));
      scene.background = bg;
      scene.fog = fog;
      scene.overrideMaterial = override;
      r.setClearColor(_cc.copy(cc), ca);
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAuto;
      r.xr.enabled = prevXr;
      r.shadowMap.autoUpdate = prevShadow;
    }
    this.phase = this.phase >= 3 ? -1 : this.phase + 1;
  }

  private collectHidden(scene: THREE.Scene, extra: THREE.Object3D[]): THREE.Object3D[] {
    // nur Objekte der normalen Schicht — die Wasser-Schicht regelt renderWater() selbst
    const out = new Set(extra.filter((o) => o.layers.isEnabled(0)));
    scene.traverseVisible((o) => {
      // Wasser-Schicht: zeichnen die Fest-Pässe ohnehin nicht, der Wasser-Pass braucht sie sichtbar
      if (!o.layers.isEnabled(0)) return;
      if (o.userData.noWeather || o.userData.noShot || o.userData.editorHelper) {
        out.add(o);
        return;
      }
      const m = o as THREE.Mesh;
      if ((o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) out.add(o);
      else if (m.isMesh) {
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        if (mats.every((mm) => (mm.transparent && !mm.depthWrite) || !mm.colorWrite || mm.visible === false)) out.add(o);
      }
    });
    return [...out];
  }

  private place(cam: THREE.OrthographicCamera, y: number, lookY: number): void {
    cam.position.set(this.cx, y, this.cz);
    cam.lookAt(this.cx, lookY, this.cz);
    cam.updateMatrixWorld();
  }

  private renderTop(scene: THREE.Scene): void {
    const r = this.renderer;
    const cam = this.topCam;
    this.place(cam, this.ref + ABOVE, this.ref);
    cam.layers.set(0);
    // Landscape-LOD für die Draufsicht wählen (die Hauptkamera wählt danach im selben Frame neu)
    updateLandscapes(cam);
    r.setRenderTarget(this.top);
    r.clear(true, true, false);
    r.render(scene, cam);
    this.combine.uniforms.uTopVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.combine.uniforms.uRevTop.value = cam.reversedDepth ? 1 : 0;
  }

  private renderBottom(scene: THREE.Scene): void {
    const r = this.renderer;
    const cam = this.botCam;
    this.place(cam, this.ref, this.ref + 1);
    cam.layers.set(0);
    // Gelände hat keine Unterseite; dessen Grundgitter würde mit dem Ersatz-Material flach gezeichnet
    const ls: THREE.Object3D[] = [];
    for (const l of liveLandscapes()) if (l.mesh.visible) ls.push(l.mesh);
    for (const o of ls) o.visible = false;
    scene.overrideMaterial = this.downFaces;
    r.setRenderTarget(this.bot);
    r.clear(true, true, false);
    r.render(scene, cam);
    for (const o of ls) o.visible = true;
    this.combine.uniforms.uBotVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.combine.uniforms.uRevBot.value = cam.reversedDepth ? 1 : 0;
  }

  private renderWater(scene: THREE.Scene): void {
    const r = this.renderer;
    const cam = this.topCam;
    this.place(cam, this.ref + ABOVE, this.ref);
    cam.layers.set(WATER_LAYER);
    this.waterMat.uniforms.uRef.value = this.ref;
    // Wasser-Materialien gegen das Höhen/Strömungs-Material tauschen, alles andere auf der Schicht ausblenden
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    const off: THREE.Object3D[] = [];
    scene.traverseVisible((o) => {
      if (!o.layers.isEnabled(WATER_LAYER)) return;
      const m = o as THREE.Mesh;
      if (m.isMesh && !Array.isArray(m.material) && isWaterMaterial(m.material)) {
        swapped.push([m, m.material]);
        m.material = m.material.defines && 'EDGE_CLIP' in m.material.defines ? this.waterMatClip : this.waterMat;
      } else if (m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) off.push(o);
    });
    for (const o of off) o.visible = false;
    r.setRenderTarget(this.water);
    r.clear(true, true, false);
    r.render(scene, cam);
    for (const o of off) o.visible = true;
    for (const [m, mat] of swapped) m.material = mat;
  }

  private renderCombine(): void {
    const r = this.renderer;
    const u = this.combine.uniforms;
    u.uCenter.value.set(this.cx, this.cz);
    u.uRef.value = this.ref;
    r.setRenderTarget(this.target);
    r.render(this.quadScene, this.quadCam);
    this.area.set(this.cx, this.cz, MASK_SIZE, 1);
  }

  /** Maske ungültig machen (z. B. kein Wasser mehr in der Nähe) */
  reset(): void {
    this.area.w = 0;
    this.phase = -1;
  }

  dispose(): void {
    this.target.dispose();
    this.top.dispose();
    this.bot.dispose();
    this.water.dispose();
    this.downFaces.dispose();
    this.waterMat.dispose();
    this.waterMatClip.dispose();
    this.combine.dispose();
  }
}
