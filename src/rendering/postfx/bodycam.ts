import * as THREE from 'three';

// Bodycam-Linsen-/Sensor-Look als finaler Post-Pass (läuft nach Tonemapping, also im sRGB-Raum):
// Fischaugen-Verzerrung, chromatische Aberration, Entsättigung, Vignette, Sensorrauschen,
// feine Zeilenstruktur und Signal-Glitch bei Schüssen/Treffern.
export const BodycamShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDistortion: { value: 0.24 },
    uAberration: { value: 0.007 },
    uGrain: { value: 0.085 },
    uVignette: { value: 0.8 },
    uGlitch: { value: 0 },
    uExposure: { value: 1 },
    uRainLens: { value: 0 },
    // Unterwasser (0..1) und Wasserfarbe
    uUnderwater: { value: 0.2 },
    uWaterTint: { value: new THREE.Color(0x103038) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uDistortion;
    uniform float uAberration;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uGlitch;
    uniform float uExposure;
    uniform float uRainLens;
    uniform float uUnderwater;
    uniform vec3 uWaterTint;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // Tonnenverzerrung, normiert so dass die horizontalen Ränder exakt passen;
    // die Ecken fallen dadurch leicht ins Schwarze (runde Linsenkante)
    vec2 lens(vec2 uv, float k) {
      float aspect = uResolution.x / uResolution.y;
      vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
      float r2 = dot(c, c);
      float edge = 0.25 * aspect * aspect;
      c *= (1.0 + k * r2) / (1.0 + k * edge);
      return c / vec2(aspect, 1.0) + 0.5;
    }

    // Regentropfen auf der Linse: je Zelle ein Tropfen, der auftaucht, etwas abrutscht und verdunstet.
    // Liefert Brechungs-Versatz (xy) und Bedeckung (z).
    vec3 dropLayer(vec2 uv, float scale, float t, float amount) {
      float aspect = uResolution.x / uResolution.y;
      vec2 p = uv * vec2(aspect, 1.0) * scale;
      vec2 cell = floor(p);
      float h = hash(cell);
      float tt = t * (0.12 + h * 0.1) + h * 10.0;
      float life = fract(tt);
      float cyc = floor(tt);
      if (hash(cell + cyc * 1.37) > amount) return vec3(0.0);
      vec2 c = vec2(hash(cell + cyc + 3.1), hash(cell + cyc + 7.7)) * 0.6 + 0.2;
      // manche Tropfen rutschen nach unten
      c.y += step(0.7, hash(cell + cyc + 9.2)) * life * life * 0.6;
      vec2 dlt = fract(p) - c;
      dlt.y *= 1.0 + step(0.7, hash(cell + cyc + 9.2)) * 0.6;
      float r = (0.18 + hash(cell + 2.4) * 0.18) * (1.0 - life * 0.5);
      float dist = length(dlt);
      float m = (1.0 - smoothstep(r * 0.8, r, dist)) * (1.0 - smoothstep(0.75, 1.0, life));
      return vec3(-dlt / r * 0.035 / scale, m);
    }

    void main() {
      vec2 uv = vUv;
      float dropMask = 0.0;
      if (uRainLens > 0.001) {
        vec3 d1 = dropLayer(uv, 7.0, uTime, uRainLens * 0.35);
        vec3 d2 = dropLayer(uv + 0.37, 13.0, uTime * 1.3, uRainLens * 0.5);
        uv += d1.xy * d1.z + d2.xy * d2.z;
        dropMask = max(d1.z, d2.z);
      }

      // Unterwasser: Bild wabert (Lichtbrechung)
      if (uUnderwater > 0.001) {
        uv += vec2(sin(uv.y * 22.0 + uTime * 2.1), cos(uv.x * 18.0 + uTime * 1.7)) * 0.0035 * uUnderwater;
      }

      // Signal-Glitch: einzelne Zeilenblöcke horizontal versetzt
      if (uGlitch > 0.001) {
        float row = floor(uv.y * 56.0);
        float n = hash(vec2(row, floor(uTime * 45.0)));
        uv.x += (n - 0.5) * 0.05 * uGlitch * step(0.78, n);
      }

      vec2 base = lens(uv, uDistortion);
      vec2 d = base - 0.5;
      float ab = uAberration * (1.0 + uGlitch * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, 0.5 + d * (1.0 + ab)).r;
      col.g = texture2D(tDiffuse, base).g;
      col.b = texture2D(tDiffuse, 0.5 + d * (1.0 - ab)).b;
      if (uUnderwater > 0.001) {
        // Unschärfe (4 Abgriffe) und Einfärbung: Rot verschwindet zuerst, Licht wird grün-blau
        vec2 px = 2.5 / uResolution * uUnderwater;
        vec3 blur = texture2D(tDiffuse, base + vec2(px.x, px.y)).rgb + texture2D(tDiffuse, base + vec2(-px.x, px.y)).rgb
          + texture2D(tDiffuse, base + vec2(px.x, -px.y)).rgb + texture2D(tDiffuse, base + vec2(-px.x, -px.y)).rgb;
        col = mix(col, blur * 0.25, 0.65 * uUnderwater);
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 tint = normalize(uWaterTint + 0.02) * 1.2;
        col = mix(col, (l * 0.9 + 0.05) * tint * vec3(0.7, 1.0, 1.05), 0.6 * uUnderwater);
      }

      vec2 edgeDist = min(base, 1.0 - base);
      float mask = smoothstep(0.0, 0.006, min(edgeDist.x, edgeDist.y));

      col *= uExposure;
      // Tropfen streuen Licht: etwas heller, weicher Kontrast
      col = mix(col, col * 0.85 + 0.03, dropMask * 0.6);

      // Farbgebung: entsättigt, leicht kühl-grünlich, angehobene Schwärzen (billiger Sensor)
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, 0.75);
      col = (col - 0.5) * 1.07 + 0.5;
      col *= vec3(0.96, 1.02, 1.0);
      col = max(col, 0.0) * 0.97 + 0.018;

      // Vignette
      float aspect = uResolution.x / uResolution.y;
      vec2 vc = (vUv - 0.5) * vec2(aspect, 1.0);
      float vig = smoothstep(1.1, 0.3, length(vc));
      col *= mix(1.0, vig, min(1.0, uVignette + uUnderwater * 0.35));

      // Sensorrauschen, stärker in dunklen Bereichen
      float g = hash(vUv * uResolution + fract(uTime * 7.13) * 1000.0) - 0.5;
      float gc = hash(vUv * uResolution * 0.5 + fract(uTime * 3.7) * 500.0) - 0.5;
      col += (g + vec3(gc, -gc, gc) * 0.3) * uGrain * (1.25 - lum) * (1.0 + uGlitch);

      // Feine Zeilenstruktur
      col *= 0.988 + 0.012 * sin(vUv.y * uResolution.y * 0.8 + uTime * 4.0);

      gl_FragColor = vec4(col * mask, 1.0);
    }
  `,
};
