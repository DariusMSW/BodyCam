import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { FULLSCREEN_VERTEX } from './depth.ts';

/**
 * Belichtungsautomatik wie bei einer echten Bodycam: misst die mittlere Helligkeit des HDR-Bildes und
 * regelt die Belichtung träge nach. Tritt man aus einem dunklen Flur ins Freie, ist das Bild kurz
 * überstrahlt und fängt sich dann; im Dunkeln hellt die Kamera langsam etwas auf.
 *
 * Messung: Bild → kleines Target mit log2(Luminanz) (mittenbetont) → Mip-Kette bis 1×1 → asynchrones Auslesen
 * über einen Pixel-Buffer + Fence. Abgeholt wird erst, wenn die Fence am Frame-Anfang schon signalisiert ist:
 * readRenderTargetPixelsAsync von three fragt per Timer mitten in den nächsten Frame hinein ab, und das
 * getBufferSubData wartet dann (Chrome/ANGLE) auf die ganze GPU-Warteschlange – das halbierte die Bildrate. Die Regelung selbst läuft auf der CPU; das Ergebnis (exposure) multipliziert
 * der Aufrufer in renderer.toneMappingExposure. Der Regelbereich ist bewusst eng: dunkle Szenen sollen
 * dunkel bleiben.
 */

const lumShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() } },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    float logLum(vec2 uv) {
      vec3 c = min(texture2D(tDiffuse, uv).rgb, vec3(64.0));
      return log2(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
    }
    void main() {
      // 4 Abgriffe je Zielpixel: weniger Flimmern durch einzelne helle Pixel
      float l = 0.25 * (logLum(vUv + uTexel * vec2(-1.5, -1.5)) + logLum(vUv + uTexel * vec2(1.5, -1.5))
        + logLum(vUv + uTexel * vec2(-1.5, 1.5)) + logLum(vUv + uTexel * vec2(1.5, 1.5)));
      // mittenbetont: Gewicht in Alpha, die Mip-Kette mittelt beides
      vec2 c = vUv - 0.5;
      float w = 1.0 - 0.75 * smoothstep(0.1, 0.6, length(c));
      gl_FragColor = vec4(l * w, 0.0, 0.0, w);
    }
  `,
};

const avgShader = {
  uniforms: { tLum: { value: null as THREE.Texture | null } },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    uniform sampler2D tLum;
    void main() {
      vec4 s = textureLod(tLum, vec2(0.5), 16.0);
      gl_FragColor = vec4(s.r / max(s.a, 1e-4), 0.0, 0.0, 1.0);
    }
  `,
};

export class AutoExposure extends Pass {
  /** aktueller Belichtungsfaktor (1 = neutral) */
  exposure = 1;
  /** log2 der Ziel-Helligkeit: Szenen mit dieser mittleren Luminanz bleiben unverändert */
  keyLog = -4.6;
  /** Anteil der Kompensation (0 = aus, 1 = jede Szene gleich hell) */
  compensation = 0.45;
  minExposure = 0.6;
  maxExposure = 1.25;
  /** zuletzt gemessene mittlere log2-Luminanz (Debug) */
  measured = NaN;

  private lumRT = new THREE.WebGLRenderTarget(128, 72, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  private pixRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private lumMat = new THREE.ShaderMaterial({ ...lumShader, uniforms: THREE.UniformsUtils.clone(lumShader.uniforms), depthTest: false, depthWrite: false });
  private avgMat = new THREE.ShaderMaterial({ ...avgShader, uniforms: THREE.UniformsUtils.clone(avgShader.uniforms), depthTest: false, depthWrite: false });
  private quad = new FullScreenQuad();
  private buffer = new Float32Array(4);
  private gl: WebGL2RenderingContext | null = null;
  private pbo: WebGLBuffer | null = null;
  private sync: WebGLSync | null = null;
  /** Frames seit dem Absenden der laufenden Messung */
  private age = 0;
  private failed = false;
  private frame = 0;

  constructor() {
    super();
    this.needsSwap = false;
  }

  setSize(width: number, height: number): void {
    this.lumMat.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  /** Belichtung sofort neutral (z. B. Automatik abgeschaltet) */
  reset(): void {
    this.exposure = 1;
    this.measured = NaN;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number): void {
    const gl = (this.gl = renderer.getContext() as WebGL2RenderingContext);
    // laufende Messung abholen – nur wenn die GPU sie sicher fertig hat (sonst blockiert getBufferSubData)
    if (this.sync) {
      this.age++;
      if (this.age >= 2 && gl.getSyncParameter(this.sync, gl.SYNC_STATUS) === gl.SIGNALED) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.buffer);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(this.sync);
        this.sync = null;
        if (Number.isFinite(this.buffer[0])) this.measured = this.buffer[0];
      } else if (this.age > 120) {
        // Fence hängt (Kontextverlust o. Ä.) → neu anfangen
        gl.deleteSync(this.sync);
        this.sync = null;
      }
    }
    // alle 4 Frames messen (die Regelung ist träge, öfter bringt nichts)
    if (!this.failed && !this.sync && this.frame++ % 4 === 0) {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      this.lumMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.quad.material = this.lumMat;
      renderer.setRenderTarget(this.lumRT);
      this.quad.render(renderer);
      this.avgMat.uniforms.tLum.value = this.lumRT.texture;
      this.quad.material = this.avgMat;
      renderer.setRenderTarget(this.pixRT);
      this.quad.render(renderer);
      renderer.autoClear = autoClear;
      this.requestRead(renderer, gl);
    }
    if (this.failed || !Number.isFinite(this.measured)) return;
    const target = THREE.MathUtils.clamp(Math.pow(2, (this.keyLog - this.measured) * this.compensation), this.minExposure, this.maxExposure);
    // Abblenden (ins Helle) geht schnell, Aufhellen (ins Dunkle) langsam – wie Sensor und Auge
    const speed = target < this.exposure ? 2.2 : 0.7;
    this.exposure += (target - this.exposure) * (1 - Math.exp(-Math.min(deltaTime, 0.1) * speed));
  }

  /** Den 1×1-Pixel des Mess-Targets asynchron in einen Pixel-Buffer kopieren und eine Fence dahinter setzen */
  private requestRead(renderer: THREE.WebGLRenderer, gl: WebGL2RenderingContext): void {
    // pixRT ist durch setRenderTarget oben gebunden
    if (!this.pbo) {
      this.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.buffer.byteLength, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    // Float-RGBA ist mit EXT_color_buffer_float (von three aktiviert) immer lesbar; ohne die Erweiterung
    // gäbe es das HalfFloat-Szenen-Target gar nicht. Kein getError(): wäre in Chrome ein synchroner Roundtrip.
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
      console.warn('Belichtungsautomatik deaktiviert: kein lesbares Float-Target');
      this.failed = true;
      this.exposure = 1;
      return;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.age = 0;
  }

  dispose(): void {
    if (this.gl) {
      if (this.sync) this.gl.deleteSync(this.sync);
      if (this.pbo) this.gl.deleteBuffer(this.pbo);
    }
    this.sync = this.pbo = null;
    this.lumRT.dispose();
    this.pixRT.dispose();
    this.lumMat.dispose();
    this.avgMat.dispose();
    this.quad.dispose();
  }
}
