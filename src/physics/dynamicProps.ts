import * as THREE from 'three';
import { RAPIER, WORLD_MEMBER, type PhysicsWorld } from './physics.ts';
import type { MapNode } from '../world/mapLoader.ts';
import type { Collider } from '../world/collision.ts';
import { waterAt, waterImpulse, waterObstacle, waterSplash, type WaterSample } from '../world/water/registry.ts';

// Simulierte Props (Phase 6): Objekte mit „Physik › Simuliert“ werden zu dynamischen Rapier-Körpern.
// Auftrieb an 8 Stützpunkten (Ecken der Hülle, leicht nach innen): je Punkt ein Achtel des Volumens,
// eingetauchter Anteil aus der Wasserhöhe inkl. Wellen → schwimmen, schaukeln, kippen sich auf.
// Strömungswiderstand je Punkt zieht treibende Objekte mit dem Fluss. Der Spieler schiebt sie (KCC-Impulse),
// Kugeln stoßen sie an. Die Transformation wird jeden Frame auf den Map-Knoten zurückgeschrieben.

const RHO = 1000; // Dichte Wasser (kg/m³)
const G = 9.81;
const WATER_DRAG = 2.2; // linearer Widerstand je Punkt (× Masse/8 × Eintauchanteil), 1/s
const WATER_HEAVE = 7; // zusätzliche Dämpfung vertikal (Auf-und-ab-Schwingen klingt in wenigen Perioden ab), 1/s
const WATER_ANG_DAMP = 1.5;
const AIR_LIN_DAMP = 0.02;
const AIR_ANG_DAMP = 0.05;
const BULLET_IMPULSE = 9; // N·s

export interface PropSplash {
  pos: THREE.Vector3;
  /** 0..1 */
  strength: number;
}

interface Prop {
  node: MapNode;
  body: RAPIER.RigidBody;
  /** Stützpunkte im Körper-Raum */
  points: THREE.Vector3[];
  /** Volumen je Stützpunkt (m³) */
  pointVol: number;
  /** Halbachsen eines Oktanten (Körper-Raum) → vertikale Ausdehnung je nach Lage */
  oct: THREE.Vector3;
  /** mittlere Halbachse (Wellenring-Größe) */
  size: number;
  mass: number;
  buoyancy: number;
  wet: number;
  wakeT: number;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _box = new THREE.Box3();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _up = new THREE.Vector3();
const _qi = new THREE.Quaternion();

export class DynamicProps {
  private props: Prop[] = [];
  private ws: WaterSample = { height: 0, base: 0, flowX: 0, flowZ: 0, fade: 1, body: null };
  /** Objekt klatscht ins Wasser (Geräusch) */
  onSplash?: (s: PropSplash) => void;

  constructor(
    private physics: PhysicsWorld,
    nodes: readonly MapNode[],
    private colliders: Collider[],
  ) {
    for (const node of nodes) {
      if (node.data.props.simulate !== true || node.data.hidden || !node.instance) continue;
      // statische Collider entfernen; Modelle erst nach dem Laden (Hülle bekannt)
      const add = () => {
        this.removeStatic(node);
        const p = this.create(node);
        if (p) this.props.push(p);
      };
      this.removeStatic(node);
      if (node.instance.ready) void node.instance.ready.then(add);
      else add();
    }
  }

  /** Wurzeln der simulierten Objekte (bewegen sich — keine festen Hindernisse für die Wellen) */
  get roots(): THREE.Object3D[] {
    return this.props.map((p) => p.node.root);
  }

  get count(): number {
    return this.props.length;
  }

  private removeStatic(node: MapNode): void {
    for (const c of node.colliders) {
      const i = this.colliders.indexOf(c);
      if (i >= 0) this.colliders.splice(i, 1);
    }
    node.colliders = [];
    node.collisionEnabled = false; // refreshColliders (Scripts, Modell geladen) baut keine statischen mehr
  }

  private create(node: MapNode): Prop | null {
    const root = node.root;
    root.updateMatrixWorld(true);
    // Hülle aller Meshes im (unskalierten) Raum des Knotens
    _inv.copy(root.matrixWorld).invert();
    const local = new THREE.Box3();
    node.instance!.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      mesh.geometry.computeBoundingBox();
      local.union(_box.copy(mesh.geometry.boundingBox!).applyMatrix4(_m.multiplyMatrices(_inv, mesh.matrixWorld)));
    });
    if (local.isEmpty()) return null;
    const scale = root.getWorldScale(new THREE.Vector3());
    const center = local.getCenter(new THREE.Vector3()).multiply(scale);
    const half = local.getSize(new THREE.Vector3()).multiply(scale).multiplyScalar(0.5);
    half.set(Math.max(Math.abs(half.x), 0.02), Math.max(Math.abs(half.y), 0.02), Math.max(Math.abs(half.z), 0.02));

    const mass = Math.max(0.5, Number(node.data.props.mass ?? 40));
    const buoyancy = Math.max(0, Number(node.data.props.buoyancy ?? 1));
    root.getWorldPosition(_p);
    root.getWorldQuaternion(_q);
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(_p.x, _p.y, _p.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinearDamping(AIR_LIN_DAMP)
        .setAngularDamping(AIR_ANG_DAMP)
        .setCcdEnabled(true),
    );
    const cyl = node.data.type === 'cylinder';
    const radius = Math.max(half.x, half.z);
    const desc = cyl ? RAPIER.ColliderDesc.cylinder(half.y, radius) : RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z);
    desc.setTranslation(center.x, center.y, center.z).setMass(mass).setFriction(0.7).setRestitution(0.1).setCollisionGroups(WORLD_MEMBER);
    this.physics.world.createCollider(desc, body);

    const volume = cyl ? Math.PI * radius * radius * half.y * 2 : half.x * half.y * half.z * 8;
    // Punkte in den Mitten der 8 Oktanten: jeder steht für ein Achtel der Hülle (Höhe = halbe Halbachse)
    const k = 0.5;
    const points: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) points.push(new THREE.Vector3(center.x + sx * half.x * k, center.y + sy * half.y * k, center.z + sz * half.z * k));
    const oct = half.clone().multiplyScalar(0.5);
    const size = (half.x + half.y + half.z) / 3;
    return { node, body, points, pointVol: volume / points.length, oct, size, mass, buoyancy, wet: 0, wakeT: 0 };
  }

  /** Nach dem Physik-Schritt: Transformation zurückschreiben, Auftrieb/Widerstand für den nächsten Schritt setzen */
  update(dt: number): void {
    for (const p of this.props) {
      const b = p.body;
      const t = b.translation();
      const r = b.rotation();
      const root = p.node.root;
      if (t.y < -500) {
        // aus der Welt gefallen: einfrieren
        b.setEnabled(false);
        continue;
      }
      _q.set(r.x, r.y, r.z, r.w);
      root.position.set(t.x, t.y, t.z);
      root.quaternion.copy(_q);

      b.resetForces(false);
      b.resetTorques(false);
      if (!b.isEnabled()) continue;
      let submerged = 0;
      let sx = 0;
      let sz = 0;
      let flowX = 0;
      let flowZ = 0;
      const lv = b.linvel();
      const av = b.angvel();
      const share = p.mass / p.points.length;
      // halbe Höhe eines Oktanten in Weltrichtung Y (liegend/stehend/gekippt) → eingetauchter Anteil je Punkt
      _up.set(0, 1, 0).applyQuaternion(_qi.copy(_q).invert());
      const ext = Math.max(0.02, Math.abs(_up.x) * p.oct.x + Math.abs(_up.y) * p.oct.y + Math.abs(_up.z) * p.oct.z);
      for (const lp of p.points) {
        const wp = _v.copy(lp).applyQuaternion(_q).add(_p.set(t.x, t.y, t.z));
        const w = waterAt(wp.x, wp.z, this.ws);
        if (!w) continue;
        const frac = THREE.MathUtils.clamp((w.height - wp.y) / (2 * ext) + 0.5, 0, 1);
        if (frac <= 0) continue;
        submerged += frac;
        sx += wp.x;
        sz += wp.z;
        flowX += w.flowX;
        flowZ += w.flowZ;
        // Auftrieb
        const fy = RHO * G * p.pointVol * frac * p.buoyancy;
        // Widerstand gegen Relativbewegung zur Strömung (Punktgeschwindigkeit = v + ω × r)
        const rx = wp.x - t.x;
        const ry = wp.y - t.y;
        const rz = wp.z - t.z;
        const vx = lv.x + av.y * rz - av.z * ry - w.flowX;
        const vy = lv.y + av.z * rx - av.x * rz;
        const vz = lv.z + av.x * ry - av.y * rx - w.flowZ;
        const d = WATER_DRAG * share * frac;
        const dy = d + WATER_HEAVE * share * Math.min(1, frac * 3);
        b.addForceAtPoint({ x: -vx * d, y: fy - vy * dy, z: -vz * d }, { x: wp.x, y: wp.y, z: wp.z }, true);
      }
      const n = p.points.length;
      const wetNow = submerged / n;
      b.setAngularDamping(AIR_ANG_DAMP + WATER_ANG_DAMP * wetNow);
      if (submerged > 0) {
        const cx = sx / submerged;
        const cz = sz / submerged;
        // Aufschlag aufs Wasser
        if (p.wet < 0.05 && wetNow >= 0.05 && lv.y < -2) {
          const strength = Math.min(1, (-lv.y / 8) * Math.min(1, p.mass / 40));
          const at = new THREE.Vector3(cx, this.ws.height, cz);
          waterSplash(at, 0.6 + strength * 1.6);
          waterImpulse(cx, cz, 0.8 + p.size, -0.08 - strength * 0.2);
          this.onSplash?.({ pos: at, strength });
        }
        // ragt durch die Oberfläche: Hindernis für die Wellenringe (Reflexion, Anströmung)
        if (wetNow < 0.98) waterObstacle(cx, cz, Math.max(0.12, p.size * 0.9), flowX / submerged - lv.x, flowZ / submerged - lv.z, Math.min(1, 0.4 + p.size));
        // Bugwelle beim Treiben/Schieben
        p.wakeT -= dt;
        const rel = Math.hypot(lv.x - flowX / submerged, lv.z - flowZ / submerged) + Math.abs(lv.y) * 0.5;
        if (p.wakeT <= 0 && rel > 0.25 && wetNow < 0.98) {
          p.wakeT = 0.15;
          waterImpulse(cx, cz, 0.4 + p.size, -Math.min(0.05, rel * 0.02));
        }
      }
      p.wet = wetNow;
    }
  }

  /** Kugeltreffer: Objekt anstoßen; true, wenn es ein simuliertes Prop war */
  hit(object: THREE.Object3D | null | undefined, point: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (!object) return false;
    for (const p of this.props) {
      let o: THREE.Object3D | null = object;
      while (o && o !== p.node.root) o = o.parent;
      if (!o) continue;
      const k = BULLET_IMPULSE;
      p.body.applyImpulseAtPoint({ x: dir.x * k, y: dir.y * k, z: dir.z * k }, { x: point.x, y: point.y, z: point.z }, true);
      return true;
    }
    return false;
  }

  dispose(): void {
    for (const p of this.props) this.physics.world.removeRigidBody(p.body);
    this.props = [];
  }
}
