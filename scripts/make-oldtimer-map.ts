// Erzeugt src/maps/oldtimer.json: eine kleine Demo-Map mit dem Oldtimer und seinem Block-Script.
// Die Blöcke werden hier als Daten zusammengesetzt und mit dem echten Generator aus scripting/blocks.ts
// in JavaScript übersetzt — das Ergebnis ist also dasselbe wie nach „Übernehmen“ im Script-Editor.
//
//   node scripts/run-with-vite.mjs scripts/make-oldtimer-map.ts

import { writeFileSync } from 'node:fs';
import * as Blockly from 'blockly';
import { generateCode, installBlocks } from '../src/scripting/blocks.ts';

type B = Record<string, unknown>;
const VARS = ['motor', 'licht', 'tuerL', 'tuerR', 'fenster', 'haube', 'koffer', 'fach', 'tempo', 'ziel', 'lenk', 'lenkZiel'];
const vid = (name: string) => `v_${name}`;

const num = (v: number) => ({ shadow: { type: 'math_number', fields: { NUM: v } } });
const val = (b: B) => ({ block: b });
const txt = (s: string) => ({ shadow: { type: 'text', fields: { TEXT: s } } });
/** Blöcke untereinander hängen */
const seq = (...blocks: B[]): B => {
  for (let i = blocks.length - 2; i >= 0; i--) blocks[i] = { ...blocks[i], next: { block: blocks[i + 1] } };
  return blocks[0];
};
const get = (name: string): B => ({ type: 'variables_get', fields: { VAR: { id: vid(name) } } });
const set = (name: string, v: number | B): B => ({ type: 'variables_set', fields: { VAR: { id: vid(name) } }, inputs: { VALUE: typeof v === 'number' ? num(v) : val(v) } });
const n = (v: number): B => ({ type: 'math_number', fields: { NUM: v } });
const arith = (op: 'ADD' | 'MINUS' | 'MULTIPLY' | 'DIVIDE', a: B, b: B): B => ({ type: 'math_arithmetic', fields: { OP: op }, inputs: { A: val(a), B: val(b) } });
const mul = (a: B, b: B) => arith('MULTIPLY', a, b);
const eq = (name: string, v: number): B => ({ type: 'logic_compare', fields: { OP: 'EQ' }, inputs: { A: val(get(name)), B: val(n(v)) } });
const ifThen = (cond: B, then: B, otherwise?: B): B => ({
  type: 'controls_if',
  ...(otherwise ? { extraState: { hasElse: true } } : {}),
  inputs: { IF0: val(cond), DO0: { block: then }, ...(otherwise ? { ELSE: { block: otherwise } } : {}) },
});
const key = (code: string): B => ({ type: 'bc_key_down', fields: { KEY: code } });
const dt = (): B => ({ type: 'bc_dt' });
const sound = (id: string, v = 100): B => ({ type: 'bc_sound', fields: { ID: id }, inputs: { V: num(v) } });
const turnTo = (part: string, axis: string, deg: number, sec: number): B => ({ type: 'bc_part_turn_to', fields: { PART: part, AXIS: axis }, inputs: { S: num(sec), DEG: num(deg) } });
const spin = (part: string, axis: string, v: number | B): B => ({ type: 'bc_part_spin', fields: { PART: part, AXIS: axis }, inputs: { V: typeof v === 'number' ? num(v) : val(v) } });
const angle = (part: string, axis: string, v: B): B => ({ type: 'bc_part_set_angle', fields: { PART: part, AXIS: axis }, inputs: { DEG: val(v) } });
const glow = (part: string, c: string, v: number): B => ({ type: 'bc_part_glow', fields: { PART: part, C: c }, inputs: { V: num(v) } });
const whenPart = (part: string, hint: string): B => ({ type: 'bc_when_part_interact', fields: { PART: part, TEXT: hint } });
const whenKey = (code: string): B => ({ type: 'bc_when_key', fields: { KEY: code } });
const send = (msg: string): B => ({ type: 'bc_broadcast', fields: { MSG: msg } });

/** Klappe/Tür: Benutzen wechselt zwischen offen und zu */
const flap = (part: string, hint: string, state: string, axis: string, deg: number, openSound: string, closeSound: string, openSec = 0.9): B =>
  seq(
    whenPart(part, hint),
    ifThen(
      eq(state, 0),
      seq(set(state, 1), sound(openSound), turnTo(part, axis, deg, openSec)),
      seq(set(state, 0), turnTo(part, axis, 0, openSec * 0.75), sound(closeSound)),
    ),
  );

/** weiches Nachführen: name = name + (ziel − name) × dt × rate */
const follow = (name: string, target: B, rate: number): B => set(name, arith('ADD', get(name), mul(mul(arith('MINUS', target, get(name)), dt()), n(rate))));

const tops: B[] = [
  seq(
    { type: 'bc_when_start' },
    ...VARS.map((v) => set(v, 0)),
    { type: 'bc_show_text', inputs: { TEXT: txt('Oldtimer — E: Türen, Fenster, Haube, Kofferraum · M: Motor · L: Licht · H: Hupe · Pfeiltasten: fahren'), S: num(8) } },
  ),
  flap('Door_L', 'Fahrertür', 'tuerL', 'y', -65, 'door_open', 'door_close'),
  flap('Door_R', 'Beifahrertür', 'tuerR', 'y', 65, 'door_open', 'door_close'),
  flap('Hood', 'Motorhaube', 'haube', 'x', -50, 'squeak', 'thud', 1.2),
  flap('Trunk_Lid', 'Kofferraum', 'koffer', 'x', 65, 'squeak', 'thud', 1.1),
  flap('Glovebox_Door', 'Handschuhfach', 'fach', 'x', -70, 'click', 'click', 0.4),
  // Fahrerfenster kurbeln
  seq(
    whenPart('Door_L_Glass', 'Fenster'),
    ifThen(
      eq('fenster', 0),
      seq(set('fenster', 1), { type: 'bc_part_move', fields: { PART: 'Door_L_Glass' }, inputs: { S: num(1.4), X: num(0), Y: num(-0.42), Z: num(0) } }),
      seq(set('fenster', 0), { type: 'bc_part_move', fields: { PART: 'Door_L_Glass' }, inputs: { S: num(1.4), X: num(0), Y: num(0), Z: num(0) } }),
    ),
  ),
  // Zündung: am Lenkrad oder mit M
  seq(whenPart('Steering_Wheel', 'Motor starten / abstellen'), send('zuendung')),
  seq(whenKey('KeyM'), send('zuendung')),
  seq(
    { type: 'bc_when_message', fields: { MSG: 'zuendung' } },
    ifThen(
      eq('motor', 0),
      seq(
        set('motor', 2),
        sound('starter'),
        { type: 'bc_wait', inputs: { S: num(1.1) } },
        { type: 'bc_loop_start', fields: { ID: 'engine' }, inputs: { V: num(80) } },
        spin('Engine_Fan', 'z', 1400),
        set('motor', 1),
      ),
      ifThen(eq('motor', 1), seq(set('motor', 0), { type: 'bc_loop_stop', fields: { ID: 'engine' } }, sound('engine_off'), spin('Engine_Fan', 'z', 0))),
    ),
  ),
  // Licht
  seq(
    whenKey('KeyL'),
    sound('click'),
    ifThen(
      eq('licht', 0),
      seq(set('licht', 1), glow('Headlight_L_Lens', '#fff2c0', 8), glow('Headlight_R_Lens', '#fff2c0', 8), glow('Taillight_L_Lens', '#ff2010', 4), glow('Taillight_R_Lens', '#ff2010', 4)),
      seq(set('licht', 0), glow('Headlight_L_Lens', '#fff2c0', 0), glow('Headlight_R_Lens', '#fff2c0', 0), glow('Taillight_L_Lens', '#ff2010', 0), glow('Taillight_R_Lens', '#ff2010', 0)),
    ),
  ),
  seq(whenKey('KeyH'), sound('horn')),
  // Fahren: Pfeiltasten geben Ziel-Tempo und Lenkung vor, alles wird weich nachgeführt
  seq(
    { type: 'bc_when_tick' },
    set('ziel', 0),
    set('lenkZiel', 0),
    ifThen(eq('motor', 1), seq(ifThen(key('ArrowUp'), set('ziel', 7)), ifThen(key('ArrowDown'), set('ziel', -3)))),
    ifThen(key('ArrowLeft'), set('lenkZiel', 1)),
    ifThen(key('ArrowRight'), set('lenkZiel', -1)),
    follow('tempo', get('ziel'), 1.2),
    follow('lenk', get('lenkZiel'), 4),
    // Das Auto schaut nach +Z, „vorwärts“ der Engine ist −Z → negatives Vorzeichen
    { type: 'bc_move_forward', inputs: { D: val(mul(mul(get('tempo'), dt()), n(-1))) } },
    { type: 'bc_rotate_by', inputs: { X: num(0), Y: val(mul(mul(mul(get('lenk'), get('tempo')), dt()), n(9))), Z: num(0) } },
    // Räder: 1 m/s = 161 °/s bei 0,355 m Radius
    ...['Wheel_FL', 'Wheel_FR', 'Wheel_RL', 'Wheel_RR'].map((w) => spin(w, 'x', mul(get('tempo'), n(161)))),
    angle('Wheel_FL', 'y', mul(get('lenk'), n(28))),
    angle('Wheel_FR', 'y', mul(get('lenk'), n(28))),
    angle('Steering_Wheel', 'y', mul(get('lenk'), n(120))),
    { type: 'bc_loop_pitch', fields: { ID: 'engine' }, inputs: { V: val(arith('ADD', n(100), mul({ type: 'math_single', fields: { OP: 'ABS' }, inputs: { NUM: val(get('tempo')) } }, n(18)))) } },
  ),
];

// Blöcke im Arbeitsbereich in zwei Spalten anordnen
let col = 0;
let y = [20, 20];
const blocks = tops.map((b) => {
  let h = 0;
  for (let c: B | undefined = b; c; c = (c.next as { block: B } | undefined)?.block) h += JSON.stringify(c).includes('controls_if') ? 260 : 44;
  const placed = { ...b, x: 20 + col * 900, y: y[col] };
  y[col] += h + 40;
  col = y[0] <= y[1] ? 0 : 1;
  return placed;
});
const workspaceJson = { blocks: { languageVersion: 0, blocks }, variables: VARS.map((name) => ({ name, id: vid(name) })) };

installBlocks();
const ws = new Blockly.Workspace();
Blockly.serialization.workspaces.load(workspaceJson, ws);
const code = generateCode(ws);
new Function('api', code); // Syntaxprüfung
const saved = Blockly.serialization.workspaces.save(ws);

const box = (id: string, name: string, pos: number[], scale: number[], material: string, extra: B = {}) => ({
  id,
  name,
  type: 'box',
  pos,
  rot: [0, 0, 0],
  scale,
  props: { material, color: '#ffffff', roughness: 0.8, metalness: 0, emissive: '#000000', emissiveIntensity: 0, uvScale: 2, castShadow: false, collision: true, ...extra },
});

const map = {
  format: 'bodycam-map',
  version: 2,
  name: 'Oldtimer',
  world: {
    background: '#8fa3b8',
    sky: true,
    hemiIntensity: 0.7,
    sunColor: '#fff1d6',
    sunIntensity: 1.6,
    sunAzimuth: 130,
    sunElevation: 42,
    sunShadow: true,
    sunShadowDistance: 80,
    viewDistance: 300,
    groundFog: false,
    groundPlane: true,
  },
  objects: [
    box('ot_boden', 'Platz', [0, -0.05, 0], [80, 0.1, 80], 'beton_dunkel'),
    {
      id: 'ot_auto',
      name: 'Oldtimer',
      type: 'model',
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      scale: [1, 1, 1],
      props: { model: '/assets/models/oldtimer.glb', collision: 'bounds', simulate: false, mass: 1400, buoyancy: 1, castShadow: true },
      script: { blocks: saved, code },
    },
    { id: 'ot_spawn', name: 'Player Start', type: 'spawn', pos: [3.2, 0, 1.2], rot: [0, 90, 0], scale: [1, 1, 1], props: {} },
  ],
};
writeFileSync(new URL('../src/maps/oldtimer.json', import.meta.url), JSON.stringify(map, null, 2) + '\n');
console.log(`oldtimer.json geschrieben: ${ws.getAllBlocks(false).length} Blöcke, ${code.split('\n').length} Zeilen Code`);
