import * as THREE from 'three';
import { atmosphere } from '../rendering/atmosphere.ts';

// Himmelskuppel mit Farbverlauf, sichtbarer Sonnenscheibe und Leuchten.
// Wird immer auf der Far-Plane gezeichnet (unabhängig von Kamera-Position und -Reichweite),
// liefert HDR-Werte, damit Bloom die Sonne aufgreift.

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // nur Rotation der Kamera: Kuppel wandert mit
    vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
    // auf die Far-Ebene legen (Reversed-Z: Tiefe 0 = Far)
#ifdef USE_REVERSED_DEPTH_BUFFER
    gl_Position = vec4(p.xy, 0.0, p.w);
#else
    gl_Position = p.xyww;
#endif
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 ground;
  uniform vec3 fogColor;
  uniform float fogMix;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform float sunCos;
  uniform float sunEdge;
  uniform float sunBright;
  uniform float glow;
  uniform float discOn;
  uniform float overcast;
  uniform float flash;
  uniform vec4 bcFogA;
  uniform vec3 bcFogSunDir;
  uniform vec3 bcFogSunCol;
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec3 dir = normalize(vDir);
    float y = dir.y;
    vec3 col = y >= 0.0
      ? mix(horizon, zenith, pow(smoothstep(0.0, 1.0, y), 0.55))
      : mix(horizon, ground, smoothstep(0.0, 0.12, -y));
    // Horizont geht in den Distanznebel über, damit keine Kante zur Geometrie entsteht
    // (gleiche Nebelfarbe wie in den Materialien: Grundfarbe + Einstreuung Richtung Sonne, siehe atmosphere.ts)
    float fc = max(dot(dir, bcFogSunDir), 0.0);
    float fc2 = fc * fc;
    float fc8 = fc2 * fc2 * fc2 * fc2;
    vec3 fogC = fogColor * (1.0 + bcFogA.w) + bcFogSunCol * (fc2 * fc2 * 0.35 + fc8 * fc8 * 0.65);
    col = mix(col, fogC, fogMix * (1.0 - smoothstep(-0.05, 0.3, y)));

    // Bewölkung: entsättigt und dunkler, Wolkenstruktur über Richtungs-Rauschen
    float lum = dot(col, vec3(0.3, 0.59, 0.11));
    float cl = 0.85 + 0.15 * sin(dir.x * 9.0 + sin(dir.z * 7.0)) * sin(dir.z * 8.0 + dir.x * 3.0);
    col = mix(col, vec3(lum * 0.72, lum * 0.75, lum * 0.8) * cl, overcast * 0.8);
    col *= 1.0 + flash * 4.0 * smoothstep(-0.1, 0.4, y);

    float d = dot(dir, sunDir);
    float above = smoothstep(-0.03, 0.02, y);
    float halo = pow(max(d, 0.0), 8.0) * 0.25 + pow(max(d, 0.0), 64.0) * 0.6 + pow(max(d, 0.0), 600.0) * 1.5;
    float clear = 1.0 - smoothstep(0.3, 0.85, overcast);
    col += sunColor * halo * glow * above * mix(1.0, 0.25, overcast);
    float disc = smoothstep(sunCos - sunEdge, sunCos, d) * discOn * above * clear;
    col = mix(col, sunColor * sunBright, disc);

    col += (hash(gl_FragCoord.xy) - 0.5) / 255.0; // gegen Banding
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface SkyParams {
  zenith: string;
  horizon: string;
  ground: string;
  fogColor: string;
  sunColor: string;
  sunIntensity: number;
  /** Richtung zur Sonne (normiert) */
  sunDir: THREE.Vector3;
  /** Winkeldurchmesser der Sonnenscheibe in Grad */
  sunSize: number;
  glow: number;
  disc: boolean;
}

export class Sky {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;

  constructor() {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color() },
        horizon: { value: new THREE.Color() },
        ground: { value: new THREE.Color() },
        fogColor: { value: new THREE.Color() },
        fogMix: { value: 1 },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color() },
        sunCos: { value: 0.9999 },
        sunEdge: { value: 0.00002 },
        sunBright: { value: 10 },
        glow: { value: 0.4 },
        discOn: { value: 1 },
        overcast: { value: 0 },
        flash: { value: 0 },
        // geteilte Referenzen: Nebel am Horizont passt immer zum Nebel auf der Geometrie
        bcFogA: atmosphere.uniforms.bcFogA,
        bcFogSunDir: atmosphere.uniforms.bcFogSunDir,
        bcFogSunCol: atmosphere.uniforms.bcFogSunCol,
      },
    });
    // Radius ist für die Darstellung egal (Richtung zählt); groß, damit Hilfs-Passes (Outline) nicht stören
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), material);
    this.mesh.name = 'Sky';
    this.mesh.frustumCulled = false;
    // Als letztes opakes Objekt zeichnen: der Tiefentest (Far-Plane, LessEqual) verwirft dann alle von
    // Geometrie verdeckten Pixel vor dem Shader. Zuerst gezeichnet schattiert der Himmel den ganzen
    // Bildschirm, der danach übermalt wird – auf schwachen GPUs ein spürbarer Teil der Frame-Zeit.
    // Transparentes (Wasser, Partikel, Volumen) liegt in einer eigenen Liste und kommt ohnehin danach.
    this.mesh.renderOrder = 100000;
    this.mesh.userData.noPick = true;
    this.mesh.userData.noShot = true;
    this.mesh.raycast = () => {};
  }

  apply(p: SkyParams): void {
    const u = this.mesh.material.uniforms;
    u.zenith.value.set(p.zenith);
    u.horizon.value.set(p.horizon);
    u.ground.value.set(p.ground);
    u.fogColor.value.set(p.fogColor);
    u.sunDir.value.copy(p.sunDir).normalize();
    u.sunColor.value.set(p.sunColor);
    const r = THREE.MathUtils.degToRad(Math.max(0.05, p.sunSize) / 2);
    u.sunCos.value = Math.cos(r);
    u.sunEdge.value = Math.cos(r * 0.75) - Math.cos(r * 1.25);
    // Scheibe bleibt auch bei schwacher Sonne sichtbar heller als der Himmel
    u.sunBright.value = 4 + Math.max(0, p.sunIntensity) * 8;
    u.glow.value = Math.max(0, p.glow);
    u.discOn.value = p.disc ? 1 : 0;
  }

  /** Wetter: overcast 0..1 (Bewölkung), flash ≥ 0 (Blitz) */
  setWeather(overcast: number, flash: number): void {
    const u = this.mesh.material.uniforms;
    u.overcast.value = overcast;
    u.flash.value = flash;
  }

  setFog(on: boolean): void {
    this.mesh.material.uniforms.fogMix.value = on ? 1 : 0;
  }
}
