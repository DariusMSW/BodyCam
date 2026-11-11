import * as Blockly from 'blockly';
import { javascriptGenerator, Order } from 'blockly/javascript';
import * as De from 'blockly/msg/de';
import { registerFieldColour, colourPicker } from '@blockly/field-colour';
import { WEATHER_OPTIONS } from '../world/weather.ts';
import { LOOP_OPTIONS, SOUND_OPTIONS } from '../audio/scriptSounds.ts';

// Scratch-ähnliche Blöcke für Map-Objekte (nur im Editor geladen).
// Jeder Ereignis-Block ("Wenn ...") wird zu  api.on('<event>', async () => { ... }, <arg>);
// Die Runtime (runtime.ts) stellt die api-Funktionen bereit.

export const CATEGORY_COLOURS = {
  events: '#FFBF00',
  motion: '#4C97FF',
  looks: '#9966FF',
  light: '#E6A700',
  effects: '#E0522D',
  control: '#FFAB19',
  sensing: '#5CB1D6',
  operators: '#59C059',
  variables: '#FF8C1A',
  world: '#FF6680',
  parts: '#0FBD8C',
  sound: '#CF63CF',
};

// ---------- Modell-Teile: Auswahlliste mit den Knotennamen des gerade bearbeiteten Modells ----------

let scriptParts: string[] = [];
/** Namen, die in geladenen Blöcken stehen — bleiben wählbar, auch wenn das Modell sie (noch) nicht liefert */
const usedParts = new Set<string>();

/** Vom Script-Editor gesetzt: benannte Teile (glb-Knoten) des Objekts, dessen Script gerade offen ist. Leere Liste = neues Script */
export function setScriptParts(names: string[]): void {
  if (!names.length) usedParts.clear();
  scriptParts = [...names].sort((a, b) => a.localeCompare(b));
}

const partOptions = (): Blockly.MenuOption[] => {
  const names = [...scriptParts, ...[...usedParts].filter((n) => !scriptParts.includes(n)).sort()];
  return names.length ? names.map((n) => [n, n] as [string, string]) : [['(kein Teil)', '']];
};

/** Auswahlfeld für Teile: nimmt auch Namen an, die (noch) nicht in der Liste stehen — z. B. vor dem Laden des Modells */
class PartField extends Blockly.FieldDropdown {
  constructor() {
    super(partOptions);
  }

  protected override doClassValidation_(v?: string): string | null {
    if (typeof v !== 'string') return null;
    if (v) usedParts.add(v);
    return v;
  }

  protected override doValueUpdate_(v: string): void {
    // Blockly merkt sich die erzeugte Liste — vor dem Übernehmen neu aufbauen, sonst fehlt der eben geladene Name
    this.getOptions(false);
    super.doValueUpdate_(v);
  }
}

const PART_BLOCKS: string[] = [];
const part = (): Json => ({ type: 'field_dropdown', name: 'PART', options: [['(kein Teil)', '']] });

const KEY_OPTIONS: [string, string][] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [c, `Key${c}`] as [string, string]),
  ...'0123456789'.split('').map((c) => [c, `Digit${c}`] as [string, string]),
  ['Leertaste', 'Space'],
  ['Pfeil hoch', 'ArrowUp'],
  ['Pfeil runter', 'ArrowDown'],
  ['Pfeil links', 'ArrowLeft'],
  ['Pfeil rechts', 'ArrowRight'],
  ['Enter', 'Enter'],
  ['Shift', 'ShiftLeft'],
  ['Strg', 'ControlLeft'],
];
const AXIS: [string, string][] = [
  ['x', 'x'],
  ['y', 'y'],
  ['z', 'z'],
];
const AXIS_Y: [string, string][] = [
  ['y (hoch)', 'y'],
  ['x (quer)', 'x'],
  ['z (längs)', 'z'],
];
const ON_OFF: [string, string][] = [
  ['an', 'true'],
  ['aus', 'false'],
];

type Json = Record<string, unknown>;
const num = (name: string): Json => ({ type: 'input_value', name, check: 'Number' });
const bool = (name: string): Json => ({ type: 'input_value', name, check: 'Boolean' });
const any = (name: string): Json => ({ type: 'input_value', name });
const colour = (name: string, value = '#ff4040'): Json => ({ type: 'field_colour', name, colour: value });

const hat = (type: string, message: string, args: Json[], tooltip: string): Json => ({
  type,
  message0: message,
  args0: args,
  nextStatement: null,
  colour: CATEGORY_COLOURS.events,
  tooltip,
});
const stmt = (type: string, colourKey: keyof typeof CATEGORY_COLOURS, message: string, args: Json[] = [], tooltip = ''): Json => ({
  type,
  message0: message,
  args0: args,
  previousStatement: null,
  nextStatement: null,
  colour: CATEGORY_COLOURS[colourKey],
  tooltip,
  inputsInline: true,
});
const reporter = (type: string, colourKey: keyof typeof CATEGORY_COLOURS, message: string, args: Json[] = [], output = 'Number', tooltip = ''): Json => ({
  type,
  message0: message,
  args0: args,
  output,
  colour: CATEGORY_COLOURS[colourKey],
  tooltip,
  inputsInline: true,
});

const BLOCKS: Json[] = [
  // Ereignisse
  hat('bc_when_start', 'Wenn das Spiel startet', [], 'Läuft einmal beim Start der Map.'),
  hat('bc_when_tick', 'Jeden Frame', [], 'Läuft in jedem Frame (wartet, bis der vorige Durchlauf fertig ist).'),
  hat('bc_when_interact', 'Wenn Spieler mich benutzt, Hinweis %1', [{ type: 'field_input', name: 'TEXT', text: 'Benutzen' }], 'Spieler schaut das Objekt an und drückt die Benutzen-Taste (E). Der Hinweis erscheint am Bildschirm.'),
  hat('bc_when_hit', 'Wenn ich getroffen werde', [], 'Ein Schuss trifft dieses Objekt.'),
  hat('bc_when_enter', 'Wenn Spieler meinen Bereich betritt', [], 'Spieler betritt das Objekt (ideal mit Trigger-Volumen).'),
  hat('bc_when_leave', 'Wenn Spieler meinen Bereich verlässt', [], 'Spieler verlässt das Objekt (ideal mit Trigger-Volumen).'),
  hat('bc_when_near', 'Wenn Spieler näher als %1 m kommt', [{ type: 'field_number', name: 'DIST', value: 3, min: 0 }], 'Löst einmal aus, wenn der Spieler die Entfernung unterschreitet.'),
  hat('bc_when_key', 'Wenn Taste %1 gedrückt wird', [{ type: 'field_dropdown', name: 'KEY', options: KEY_OPTIONS }], ''),
  hat('bc_when_message', 'Wenn ich Nachricht %1 empfange', [{ type: 'field_input', name: 'MSG', text: 'Nachricht1' }], 'Reagiert auf "sende Nachricht" von beliebigen Objekten.'),
  stmt('bc_broadcast', 'events', 'sende Nachricht %1', [{ type: 'field_input', name: 'MSG', text: 'Nachricht1' }], 'Alle Objekte mit "Wenn ich Nachricht empfange" reagieren.'),

  // Modell-Teile
  hat('bc_when_part_interact', 'Wenn Spieler Teil %1 benutzt, Hinweis %2', [part(), { type: 'field_input', name: 'TEXT', text: 'Öffnen' }], 'Spieler schaut genau dieses Teil des Modells an (z. B. eine Tür) und drückt die Benutzen-Taste (E).'),
  stmt('bc_part_turn_to', 'parts', 'drehe Teil %1 in %2 Sek. auf %3° um Achse %4', [part(), num('S'), num('DEG'), { type: 'field_dropdown', name: 'AXIS', options: AXIS_Y }], 'Winkel gegenüber der Ruhelage: 0° = wie im Modell. Wartet, bis die Drehung fertig ist. Ideal für Türen und Klappen.'),
  stmt('bc_part_turn_by', 'parts', 'drehe Teil %1 in %2 Sek. um %3° weiter, Achse %4', [part(), num('S'), num('DEG'), { type: 'field_dropdown', name: 'AXIS', options: AXIS_Y }]),
  stmt('bc_part_set_angle', 'parts', 'setze Winkel von Teil %1 auf %2° um Achse %3', [part(), num('DEG'), { type: 'field_dropdown', name: 'AXIS', options: AXIS_Y }], 'Sofort, ohne Animation — z. B. Lenkeinschlag in „Jeden Frame“.'),
  stmt('bc_part_spin', 'parts', 'drehe Teil %1 dauerhaft mit %2 °/Sek. um Achse %3', [part(), num('V'), { type: 'field_dropdown', name: 'AXIS', options: AXIS_Y }], 'Läuft weiter, bis 0 gesetzt wird — Räder, Lüfter, Propeller.'),
  stmt('bc_part_move', 'parts', 'verschiebe Teil %1 in %2 Sek. auf x %3 y %4 z %5', [part(), num('S'), num('X'), num('Y'), num('Z')], 'Abstand zur Ruhelage in Metern (0/0/0 = wie im Modell) — Schubladen, Fensterscheiben.'),
  stmt('bc_part_reset', 'parts', 'setze Teil %1 in %2 Sek. zurück', [part(), num('S')], 'Zurück in die Ruhelage, stoppt auch die Dauerdrehung.'),
  stmt('bc_part_show', 'parts', '%1 Teil %2', [{ type: 'field_dropdown', name: 'SHOW', options: [['zeige', 'true'], ['verstecke', 'false']] }, part()]),
  stmt('bc_part_color', 'parts', 'färbe Teil %1 in %2', [part(), colour('C', '#2060c0')]),
  stmt('bc_part_glow', 'parts', 'Teil %1 leuchtet in %2 mit Stärke %3', [part(), colour('C', '#fff2c0'), num('V')], 'Stärke 0 = aus. Für Scheinwerfer, Rücklichter, Anzeigen.'),
  reporter('bc_part_angle', 'parts', 'Winkel von Teil %1 um Achse %2', [part(), { type: 'field_dropdown', name: 'AXIS', options: AXIS_Y }]),

  // Klang
  stmt('bc_sound', 'sound', 'spiele Klang %1 mit Lautstärke %2 %', [{ type: 'field_dropdown', name: 'ID', options: SOUND_OPTIONS }, num('V')], 'Kurzer Klang am Ort des Objekts — weiter weg wird er leiser.'),
  stmt('bc_sound_file', 'sound', 'spiele Audiodatei %1 mit Lautstärke %2 %', [{ type: 'field_input', name: 'FILE', text: 'klang.mp3' }, num('V')], 'Datei aus public/assets/audio (mp3, ogg, wav).'),
  stmt('bc_loop_start', 'sound', 'starte Dauerklang %1 mit Lautstärke %2 %', [{ type: 'field_dropdown', name: 'ID', options: LOOP_OPTIONS }, num('V')], 'Läuft, bis er gestoppt wird.'),
  stmt('bc_loop_stop', 'sound', 'stoppe Dauerklang %1', [{ type: 'field_dropdown', name: 'ID', options: LOOP_OPTIONS }]),
  stmt('bc_loop_pitch', 'sound', 'setze Tonhöhe von Dauerklang %1 auf %2 %', [{ type: 'field_dropdown', name: 'ID', options: LOOP_OPTIONS }, num('V')], '100 % = normal. Beim Motor = Drehzahl.'),
  stmt('bc_loop_volume', 'sound', 'setze Lautstärke von Dauerklang %1 auf %2 %', [{ type: 'field_dropdown', name: 'ID', options: LOOP_OPTIONS }, num('V')]),
  reporter('bc_loop_is_on', 'sound', 'Dauerklang %1 läuft?', [{ type: 'field_dropdown', name: 'ID', options: LOOP_OPTIONS }], 'Boolean'),
  reporter('bc_dt', 'sensing', 'Sekunden seit letztem Frame', [], 'Number', 'Damit Bewegung in „Jeden Frame“ bei jeder Bildrate gleich schnell ist: Tempo × diese Zahl.'),

  // Bewegung
  stmt('bc_move_by', 'motion', 'ändere Position um x %1 y %2 z %3', [num('X'), num('Y'), num('Z')]),
  stmt('bc_move_to', 'motion', 'gehe zu x %1 y %2 z %3', [num('X'), num('Y'), num('Z')]),
  stmt('bc_move_forward', 'motion', 'gehe %1 m vorwärts', [num('D')], 'In Blickrichtung des Objekts (lokal -Z).'),
  stmt('bc_glide_by', 'motion', 'gleite in %1 Sek. um x %2 y %3 z %4', [num('S'), num('X'), num('Y'), num('Z')], 'Bewegt sich weich und wartet, bis es angekommen ist.'),
  stmt('bc_glide_to', 'motion', 'gleite in %1 Sek. zu x %2 y %3 z %4', [num('S'), num('X'), num('Y'), num('Z')]),
  stmt('bc_rotate_by', 'motion', 'drehe um x %1° y %2° z %3°', [num('X'), num('Y'), num('Z')]),
  stmt('bc_turn_by', 'motion', 'drehe in %1 Sek. um x %2° y %3° z %4°', [num('S'), num('X'), num('Y'), num('Z')], 'Weiche Drehung, z. B. für Türen.'),
  stmt('bc_set_rotation', 'motion', 'setze Drehung auf x %1° y %2° z %3°', [num('X'), num('Y'), num('Z')]),
  stmt('bc_set_scale', 'motion', 'setze Größe auf x %1 y %2 z %3', [num('X'), num('Y'), num('Z')]),
  reporter('bc_pos', 'motion', 'Position %1', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }]),
  reporter('bc_rot', 'motion', 'Drehung %1', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }]),

  // Aussehen
  stmt('bc_show', 'looks', 'zeige dich'),
  stmt('bc_hide', 'looks', 'verstecke dich', [], 'Nur unsichtbar — Kollision bleibt (siehe "setze Kollision").'),
  stmt('bc_set_color', 'looks', 'setze Farbe auf %1', [colour('C', '#ff4040')]),
  stmt('bc_set_glow', 'looks', 'leuchte in %1 mit Stärke %2', [colour('C', '#3fc4ff'), num('V')]),
  stmt('bc_collision', 'looks', 'setze Kollision %1', [{ type: 'field_dropdown', name: 'ON', options: ON_OFF }]),

  // Licht
  stmt('bc_light_set', 'light', 'Licht %1', [{ type: 'field_dropdown', name: 'MODE', options: [['einschalten', 'on'], ['ausschalten', 'off'], ['umschalten', 'toggle']] }], 'Nur für Licht-Objekte.'),
  stmt('bc_light_intensity', 'light', 'setze Lichtintensität auf %1', [num('V')]),
  stmt('bc_light_change', 'light', 'ändere Lichtintensität um %1', [num('V')]),
  stmt('bc_light_color', 'light', 'setze Lichtfarbe auf %1', [colour('C', '#ffd8a0')]),
  stmt('bc_light_flicker', 'light', 'setze Flackern %1', [{ type: 'field_dropdown', name: 'ON', options: ON_OFF }]),
  reporter('bc_light_is_on', 'light', 'Licht ist an?', [], 'Boolean'),
  // Effekte (Feuer, Rauch, Funken)
  stmt('bc_fx_set', 'effects', 'Effekt %1', [{ type: 'field_dropdown', name: 'MODE', options: [['starten', 'on'], ['stoppen', 'off'], ['umschalten', 'toggle']] }], 'Nur für Feuer, Rauch und Funken. Feuer brennt sanft an bzw. aus.'),
  stmt('bc_fx_intensity', 'effects', 'setze Effektstärke auf %1 %', [num('V')], '100 % = wie im Editor eingestellt, bis 300 %.'),
  stmt('bc_fx_burst', 'effects', 'Effekt-Ausbruch Stärke %1', [num('V')], 'Feuer: Stichflamme, Rauch: Rauchstoß, Funken: Funkenregen. 1 = normal.'),
  reporter('bc_fx_is_on', 'effects', 'Effekt ist aktiv?', [], 'Boolean'),

  // Steuerung
  stmt('bc_wait', 'control', 'warte %1 Sek.', [num('S')]),
  {
    type: 'bc_forever',
    message0: 'wiederhole fortlaufend %1 %2',
    args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
    previousStatement: null,
    colour: CATEGORY_COLOURS.control,
  },
  stmt('bc_wait_until', 'control', 'warte bis %1', [bool('COND')]),
  { ...stmt('bc_stop', 'control', 'stoppe dieses Script'), nextStatement: undefined },

  // Fühlen
  reporter('bc_distance', 'sensing', 'Entfernung zum Spieler'),
  reporter('bc_player_pos', 'sensing', 'Spieler-Position %1', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }]),
  reporter('bc_player_inside', 'sensing', 'Spieler in meinem Bereich?', [], 'Boolean'),
  reporter('bc_key_down', 'sensing', 'Taste %1 gedrückt?', [{ type: 'field_dropdown', name: 'KEY', options: KEY_OPTIONS }], 'Boolean'),
  reporter('bc_time', 'sensing', 'Zeit seit Start'),
  reporter('bc_obj_pos', 'sensing', 'Position %1 von Objekt %2', [{ type: 'field_dropdown', name: 'AXIS', options: AXIS }, { type: 'field_input', name: 'NAME', text: 'Objektname' }]),

  // Welt
  stmt('bc_teleport', 'world', 'teleportiere Spieler zu x %1 y %2 z %3', [num('X'), num('Y'), num('Z')], 'Fußposition des Spielers.'),
  stmt('bc_show_text', 'world', 'zeige Text %1 für %2 Sek.', [any('TEXT'), num('S')], 'Text in der Bildschirmmitte.'),
  stmt('bc_obj_show', 'world', '%1 Objekt %2', [{ type: 'field_dropdown', name: 'SHOW', options: [['zeige', 'true'], ['verstecke', 'false']] }, { type: 'field_input', name: 'NAME', text: 'Objektname' }]),
  stmt('bc_set_weather', 'world', 'setze Wetter auf %1 mit Stärke %2', [{ type: 'field_dropdown', name: 'TYPE', options: WEATHER_OPTIONS.map((o) => [o.label, o.value]) }, num('I')], 'Wechselt das Wetter mit weicher Überblendung. Stärke 1 = normal, bis 2.'),
  stmt('bc_log', 'world', 'schreibe ins Log %1', [any('V')], 'Ausgabe in der Editor-Statusleiste / Browser-Konsole.'),

  // ---------- Bildschirm (Figuren & Bühne) ----------
  hat('sc_when_clicked', 'Wenn ich angeklickt werde', [], 'Figur: Klick auf die Figur. Bühne: Klick auf eine freie Stelle.'),
  hat('sc_when_hover', 'Wenn der Mauszeiger auf mich zeigt', [], ''),
  hat('sc_when_unhover', 'Wenn der Mauszeiger mich verlässt', [], ''),
  hat('sc_when_use', 'Wenn Spieler den Bildschirm benutzt', [], 'Spieler tritt an den Bildschirm (Benutzen-Taste).'),
  hat('sc_when_exit', 'Wenn Spieler den Bildschirm verlässt', [], ''),
  stmt('sc_goto', 'motion', 'gehe zu x %1 y %2', [num('X'), num('Y')], 'Bühnenmitte = 0/0. Breite 480 (x −240 … 240).'),
  stmt('sc_goto_mouse', 'motion', 'gehe zum Mauszeiger'),
  stmt('sc_glide', 'motion', 'gleite in %1 Sek. zu x %2 y %3', [num('S'), num('X'), num('Y')]),
  stmt('sc_change_x', 'motion', 'ändere x um %1', [num('V')]),
  stmt('sc_set_x', 'motion', 'setze x auf %1', [num('V')]),
  stmt('sc_change_y', 'motion', 'ändere y um %1', [num('V')]),
  stmt('sc_set_y', 'motion', 'setze y auf %1', [num('V')]),
  stmt('sc_turn', 'motion', 'drehe dich um %1 Grad', [num('V')]),
  stmt('sc_set_rot', 'motion', 'setze Drehung auf %1 Grad', [num('V')]),
  reporter('sc_x', 'motion', 'x-Position'),
  reporter('sc_y', 'motion', 'y-Position'),
  reporter('sc_rot', 'motion', 'Drehung'),
  stmt('sc_say_for', 'looks', 'sage %1 für %2 Sek.', [any('TEXT'), num('S')], 'Sprechblase über der Figur, wartet so lange.'),
  stmt('sc_say', 'looks', 'sage %1', [any('TEXT')], 'Leerer Text entfernt die Sprechblase.'),
  stmt('sc_set_text', 'looks', 'setze Text auf %1', [any('TEXT')], 'Beschriftung der Figur, z. B. für Anzeigen und Punktestände.'),
  stmt('sc_set_color', 'looks', 'setze Farbe auf %1', [colour('C', '#46d36b')]),
  stmt('sc_set_text_color', 'looks', 'setze Textfarbe auf %1', [colour('C', '#ffffff')]),
  stmt('sc_set_font', 'looks', 'setze Schriftgröße auf %1', [num('V')]),
  stmt('sc_set_scale', 'looks', 'setze Größe auf %1 %', [num('V')]),
  stmt('sc_change_scale', 'looks', 'ändere Größe um %1', [num('V')]),
  stmt('sc_set_wh', 'looks', 'setze Breite %1 Höhe %2', [num('W'), num('H')]),
  stmt('sc_set_ghost', 'looks', 'setze Transparenz auf %1 %', [num('V')]),
  stmt('sc_set_shape', 'looks', 'ändere Form zu %1', [{ type: 'field_dropdown', name: 'SHAPE', options: [['Knopf', 'button'], ['Rechteck', 'rect'], ['Abgerundet', 'round'], ['Kreis', 'circle'], ['Nur Text', 'text']] }]),
  stmt('sc_front', 'looks', 'komme nach vorne'),
  reporter('sc_text', 'looks', 'Text', [], 'String'),
  reporter('sc_scale', 'looks', 'Größe'),
  stmt('sc_set_bg', 'looks', 'setze Hintergrund auf %1', [colour('C', '#102030')], 'Hintergrundfarbe der Bühne.'),
  reporter('sc_mouse_x', 'sensing', 'Maus x'),
  reporter('sc_mouse_y', 'sensing', 'Maus y'),
  reporter('sc_mouse_down', 'sensing', 'Maustaste gedrückt?', [], 'Boolean'),
  reporter('sc_touching_mouse', 'sensing', 'berühre ich den Mauszeiger?', [], 'Boolean'),
  reporter('sc_screen_used', 'sensing', 'Bildschirm wird benutzt?', [], 'Boolean'),
  {
    ...reporter('sc_sprite_prop', 'sensing', '%1 von Figur %2', [
      { type: 'field_dropdown', name: 'PROP', options: [['x-Position', 'x'], ['y-Position', 'y'], ['Drehung', 'rot'], ['Größe', 'scale'], ['Text', 'text'], ['sichtbar?', 'visible']] },
      { type: 'field_input', name: 'NAME', text: 'Figur1' },
    ]),
    output: null,
  },
  stmt('sc_exit', 'world', 'verlasse den Bildschirm', [], 'Gibt den Spieler wieder frei (wie die Benutzen-Taste).'),
];

export const EVENT_BLOCKS: Record<string, { event: string; arg?: (b: Blockly.Block) => string }> = {
  bc_when_start: { event: 'start' },
  bc_when_tick: { event: 'tick' },
  bc_when_interact: { event: 'interact', arg: (b) => JSON.stringify(b.getFieldValue('TEXT') || 'Benutzen') },
  bc_when_hit: { event: 'hit' },
  bc_when_enter: { event: 'enter' },
  bc_when_leave: { event: 'leave' },
  bc_when_near: { event: 'near', arg: (b) => String(Number(b.getFieldValue('DIST')) || 0) },
  bc_when_key: { event: 'key', arg: (b) => JSON.stringify(b.getFieldValue('KEY')) },
  bc_when_message: { event: 'message', arg: (b) => JSON.stringify(b.getFieldValue('MSG')) },
  bc_when_part_interact: { event: 'partInteract', arg: (b) => `${JSON.stringify(b.getFieldValue('TEXT') || 'Benutzen')}, ${JSON.stringify(b.getFieldValue('PART') || '')}` },
  sc_when_clicked: { event: 'click' },
  sc_when_hover: { event: 'hover' },
  sc_when_unhover: { event: 'unhover' },
  sc_when_use: { event: 'use' },
  sc_when_exit: { event: 'exit' },
};

let installed = false;

export function installBlocks(): void {
  if (installed) return;
  installed = true;
  Blockly.setLocale(De as unknown as { [key: string]: string });
  registerFieldColour();
  colourPicker.installBlock({ javascript: javascriptGenerator });
  Blockly.common.defineBlocksWithJsonArray(BLOCKS);
  // Platzhalter-Auswahl der Teil-Blöcke durch die Liste des aktuellen Modells ersetzen
  for (const b of BLOCKS) {
    const type = b.type as string;
    if (!(b.args0 as Json[] | undefined)?.some((a) => a.name === 'PART')) continue;
    PART_BLOCKS.push(type);
    const def = Blockly.Blocks[type] as { init: (this: Blockly.Block) => void };
    const init = def.init;
    def.init = function (this: Blockly.Block) {
      init.call(this);
      const old = this.getField('PART');
      const input = old?.getParentInput();
      if (!old || !input) return;
      const at = input.fieldRow.indexOf(old);
      input.removeField('PART');
      input.insertFieldAt(at, new PartField() as unknown as Blockly.Field<string | undefined>, 'PART');
    };
  }

  const g = javascriptGenerator;
  // Wie in Scratch: jede Schleife gibt pro Durchlauf einen Frame ab → keine Endlosschleifen-Hänger
  g.INFINITE_LOOP_TRAP = 'await api.frame();\n';

  const v = (b: Blockly.Block, name: string, fallback = '0') => g.valueToCode(b, name, Order.COMMA) || fallback;
  const f = (b: Blockly.Block, name: string) => JSON.stringify(b.getFieldValue(name));
  const xyz = (b: Blockly.Block) => `${v(b, 'X')}, ${v(b, 'Y')}, ${v(b, 'Z')}`;
  const def = (type: string, fn: (b: Blockly.Block) => string | [string, Order]) => {
    g.forBlock[type] = fn as (typeof g.forBlock)[string];
  };

  // Ereignis-Blöcke: nachfolgende Blöcke werden zum Rumpf des Handlers
  for (const [type, ev] of Object.entries(EVENT_BLOCKS)) {
    def(type, (b) => {
      const next = b.getNextBlock();
      const body = next ? g.blockToCode(next) : '';
      const code = typeof body === 'string' ? body : body[0];
      const arg = ev.arg ? `, ${ev.arg(b)}` : '';
      return `api.on('${ev.event}', async () => {\n${g.prefixLines(code, g.INDENT)}}${arg});\n`;
    });
  }
  const origScrub = g.scrub_.bind(g);
  g.scrub_ = (block, code, thisOnly) => (EVENT_BLOCKS[block.type] ? code : origScrub(block, code, thisOnly));

  const pa = (b: Blockly.Block) => `${f(b, 'PART')}, ${f(b, 'AXIS')}`;
  def('bc_part_turn_to', (b) => `await api.partTurnTo(${pa(b)}, ${v(b, 'DEG')}, ${v(b, 'S', '1')});\n`);
  def('bc_part_turn_by', (b) => `await api.partTurnBy(${pa(b)}, ${v(b, 'DEG')}, ${v(b, 'S', '1')});\n`);
  def('bc_part_set_angle', (b) => `api.partSetAngle(${pa(b)}, ${v(b, 'DEG')});\n`);
  def('bc_part_spin', (b) => `api.partSpin(${pa(b)}, ${v(b, 'V')});\n`);
  def('bc_part_move', (b) => `await api.partMoveTo(${f(b, 'PART')}, ${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_part_reset', (b) => `await api.partReset(${f(b, 'PART')}, ${v(b, 'S', '1')});\n`);
  def('bc_part_show', (b) => `api.partShow(${f(b, 'PART')}, ${b.getFieldValue('SHOW') === 'true'});\n`);
  def('bc_part_color', (b) => `api.partColor(${f(b, 'PART')}, ${f(b, 'C')});\n`);
  def('bc_part_glow', (b) => `api.partGlow(${f(b, 'PART')}, ${f(b, 'C')}, ${v(b, 'V', '1')});\n`);
  def('bc_part_angle', (b) => [`api.partAngle(${pa(b)})`, Order.FUNCTION_CALL]);
  def('bc_sound', (b) => `api.sound(${f(b, 'ID')}, ${v(b, 'V', '100')});\n`);
  def('bc_sound_file', (b) => `api.soundFile(${f(b, 'FILE')}, ${v(b, 'V', '100')});\n`);
  def('bc_loop_start', (b) => `api.loopStart(${f(b, 'ID')}, ${v(b, 'V', '100')});\n`);
  def('bc_loop_stop', (b) => `api.loopStop(${f(b, 'ID')});\n`);
  def('bc_loop_pitch', (b) => `api.loopPitch(${f(b, 'ID')}, ${v(b, 'V', '100')});\n`);
  def('bc_loop_volume', (b) => `api.loopVolume(${f(b, 'ID')}, ${v(b, 'V', '100')});\n`);
  def('bc_loop_is_on', (b) => [`api.loopIsOn(${f(b, 'ID')})`, Order.FUNCTION_CALL]);
  def('bc_dt', () => ['api.dt()', Order.FUNCTION_CALL]);

  def('bc_broadcast', (b) => `api.broadcast(${f(b, 'MSG')});\n`);
  def('bc_move_by', (b) => `api.moveBy(${xyz(b)});\n`);
  def('bc_move_to', (b) => `api.moveTo(${xyz(b)});\n`);
  def('bc_move_forward', (b) => `api.moveForward(${v(b, 'D')});\n`);
  def('bc_glide_by', (b) => `await api.glideBy(${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_glide_to', (b) => `await api.glideTo(${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_rotate_by', (b) => `api.rotateBy(${xyz(b)});\n`);
  def('bc_turn_by', (b) => `await api.turnBy(${xyz(b)}, ${v(b, 'S', '1')});\n`);
  def('bc_set_rotation', (b) => `api.setRotation(${xyz(b)});\n`);
  def('bc_set_scale', (b) => `api.setScale(${xyz(b)});\n`);
  def('bc_pos', (b) => [`api.pos(${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);
  def('bc_rot', (b) => [`api.rot(${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);

  def('bc_show', () => 'api.show();\n');
  def('bc_hide', () => 'api.hide();\n');
  def('bc_set_color', (b) => `api.setColor(${f(b, 'C')});\n`);
  def('bc_set_glow', (b) => `api.setGlow(${f(b, 'C')}, ${v(b, 'V', '1')});\n`);
  def('bc_collision', (b) => `api.setCollision(${b.getFieldValue('ON') === 'true'});\n`);

  def('bc_light_set', (b) => `api.lightSet(${f(b, 'MODE')});\n`);
  def('bc_light_intensity', (b) => `api.lightIntensity(${v(b, 'V')});\n`);
  def('bc_light_change', (b) => `api.lightChangeIntensity(${v(b, 'V')});\n`);
  def('bc_light_color', (b) => `api.lightColor(${f(b, 'C')});\n`);
  def('bc_light_flicker', (b) => `api.lightFlicker(${b.getFieldValue('ON') === 'true'});\n`);
  def('bc_light_is_on', () => ['api.lightIsOn()', Order.FUNCTION_CALL]);
  def('bc_fx_set', (b) => `api.fxSet(${f(b, 'MODE')});\n`);
  def('bc_fx_intensity', (b) => `api.fxIntensity(${v(b, 'V')});\n`);
  def('bc_fx_burst', (b) => `api.fxBurst(${v(b, 'V')});\n`);
  def('bc_fx_is_on', () => ['api.fxIsOn()', Order.FUNCTION_CALL]);

  def('bc_wait', (b) => `await api.wait(${v(b, 'S', '1')});\n`);
  def('bc_forever', (b) => `while (true) {\n${g.statementToCode(b, 'DO')}${g.INDENT}await api.frame();\n}\n`);
  def('bc_wait_until', (b) => `while (!(${g.valueToCode(b, 'COND', Order.LOGICAL_NOT) || 'false'})) {\n${g.INDENT}await api.frame();\n}\n`);
  def('bc_stop', () => 'api.stop();\n');

  def('bc_distance', () => ['api.distanceToPlayer()', Order.FUNCTION_CALL]);
  def('bc_player_pos', (b) => [`api.playerPos(${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);
  def('bc_player_inside', () => ['api.playerInside()', Order.FUNCTION_CALL]);
  def('bc_key_down', (b) => [`api.keyDown(${f(b, 'KEY')})`, Order.FUNCTION_CALL]);
  def('bc_time', () => ['api.time()', Order.FUNCTION_CALL]);
  def('bc_obj_pos', (b) => [`api.objPos(${f(b, 'NAME')}, ${f(b, 'AXIS')})`, Order.FUNCTION_CALL]);

  def('bc_teleport', (b) => `api.teleportPlayer(${xyz(b)});\n`);
  def('bc_show_text', (b) => `api.showText(${v(b, 'TEXT', "''")}, ${v(b, 'S', '2')});\n`);
  def('bc_obj_show', (b) => `api.objShow(${f(b, 'NAME')}, ${b.getFieldValue('SHOW') === 'true'});\n`);
  def('bc_set_weather', (b) => `api.setWeather(${JSON.stringify(b.getFieldValue('TYPE'))}, ${v(b, 'I', '1')});
`);
  def('bc_log', (b) => `api.log(${v(b, 'V', "''")});\n`);

  // Bildschirm
  const xy = (b: Blockly.Block) => `${v(b, 'X')}, ${v(b, 'Y')}`;
  def('sc_goto', (b) => `api.goTo(${xy(b)});\n`);
  def('sc_goto_mouse', () => 'api.goToMouse();\n');
  def('sc_glide', (b) => `await api.glide(${xy(b)}, ${v(b, 'S', '1')});\n`);
  def('sc_change_x', (b) => `api.changeX(${v(b, 'V')});\n`);
  def('sc_set_x', (b) => `api.setX(${v(b, 'V')});\n`);
  def('sc_change_y', (b) => `api.changeY(${v(b, 'V')});\n`);
  def('sc_set_y', (b) => `api.setY(${v(b, 'V')});\n`);
  def('sc_turn', (b) => `api.turn(${v(b, 'V')});\n`);
  def('sc_set_rot', (b) => `api.setRot(${v(b, 'V')});\n`);
  def('sc_x', () => ['api.x()', Order.FUNCTION_CALL]);
  def('sc_y', () => ['api.y()', Order.FUNCTION_CALL]);
  def('sc_rot', () => ['api.rot()', Order.FUNCTION_CALL]);
  def('sc_say_for', (b) => `await api.sayFor(${v(b, 'TEXT', "''")}, ${v(b, 'S', '2')});\n`);
  def('sc_say', (b) => `api.say(${v(b, 'TEXT', "''")});\n`);
  def('sc_set_text', (b) => `api.setText(${v(b, 'TEXT', "''")});\n`);
  def('sc_set_color', (b) => `api.setColor(${f(b, 'C')});\n`);
  def('sc_set_text_color', (b) => `api.setTextColor(${f(b, 'C')});\n`);
  def('sc_set_font', (b) => `api.setFontSize(${v(b, 'V', '22')});\n`);
  def('sc_set_scale', (b) => `api.setScale(${v(b, 'V', '100')});\n`);
  def('sc_change_scale', (b) => `api.changeScale(${v(b, 'V', '10')});\n`);
  def('sc_set_wh', (b) => `api.setSize(${v(b, 'W', '100')}, ${v(b, 'H', '50')});\n`);
  def('sc_set_ghost', (b) => `api.setGhost(${v(b, 'V')});\n`);
  def('sc_set_shape', (b) => `api.setShape(${f(b, 'SHAPE')});\n`);
  def('sc_front', () => 'api.front();\n');
  def('sc_text', () => ['api.text()', Order.FUNCTION_CALL]);
  def('sc_scale', () => ['api.scale()', Order.FUNCTION_CALL]);
  def('sc_set_bg', (b) => `api.setBackground(${f(b, 'C')});\n`);
  def('sc_mouse_x', () => ['api.mouseX()', Order.FUNCTION_CALL]);
  def('sc_mouse_y', () => ['api.mouseY()', Order.FUNCTION_CALL]);
  def('sc_mouse_down', () => ['api.mouseDown()', Order.FUNCTION_CALL]);
  def('sc_touching_mouse', () => ['api.touchingMouse()', Order.FUNCTION_CALL]);
  def('sc_screen_used', () => ['api.screenUsed()', Order.FUNCTION_CALL]);
  def('sc_sprite_prop', (b) => [`api.spriteProp(${f(b, 'NAME')}, ${f(b, 'PROP')})`, Order.FUNCTION_CALL]);
  def('sc_exit', () => 'api.exitScreen();\n');
}

/**
 * Erzeugt den Script-Code eines Workspaces. Nur Ereignis-Blöcke (und was daran hängt) werden übernommen,
 * lose Blöcke ignoriert — wie in Scratch.
 */
export function generateCode(ws: Blockly.Workspace): string {
  const g = javascriptGenerator;
  g.init(ws);
  let code = '';
  for (const block of ws.getTopBlocks(true)) {
    if (!EVENT_BLOCKS[block.type] || !block.isEnabled()) continue;
    const c = g.blockToCode(block);
    code += typeof c === 'string' ? c : c[0];
  }
  code = g.finish(code);
  return code.trim() ? code : '';
}

/** Anzahl der Ereignis-Blöcke (für die Anzeige im Details-Panel) */
export function countEvents(blocksJson: unknown): number {
  const blocks = (blocksJson as { blocks?: { blocks?: { type: string }[] } })?.blocks?.blocks ?? [];
  return blocks.filter((b) => EVENT_BLOCKS[b.type]).length;
}

const sh = (type: string, fields: Json) => ({ shadow: { type, fields } });
const n = (v: number) => sh('math_number', { NUM: v });
const t = (v: string) => sh('text', { TEXT: v });
const block = (type: string, inputs?: Json, extra: Json = {}) => ({ kind: 'block', type, ...(inputs ? { inputs } : {}), ...extra });

export const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    {
      kind: 'category',
      name: 'Ereignisse',
      colour: CATEGORY_COLOURS.events,
      contents: [
        block('bc_when_start'),
        block('bc_when_interact'),
        block('bc_when_hit'),
        block('bc_when_part_interact'),
        block('bc_when_enter'),
        block('bc_when_leave'),
        block('bc_when_near'),
        block('bc_when_key'),
        block('bc_when_tick'),
        block('bc_when_message'),
        block('bc_broadcast'),
      ],
    },
    {
      kind: 'category',
      name: 'Modell-Teile',
      colour: CATEGORY_COLOURS.parts,
      contents: [
        block('bc_when_part_interact'),
        block('bc_part_turn_to', { S: n(0.8), DEG: n(60) }),
        block('bc_part_turn_by', { S: n(1), DEG: n(90) }),
        block('bc_part_set_angle', { DEG: n(0) }),
        block('bc_part_spin', { V: n(360) }),
        block('bc_part_move', { S: n(1), X: n(0), Y: n(0), Z: n(0) }),
        block('bc_part_reset', { S: n(0.5) }),
        block('bc_part_show'),
        block('bc_part_color'),
        block('bc_part_glow', { V: n(5) }),
        block('bc_part_angle'),
      ],
    },
    {
      kind: 'category',
      name: 'Klang',
      colour: CATEGORY_COLOURS.sound,
      contents: [
        block('bc_sound', { V: n(100) }),
        block('bc_loop_start', { V: n(100) }),
        block('bc_loop_stop'),
        block('bc_loop_pitch', { V: n(150) }),
        block('bc_loop_volume', { V: n(50) }),
        block('bc_loop_is_on'),
        block('bc_sound_file', { V: n(100) }),
      ],
    },
    {
      kind: 'category',
      name: 'Bewegung',
      colour: CATEGORY_COLOURS.motion,
      contents: [
        block('bc_move_by', { X: n(0), Y: n(1), Z: n(0) }),
        block('bc_move_to', { X: n(0), Y: n(0), Z: n(0) }),
        block('bc_move_forward', { D: n(1) }),
        block('bc_glide_by', { S: n(1), X: n(0), Y: n(2), Z: n(0) }),
        block('bc_glide_to', { S: n(1), X: n(0), Y: n(0), Z: n(0) }),
        block('bc_rotate_by', { X: n(0), Y: n(15), Z: n(0) }),
        block('bc_turn_by', { S: n(1), X: n(0), Y: n(90), Z: n(0) }),
        block('bc_set_rotation', { X: n(0), Y: n(0), Z: n(0) }),
        block('bc_set_scale', { X: n(1), Y: n(1), Z: n(1) }),
        block('bc_pos'),
        block('bc_rot'),
      ],
    },
    {
      kind: 'category',
      name: 'Aussehen',
      colour: CATEGORY_COLOURS.looks,
      contents: [block('bc_show'), block('bc_hide'), block('bc_set_color'), block('bc_set_glow', { V: n(4) }), block('bc_collision')],
    },
    {
      kind: 'category',
      name: 'Licht',
      colour: CATEGORY_COLOURS.light,
      contents: [
        block('bc_light_set'),
        block('bc_light_intensity', { V: n(10) }),
        block('bc_light_change', { V: n(2) }),
        block('bc_light_color'),
        block('bc_light_flicker'),
        block('bc_light_is_on'),
      ],
    },
    {
      kind: 'category',
      name: 'Effekte',
      colour: CATEGORY_COLOURS.effects,
      contents: [block('bc_fx_set'), block('bc_fx_intensity', { V: n(150) }), block('bc_fx_burst', { V: n(1) }), block('bc_fx_is_on')],
    },
    {
      kind: 'category',
      name: 'Steuerung',
      colour: CATEGORY_COLOURS.control,
      contents: [
        block('bc_wait', { S: n(1) }),
        block('controls_repeat_ext', { TIMES: n(10) }),
        block('bc_forever'),
        block('controls_if'),
        block('controls_if', undefined, { extraState: { hasElse: true } }),
        block('bc_wait_until'),
        block('controls_whileUntil'),
        block('bc_stop'),
      ],
    },
    {
      kind: 'category',
      name: 'Fühlen',
      colour: CATEGORY_COLOURS.sensing,
      contents: [
        block('bc_distance'),
        block('bc_player_inside'),
        block('bc_player_pos'),
        block('bc_key_down'),
        block('bc_time'),
        block('bc_dt'),
        block('bc_obj_pos'),
      ],
    },
    {
      kind: 'category',
      name: 'Operatoren',
      colour: CATEGORY_COLOURS.operators,
      contents: [
        block('math_arithmetic', { A: n(1), B: n(1) }),
        block('math_random_int', { FROM: n(1), TO: n(10) }),
        block('logic_compare', { A: n(0), B: n(0) }),
        block('logic_operation'),
        block('logic_negate'),
        block('logic_boolean'),
        block('math_number'),
        block('math_round', { NUM: n(3.1) }),
        block('math_modulo', { DIVIDEND: n(10), DIVISOR: n(3) }),
        block('text'),
        block('text_join'),
        block('colour_picker'),
      ],
    },
    { kind: 'category', name: 'Variablen', colour: CATEGORY_COLOURS.variables, custom: 'VARIABLE' },
    {
      kind: 'category',
      name: 'Welt',
      colour: CATEGORY_COLOURS.world,
      contents: [
        block('bc_show_text', { TEXT: t('Hallo!'), S: n(2) }),
        block('bc_teleport', { X: n(0), Y: n(0), Z: n(0) }),
        block('bc_obj_show'),
        block('bc_set_weather', { I: n(1) }),
        block('bc_log', { V: t('Test') }),
      ],
    },
  ],
};

// ---------- Toolboxen für Bildschirm-Figuren und die Bühne ----------

const OPERATORS = {
  kind: 'category',
  name: 'Operatoren',
  colour: CATEGORY_COLOURS.operators,
  contents: [
    block('math_arithmetic', { A: n(1), B: n(1) }),
    block('math_random_int', { FROM: n(1), TO: n(10) }),
    block('logic_compare', { A: n(0), B: n(0) }),
    block('logic_operation'),
    block('logic_negate'),
    block('logic_boolean'),
    block('math_number'),
    block('math_round', { NUM: n(3.1) }),
    block('math_modulo', { DIVIDEND: n(10), DIVISOR: n(3) }),
    block('text'),
    block('text_join'),
    block('text_length', { VALUE: t('Hallo') }),
    block('colour_picker'),
  ],
};

const CONTROL = {
  kind: 'category',
  name: 'Steuerung',
  colour: CATEGORY_COLOURS.control,
  contents: [
    block('bc_wait', { S: n(1) }),
    block('controls_repeat_ext', { TIMES: n(10) }),
    block('bc_forever'),
    block('controls_if'),
    block('controls_if', undefined, { extraState: { hasElse: true } }),
    block('bc_wait_until'),
    block('controls_whileUntil'),
    block('bc_stop'),
  ],
};

const screenEvents = (sprite: boolean) => ({
  kind: 'category',
  name: 'Ereignisse',
  colour: CATEGORY_COLOURS.events,
  contents: [
    block('bc_when_start'),
    block('sc_when_clicked'),
    ...(sprite ? [block('sc_when_hover'), block('sc_when_unhover')] : []),
    block('sc_when_use'),
    block('sc_when_exit'),
    block('bc_when_key'),
    block('bc_when_tick'),
    block('bc_when_message'),
    block('bc_broadcast'),
  ],
});

const screenSensing = (sprite: boolean) => ({
  kind: 'category',
  name: 'Fühlen',
  colour: CATEGORY_COLOURS.sensing,
  contents: [
    ...(sprite ? [block('sc_touching_mouse')] : []),
    block('sc_mouse_x'),
    block('sc_mouse_y'),
    block('sc_mouse_down'),
    block('sc_screen_used'),
    block('sc_sprite_prop'),
    block('bc_key_down'),
    block('bc_time'),
  ],
});

const SCREEN_WORLD = {
  kind: 'category',
  name: 'Welt',
  colour: CATEGORY_COLOURS.world,
  contents: [
    block('sc_exit'),
    block('bc_show_text', { TEXT: t('Zugang gewährt'), S: n(2) }),
    block('bc_obj_show'),
    block('bc_teleport', { X: n(0), Y: n(0), Z: n(0) }),
    block('bc_set_weather', { I: n(1) }),
    block('bc_log', { V: t('Test') }),
  ],
};

const VARIABLES = { kind: 'category', name: 'Variablen', colour: CATEGORY_COLOURS.variables, custom: 'VARIABLE' };

export const SCREEN_SPRITE_TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    screenEvents(true),
    {
      kind: 'category',
      name: 'Bewegung',
      colour: CATEGORY_COLOURS.motion,
      contents: [
        block('sc_goto', { X: n(0), Y: n(0) }),
        block('sc_glide', { S: n(1), X: n(0), Y: n(0) }),
        block('sc_change_x', { V: n(10) }),
        block('sc_set_x', { V: n(0) }),
        block('sc_change_y', { V: n(10) }),
        block('sc_set_y', { V: n(0) }),
        block('sc_turn', { V: n(15) }),
        block('sc_set_rot', { V: n(0) }),
        block('sc_goto_mouse'),
        block('sc_x'),
        block('sc_y'),
        block('sc_rot'),
      ],
    },
    {
      kind: 'category',
      name: 'Aussehen',
      colour: CATEGORY_COLOURS.looks,
      contents: [
        block('sc_say_for', { TEXT: t('Hallo!'), S: n(2) }),
        block('sc_say', { TEXT: t('Hallo!') }),
        block('sc_set_text', { TEXT: t('Text') }),
        block('sc_set_color'),
        block('sc_set_text_color'),
        block('sc_set_font', { V: n(22) }),
        block('sc_set_scale', { V: n(100) }),
        block('sc_change_scale', { V: n(10) }),
        block('sc_set_wh', { W: n(140), H: n(50) }),
        block('sc_set_ghost', { V: n(50) }),
        block('sc_set_shape'),
        block('bc_show'),
        block('bc_hide'),
        block('sc_front'),
        block('sc_set_bg'),
        block('sc_text'),
        block('sc_scale'),
      ],
    },
    CONTROL,
    screenSensing(true),
    OPERATORS,
    VARIABLES,
    SCREEN_WORLD,
  ],
};

export const SCREEN_STAGE_TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    screenEvents(false),
    { kind: 'category', name: 'Aussehen', colour: CATEGORY_COLOURS.looks, contents: [block('sc_set_bg')] },
    CONTROL,
    screenSensing(false),
    OPERATORS,
    VARIABLES,
    SCREEN_WORLD,
  ],
};

export const BLOCKLY_THEME = (): Blockly.Theme =>
  Blockly.Theme.defineTheme('bodycam-ue', {
    name: 'bodycam-ue',
    base: Blockly.Themes.Classic,
    startHats: true,
    componentStyles: {
      workspaceBackgroundColour: '#1b1b1b',
      toolboxBackgroundColour: '#242424',
      toolboxForegroundColour: '#d0d0d0',
      flyoutBackgroundColour: '#2c2c2c',
      flyoutForegroundColour: '#d0d0d0',
      flyoutOpacity: 0.96,
      scrollbarColour: '#555555',
      scrollbarOpacity: 0.6,
      insertionMarkerColour: '#ffffff',
      insertionMarkerOpacity: 0.3,
      cursorColour: '#0070e0',
    },
    fontStyle: { family: 'Segoe UI, Roboto, sans-serif', weight: '600', size: 11 },
  });
