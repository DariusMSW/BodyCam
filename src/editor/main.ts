import './editor.css';
import { EditorState } from './state.ts';
import { Viewport, type GizmoMode, type ViewMode } from './viewport.ts';
import { Outliner } from './outliner.ts';
import { DetailsPanel } from './details.ts';
import { ContentBrowser } from './content.ts';
import { ScriptEditor } from './scriptEditor.ts';
import { ScreenEditor } from './screenEditor.ts';
import { SCREEN_TYPE, defaultScreen } from '../world/screen.ts';
import { icon } from './icons.ts';
import { closeMenus, confirmDialog, dialog, h, initSplitters, isMenuOpen, pickFile, promptText, showMenu, toast, type MenuItem } from './ui.ts';
import { ASSETS, CATEGORIES, PRESETS, defaultProps, type AssetPreset } from '../world/assets.ts';
import { emptyMap, normalizeMap, type MapData, type MapObjectData } from '../world/mapFormat.ts';
import { collectBlobGarbage, deleteLocalMap, exportMapJson, exportMapPackage, importMapFile, listLocalMaps, loadLocalMap, requestPersistentStorage, saveLocalMap } from '../world/mapStore.ts';
import { MODE_ORDER, ModeManager } from './modes/index.ts';
import { MAPS } from '../maps/index.ts';
import { SUN_TYPE, writeSunToObject } from '../world/sun.ts';
import { WEATHER_TYPE, writeWeatherToObject } from '../world/weatherObject.ts';
import { clearLandscapeCache, flushLandscapes } from '../world/landscape/asset.ts';
import { browserBlobs } from '../world/blobStore.ts';
import { createLandscapeMode } from './modes/landscape.ts';
import { createFoliageMode } from './modes/foliage.ts';
import { createSplinesMode, installSplineAttachments } from './modes/splines.ts';
import { createWaterMode } from './modes/water.ts';
import { createModelingMode } from './modes/modeling.ts';
import { clearFoliageCache, flushFoliage } from '../world/foliage/asset.ts';
import { LoadingScreen } from '../ui/loadingScreen.ts';
import { models } from './models.ts';
import { setActionHost } from './assetAction.ts';
import { modelLabel } from '../world/modelStore.ts';
import type { Modeler } from './modeler/modeler.ts';

// Einstieg des Map-Editors (editor.html). Verdrahtet Zustand, Viewport, Panels, Menüs und Tastenkürzel.

const LAST_KEY = 'bodycam.editor.last';
const FPS_KEY = 'bodycam.editor.fps';

const loading = new LoadingScreen('editor');
await loading.step(0.1, 'Editor wird gestartet …');

const state = new EditorState();
state.map = structuredClone(MAPS.start);

const statusMsg = h('span', { class: 'msg' }, 'Bereit');
const statusDirty = h('span', { class: 'dirty' });
const statusCount = h('span');
document.getElementById('statusbar')!.append(statusMsg, statusDirty, statusCount);
let statusTimer = 0;
const status = (msg: string, error = false) => {
  statusMsg.textContent = msg;
  statusMsg.classList.toggle('error', error);
  clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    statusMsg.textContent = 'Bereit';
    statusMsg.classList.remove('error');
  }, error ? 9000 : 4000);
};

const viewportEl = document.getElementById('viewport')!;
const viewport = new Viewport(viewportEl, state);
viewport.onStatus = status;
setActionHost({ state, viewport, status });
const outliner = new Outliner(document.getElementById('outliner')!, state);
const details = new DetailsPanel(document.getElementById('details')!, state);
const content = new ContentBrowser(document.getElementById('content')!);
const scriptEditor = new ScriptEditor();
const screenEditor = new ScreenEditor();
details.onCreateSun = () => {
  const p = PRESETS.find((x) => x.type === SUN_TYPE);
  if (!p) return;
  placePreset(p);
  details.setTab('details');
};
details.onCreateWeather = () => {
  const p = PRESETS.find((x) => x.type === WEATHER_TYPE);
  if (!p) return;
  placePreset(p);
  details.setTab('details');
};
details.onSunFromCamera = () => {
  viewport.sunFromCamera();
  status('Sonne auf Kamerablick ausgerichtet');
};
initSplitters();

// Editor-Modi (Auswahl, Landscape, Foliage, …); Werkzeug-Panel liegt über der Details-Spalte
const modes = new ModeManager({ state, viewport, status: (m, err) => status(m, err) }, document.getElementById('details')!);
modes.register(createLandscapeMode({ state, viewport, status: (m, err) => status(m, err) }));
modes.register(createFoliageMode({ state, viewport, status: (m, err) => status(m, err) }));
modes.register(createModelingMode({ state, viewport, status: (m, err) => status(m, err) }));
modes.register(createSplinesMode({ state, viewport, status: (m, err) => status(m, err) }));
modes.register(createWaterMode({ state, viewport, status: (m, err) => status(m, err) }));
// Kabel hängen an Strommasten: Punkte folgen, wenn ein Mast bewegt wird
installSplineAttachments(state);
// Entwicklung: Zugriff für automatisierte Tests im Browser
if (import.meta.env.DEV) (window as unknown as { __editor: unknown }).__editor = { state, viewport, modes, get modeler() { return modeler; } };

/** Geänderte Landscape- und Foliage-Daten als Blobs schreiben (vor Speichern/Export) */
async function flushData(): Promise<void> {
  await flushLandscapes(state.map.objects, (b) => browserBlobs.put(b));
  await flushFoliage(state.map.objects, (b) => browserBlobs.put(b));
}

// ---------- Map laden / speichern ----------

function loadMapData(map: MapData): void {
  if (viewport.simulating) viewport.stopSimulation();
  clearLandscapeCache();
  clearFoliageCache();
  state.load(normalizeMap(structuredClone(map)));
  localStorage.setItem(LAST_KEY, state.map.name);
  viewport.applyWorld();
  viewport.focus([]);
}

/** Map laden mit Ladebalken: baut die Szene, wartet auf Landscapes/Modelle und kompiliert die Shader */
async function openMap(map: MapData, from = 0): Promise<void> {
  if (!loading.visible) loading.show();
  await loading.step(from + (1 - from) * 0.1, `„${map.name}“ wird aufgebaut …`);
  loadMapData(map);
  await loading.track(viewport.pendingLoads(), from + (1 - from) * 0.25, from + (1 - from) * 0.75, 'Landscapes & Modelle');
  await loading.step(from + (1 - from) * 0.8, 'Shader werden kompiliert …');
  await viewport.compileShaders();
  await loading.finish();
}

async function confirmDiscard(): Promise<boolean> {
  return !state.dirty || confirmDialog('Ungespeicherte Änderungen', `„${state.map.name}“ hat ungespeicherte Änderungen. Verwerfen?`, 'Verwerfen', true);
}

let persistAsked = false;

async function save(): Promise<boolean> {
  if (viewport.simulating) viewport.stopSimulation();
  try {
    await flushData();
    await saveLocalMap(state.map);
  } catch (e) {
    toast((e as Error).message, 'error', 6000);
    return false;
  }
  localStorage.setItem(LAST_KEY, state.map.name);
  state.markSaved();
  status(`„${state.map.name}“ im Browser gespeichert`);
  // Einmal pro Sitzung: Browser bitten, IndexedDB nicht bei Platzmangel zu räumen
  if (!persistAsked) {
    persistAsked = true;
    void requestPersistentStorage();
  }
  return true;
}

async function saveAs(): Promise<void> {
  const name = await promptText('Speichern unter', 'Name der Map:', state.map.name);
  if (!name) return;
  if (name !== state.map.name && (await listLocalMaps()).some((m) => m.name === name)) {
    if (!(await confirmDialog('Überschreiben?', `Es gibt bereits eine Map „${name}“. Überschreiben?`, 'Überschreiben', true))) return;
  }
  state.map.name = name;
  if (await save()) toast(`Gespeichert als „${name}“`, 'ok');
}

async function newMap(): Promise<void> {
  if (!(await confirmDiscard())) return;
  const name = await promptText('Neue Map', 'Name der neuen Map:', 'Neue Map');
  if (!name) return;
  const map = emptyMap(name);
  const obj = (preset: string, pos: [number, number, number]): MapObjectData => {
    const p = PRESETS.find((x) => x.id === preset)!;
    return { id: `${preset}-1`, name: p.label, type: p.type, pos, rot: [0, 0, 0], scale: p.scale ?? [1, 1, 1], props: defaultProps(p.type, p.props) };
  };
  const sun = { ...obj('sun', [0, 6, 0]), name: 'Sonne' };
  writeSunToObject(map.world, sun);
  map.objects.push({ ...obj('floor', [0, -0.05, 0]), scale: [20, 0.1, 20] }, obj('spawn', [0, 0, 4]), sun);
  loadMapData(map);
  state.dirty = true;
  state.emit('meta');
}

async function openDialog(): Promise<void> {
  let maps: Awaited<ReturnType<typeof listLocalMaps>> = [];
  try {
    maps = await listLocalMaps();
  } catch (e) {
    toast(`Browser-Speicher nicht lesbar: ${(e as Error).message}`, 'error', 6000);
  }
  const list = h('div', { class: 'map-list' });
  let close = () => {};
  const entry = (label: string, when: string, load: () => void, del?: () => void) => {
    const row = h('div', { class: 'map-entry', html: `${icon('open', 'width="16" height="16"')}` }, h('span', {}, label), h('span', { class: 'when' }, when));
    row.addEventListener('click', async () => {
      close();
      if (await confirmDiscard()) load();
    });
    if (del) {
      const x = h('span', { class: 'x', title: 'Löschen' }, '✕');
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await confirmDialog('Map löschen', `„${label}“ endgültig aus dem Browser löschen?`, 'Löschen', true)) {
          del();
          row.remove();
        }
      });
      row.append(x);
    }
    list.append(row);
  };
  for (const m of maps) {
    entry(m.name, new Date(m.updated).toLocaleString('de-DE'), async () => {
      const map = await loadLocalMap(m.name);
      if (map) await openMap(map);
      else toast('Map konnte nicht geladen werden', 'error');
    }, () => void deleteLocalMap(m.name));
  }
  entry('Startmap (mitgeliefert, src/maps/start.json)', 'Vorlage', () => void openMap(MAPS.start));
  entry('Trainingslevel (mitgeliefert, src/maps/training.json)', 'Vorlage', () => void openMap(MAPS.training));
  entry('Oldtimer mit Script (mitgeliefert, src/maps/oldtimer.json)', 'Vorlage', () => void openMap(MAPS.oldtimer));
  const body = h('div', {}, h('div', { style: 'color:var(--text-dim)' }, 'Im Browser gespeicherte Maps:'), list);
  close = dialog('Map öffnen', body, [
    {
      label: 'Importieren (.bcmap/.json)…',
      action: () => {
        void importFile();
      },
    },
    { label: 'Schließen', primary: true },
  ]);
}

async function importFile(): Promise<void> {
  const file = await pickFile('.bcmap,.zip,.json,application/json');
  if (!file || !(await confirmDiscard())) return;
  try {
    const map = await importMapFile(file);
    await openMap(map);
    state.dirty = true;
    state.emit('meta');
    toast(`„${map.name}“ importiert — Strg+S speichert sie im Browser`, 'ok', 4000);
  } catch (e) {
    toast((e as Error).message, 'error', 5000);
  }
}

async function exportPackage(): Promise<void> {
  if (viewport.simulating) viewport.stopSimulation();
  status('Paket wird erstellt …');
  try {
    await flushData();
    await exportMapPackage(state.map);
    status(`„${state.map.name}.bcmap“ exportiert`);
  } catch (e) {
    toast((e as Error).message, 'error', 6000);
  }
}

async function exportJson(): Promise<void> {
  try {
    await flushData();
    exportMapJson(state.map);
  } catch (e) {
    toast((e as Error).message, 'error', 6000);
  }
}

async function play(): Promise<void> {
  if (!(await save())) return;
  if (!state.map.objects.some((o) => o.type === 'spawn')) toast('Kein Player Start in der Map — Spieler startet bei 0/0/0', 'info', 4000);
  window.open(`index.html?map=local:${encodeURIComponent(state.map.name)}`, 'bodycam-play');
  status('Spiel geöffnet (Tab „bodycam-play“) — erneutes Speichern lädt es automatisch neu');
}

function toggleSimulation(): void {
  if (viewport.simulating) viewport.stopSimulation();
  else viewport.startSimulation();
}

// ---------- Objekte ----------

function objectFromPreset(p: AssetPreset): MapObjectData {
  const o: MapObjectData = { id: '', name: p.label, type: p.type, pos: [0, 0, 0], rot: p.rot ?? [0, 0, 0], scale: p.scale ?? [1, 1, 1], props: defaultProps(p.type, p.props) };
  // Neue Sonne übernimmt den bisherigen Sonnenstand + Licht aus den World Settings
  if (o.type === SUN_TYPE) {
    o.name = 'Sonne';
    writeSunToObject(state.map.world, o);
  }
  // Neues Wetter-Objekt übernimmt die bisherigen Wetter-Werte; "klar" wäre beim Platzieren nicht sichtbar → Regen
  if (o.type === WEATHER_TYPE) {
    o.name = 'Wetter';
    writeWeatherToObject(state.map.world, o);
    if (o.props.weather === 'klar') o.props.weather = 'regen';
  }
  if (o.type === SCREEN_TYPE) {
    o.name = 'Bildschirm';
    o.screen = defaultScreen();
  }
  return o;
}

function uniqueConflict(type: string): boolean {
  if (!ASSETS[type]?.unique) return false;
  const existing = state.map.objects.find((o) => o.type === type);
  if (!existing) return false;
  toast(`Nur ein „${ASSETS[type].label}“ pro Map — vorhandenes ausgewählt`);
  state.select([existing.id]);
  return true;
}

function placePreset(p: AssetPreset): void {
  if (viewport.simulating || uniqueConflict(p.type)) return;
  const [o] = state.add([objectFromPreset(p)], false);
  if (!o) return;
  const hit = viewport.centerPoint();
  if (o.type === SUN_TYPE || o.type === WEATHER_TYPE) hit.point.y += 4; // schwebt, Position ist egal
  viewport.placeOnSurface(o.id, hit.point, hit.normal);
  state.commit();
  status(`„${o.name}“ hinzugefügt`);
  if (o.type === SCREEN_TYPE) editScreen(o.id);
}
content.onPlace = placePreset;

// ---------- Dokument-Tabs: Level & Modeler ----------
// Der Modeler (3D-Modelle bauen) läuft als eigener Tab neben dem Level. Er wird erst beim ersten Öffnen geladen.

const doctabs = document.getElementById('doctabs')!;
const modelerEl = document.getElementById('modeler')!;
const toolbarEl = document.getElementById('toolbar')!;
const workspaceEl = document.getElementById('workspace')!;
let activeTab: 'level' | 'modeler' = 'level';
let modeler: Modeler | null = null;
let modelerOpen = false;
let modelerTitle = { name: '', dirty: false };

async function ensureModeler(): Promise<Modeler> {
  if (modeler) return modeler;
  status('Modeler wird geladen …');
  const { Modeler } = await import('./modeler/modeler.ts');
  modelerEl.classList.remove('hidden');
  modeler = new Modeler(modelerEl, {
    status,
    title: (name, dirty) => {
      modelerTitle = { name, dirty };
      renderDocTabs();
    },
    saved: async (ref) => {
      await models.refresh();
      viewport.reloadModel(ref);
      content.showFolder('Modelle/Eigene');
    },
    place: (ref) => {
      showTab('level');
      placePreset({ id: `model:${ref}`, label: modelLabel(ref), category: 'Modelle/Eigene', type: 'model', icon: 'modeler', props: { model: ref, collision: 'auto' } });
    },
  });
  return modeler;
}

function showTab(tab: 'level' | 'modeler'): void {
  if (tab === 'modeler' && !modeler) return;
  activeTab = tab;
  const m = tab === 'modeler';
  if (m && viewport.simulating) viewport.stopSimulation();
  toolbarEl.classList.toggle('hidden', m);
  workspaceEl.classList.toggle('hidden', m);
  modelerEl.classList.toggle('hidden', !m);
  viewport.setPaused(m);
  closeMenus();
  if (m) modeler!.activate();
  else modeler?.deactivate();
  renderDocTabs();
}

function renderDocTabs(): void {
  const tab = (id: 'level' | 'modeler', ic: string, label: string, dirty: boolean, close?: () => void) => {
    const el = h('div', { class: `doctab${activeTab === id ? ' active' : ''}`, title: label, html: icon(ic) }, h('span', { class: 'dt-name' }, label), dirty ? h('span', { class: 'dt-dirty' }, '●') : '');
    el.addEventListener('click', () => showTab(id));
    if (close) {
      const x = h('span', { class: 'dt-close', title: 'Modeler schließen', html: icon('close') });
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
      });
      el.append(x);
    }
    return el;
  };
  doctabs.replaceChildren(tab('level', 'mountain', `Level: ${state.map.name}`, state.dirty));
  if (modelerOpen) doctabs.append(tab('modeler', 'modeler', `Modell: ${modelerTitle.name}`, modelerTitle.dirty, () => void closeModeler()));
  const plus = h('div', { class: 'doctab', title: 'Neues 3D-Modell im Modeler', html: icon('plus') });
  plus.addEventListener('click', () => void newModel());
  doctabs.append(plus);
}

async function modelerReady(): Promise<Modeler | null> {
  if (modelerOpen && modeler?.isDirty && !(await confirmDialog('Ungespeichertes Modell', `„${modeler.name}“ hat ungespeicherte Änderungen. Verwerfen?`, 'Verwerfen', true))) return null;
  const m = await ensureModeler();
  modelerOpen = true;
  return m;
}

async function newModel(): Promise<void> {
  const m = await modelerReady();
  if (!m) return;
  m.newModel();
  showTab('modeler');
  status('Neues Modell — Tab: Bearbeiten · Umschalt+A: Grundkörper · Strg+S: im Content Browser speichern');
}

async function openModel(ref: string): Promise<void> {
  if (modelerOpen && modeler?.doc.ref === ref) return showTab('modeler');
  const m = await modelerReady();
  if (!m) return;
  showTab('modeler');
  await m.open(ref);
}

async function closeModeler(): Promise<void> {
  if (modeler?.isDirty && !(await confirmDialog('Modeler schließen', `„${modeler.name}“ hat ungespeicherte Änderungen. Verwerfen?`, 'Verwerfen', true))) return;
  modelerOpen = false;
  showTab('level');
}

content.onOpenModel = (ref) => void openModel(ref);
content.onNewModel = () => void newModel();
renderDocTabs();

// Drag & Drop aus dem Content Browser: Vorschau-Objekt folgt der Maus, Loslassen platziert
let ghost: { id: string; prevSelection: string[] } | null = null;
viewportEl.addEventListener('dragover', (e) => {
  const p = ContentBrowser.dragging;
  if (!p || viewport.simulating) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'copy';
  viewportEl.classList.add('vp-drop');
  if (!ghost) {
    if (ASSETS[p.type]?.unique && state.map.objects.some((o) => o.type === p.type)) return;
    const prev = [...state.selection];
    const [o] = state.add([objectFromPreset(p)], false);
    if (!o) return;
    ghost = { id: o.id, prevSelection: prev };
  }
  const hit = viewport.surfacePoint(e.clientX, e.clientY, new Set([ghost.id]));
  viewport.placeOnSurface(ghost.id, hit.point, hit.normal);
});
const cancelGhost = () => {
  viewportEl.classList.remove('vp-drop');
  if (!ghost) return;
  const g = ghost;
  ghost = null;
  state.map.objects = state.map.objects.filter((o) => o.id !== g.id);
  state.selection = g.prevSelection.filter((id) => state.get(id));
  state.emit('scene', 'selection');
};
viewportEl.addEventListener('dragleave', (e) => {
  if (!viewportEl.contains(e.relatedTarget as Node | null)) cancelGhost();
});
viewportEl.addEventListener('drop', (e) => {
  e.preventDefault();
  viewportEl.classList.remove('vp-drop');
  const p = ContentBrowser.dragging;
  if (!ghost) {
    if (p) uniqueConflict(p.type);
    return;
  }
  const placed = state.get(ghost.id);
  const name = placed?.name;
  ghost = null;
  state.commit();
  status(`„${name}“ platziert`);
  if (placed?.type === SCREEN_TYPE) {
    editScreen(placed.id);
    return;
  }
  viewportEl.querySelector('canvas')?.focus();
});
window.addEventListener('dragend', () => cancelGhost());

function editScript(id: string): void {
  const obj = state.get(id);
  if (!obj || viewport.simulating) return;
  scriptEditor.open(obj, (script) => {
    state.update(() => {
      const o = state.get(id);
      if (!o) return;
      if (script) o.script = script;
      else delete o.script;
    });
    status(script ? `Script von „${obj.name}“ gespeichert — ▶ Simulieren oder Spielen zum Testen` : `Script von „${obj.name}“ entfernt`);
  });
}
details.onEditScript = editScript;

function editScreen(id: string): void {
  const obj = state.get(id);
  if (!obj || obj.type !== SCREEN_TYPE || viewport.simulating) return;
  screenEditor.open(obj, (screen) => {
    state.update(() => {
      const o = state.get(id);
      if (o) o.screen = screen;
    });
    status(`Bildschirm „${obj.name}“ gespeichert — ▶ Simulieren zum Ausprobieren`);
  });
}
details.onEditScreen = editScreen;

function deleteSelected(): void {
  const n = state.selection.length;
  if (!n) return;
  state.removeSelected();
  status(`${n} Objekt(e) gelöscht`);
}

function duplicate(): void {
  const n = state.duplicateSelected().length;
  if (n) status(`${n} Objekt(e) dupliziert`);
  else if (state.selection.length) toast('Einzigartige Objekte (Player Start, Terminal) können nicht dupliziert werden');
}

function hideSelected(): void {
  for (const id of state.selection) state.editorHidden.add(id);
  state.emit('scene');
}

function unhideAll(): void {
  state.editorHidden.clear();
  state.emit('scene');
}

function contextItems(): MenuItem[] {
  const sel = state.primary;
  const has = !!sel;
  return [
    { label: 'Fokussieren', key: 'F', disabled: !has, action: () => viewport.focus(state.selection) },
    { label: 'Umbenennen', key: 'F2', disabled: !has, action: () => sel && outliner.rename(sel.id) },
    { label: sel?.script ? 'Script bearbeiten' : 'Script hinzufügen', icon: 'script', disabled: !has, action: () => sel && editScript(sel.id) },
    ...(sel?.type === SCREEN_TYPE ? [{ label: 'Bildschirm programmieren', icon: 'monitor', action: () => editScreen(sel.id) }] : []),
    { separator: true },
    { label: 'Kopieren', key: 'Strg+C', disabled: !has, action: () => state.copy() },
    { label: 'Einfügen', key: 'Strg+V', action: () => state.paste() },
    { label: 'Duplizieren', key: 'Strg+D', disabled: !has, action: duplicate },
    { label: 'Auf Boden setzen', key: 'Ende', disabled: !has, action: () => viewport.snapToFloor() },
    { label: 'Im Editor ausblenden', key: 'H', disabled: !has, action: hideSelected },
    { separator: true },
    { label: 'Löschen', key: 'Entf', icon: 'trash', disabled: !has, action: deleteSelected },
  ];
}
viewport.onContextMenu = (node, x, y) => {
  if (viewport.simulating) return;
  if (!node) {
    showMenu([{ heading: 'Hinzufügen' }, ...addMenuItems().slice(0, 40)], { x, y });
    return;
  }
  showMenu(contextItems(), { x, y });
};
outliner.onContextMenu = (_id, x, y) => showMenu(contextItems(), { x, y });
outliner.onFocus = (id) => viewport.focus([id]);

// ---------- Menüs ----------

function addMenuItems(): MenuItem[] {
  return CATEGORIES.filter((c) => c !== 'Modelle').flatMap((cat) => [
    { heading: cat },
    ...PRESETS.filter((p) => p.category === cat).map((p): MenuItem => ({ label: p.label, icon: p.icon, action: () => placePreset(p) })),
  ]);
}

const menubar = document.getElementById('menubar')!;
const mapTitle = h('div', { class: 'map-title' });
const menus: Record<string, () => MenuItem[]> = {
  Datei: () => [
    { label: 'Neue Map…', key: 'Strg+N', action: () => void newMap() },
    { label: 'Öffnen…', key: 'Strg+O', icon: 'open', action: () => void openDialog() },
    { label: 'Speichern', key: 'Strg+S', icon: 'save', action: () => void save() },
    { label: 'Speichern unter…', key: 'Strg+Umsch+S', action: () => void saveAs() },
    { separator: true },
    { label: 'Als Paket exportieren (.bcmap)', icon: 'download', action: () => void exportPackage() },
    { label: 'Als JSON exportieren (ohne Binär-Daten)', icon: 'download', action: exportJson },
    { label: 'Importieren (.bcmap/.json)…', icon: 'upload', action: () => void importFile() },
    { separator: true },
    { label: 'Im Spiel testen', key: 'Alt+P', icon: 'play', action: () => void play() },
    { separator: true },
    { label: 'Neues 3D-Modell (Modeler)', icon: 'modeler', action: () => void newModel() },
    {
      label: '3D-Modell bearbeiten …',
      icon: 'modeler',
      action: () => {
        const own = models.imported.filter((r) => r.startsWith('idb:modeler/'));
        if (!own.length) return toast('Noch keine eigenen Modelle — „Neues 3D-Modell“ legt eins an');
        showMenu(
          own.map((r) => ({ label: modelLabel(r), icon: 'modeler', action: () => void openModel(r) })),
          { x: 120, y: 60 },
        );
      },
    },
  ],
  Bearbeiten: () => [
    ...(activeTab === 'modeler' && modeler
      ? [
          { label: 'Rückgängig (Modell)', key: 'Strg+Z', action: () => modeler!.undo() },
          { label: 'Wiederholen (Modell)', key: 'Strg+Y', action: () => modeler!.redo() },
        ]
      : [
          { label: 'Rückgängig', key: 'Strg+Z', disabled: !state.canUndo, action: () => state.undo() },
          { label: 'Wiederholen', key: 'Strg+Y', disabled: !state.canRedo, action: () => state.redo() },
        ]),
    { separator: true },
    ...contextItems().slice(4),
    { separator: true },
    { label: 'Alles auswählen', key: 'Strg+A', action: () => state.select(state.map.objects.map((o) => o.id)) },
    { label: 'Auswahl aufheben', key: 'Esc', action: () => state.select([]) },
    { label: 'Alle einblenden', key: 'Strg+H', action: unhideAll },
  ],
  Ansicht: () => {
    const vm = (label: string, m: ViewMode): MenuItem => ({ label, checked: viewport.viewMode === m, action: () => setViewMode(m) });
    return [
      vm('Beleuchtet (wie im Spiel)', 'lit'),
      vm('Aufgehellt', 'bright'),
      vm('Drahtgitter', 'wire'),
      { separator: true },
      { label: 'Editor-Hilfen (Icons, Volumen)', key: 'G', checked: viewport.showHelpers, action: () => viewport.setShowHelpers(!viewport.showHelpers) },
      { label: 'Raster', checked: viewport.showGrid, action: () => viewport.setShowGrid(!viewport.showGrid) },
      { label: 'Nebel', checked: viewport.showFog, action: () => viewport.setShowFog(!viewport.showFog) },
      { label: 'Bloom', checked: viewport.bloomEnabled, action: () => viewport.setBloom(!viewport.bloomEnabled) },
      { label: 'FPS anzeigen', key: 'Strg+Umsch+H', checked: viewport.showFps, action: toggleFps },
      { separator: true },
      { label: 'Content Browser', key: 'Strg+Leer', checked: !contentEl.classList.contains('hidden'), action: toggleContent },
      { label: 'Auswahl fokussieren', key: 'F', action: () => viewport.focus(state.selection) },
      { label: 'Ganze Map zeigen', action: () => viewport.focus([]) },
    ];
  },
  Hinzufügen: addMenuItems,
  Hilfe: () => [
    { label: 'Tastenkürzel', action: showShortcuts },
    { label: 'Scripts (Blöcke) — Kurzanleitung', action: showScriptHelp },
  ],
};
menubar.append(h('div', { class: 'logo' }, h('i'), 'BODYCAM'));
for (const [name, items] of Object.entries(menus)) {
  const btn = h('div', { class: 'menu-button' }, name);
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (btn.classList.contains('open')) {
      closeMenus();
      return;
    }
    btn.classList.add('open');
    showMenu(items(), btn, () => btn.classList.remove('open'));
  });
  btn.addEventListener('pointerenter', () => {
    if (isMenuOpen() && !btn.classList.contains('open')) {
      closeMenus();
      btn.classList.add('open');
      showMenu(items(), btn, () => btn.classList.remove('open'));
    }
  });
  menubar.append(btn);
}
menubar.append(mapTitle);

// ---------- Toolbar ----------

const tb = (label: string, ic: string, title: string, action: () => void, cls = '') => {
  const b = h('button', { class: `tb-button ${cls}`, title, html: `${icon(ic)}${label ? `<span>${label}</span>` : ''}` });
  b.addEventListener('click', action);
  return b;
};
const btnPlay = tb('Spielen', 'play', 'Map speichern und im Spiel öffnen (Alt+P)', () => void play(), 'tb-play');
const btnSim = tb('Simulieren', 'simulate', 'Scripts im Editor laufen lassen (Alt+S)', toggleSimulation, 'tb-play');
const btnStop = tb('', 'stop', 'Simulation beenden (Esc)', () => viewport.stopSimulation(), 'tb-stop');
const btnUndo = tb('', 'rotate', 'Rückgängig (Strg+Z)', () => state.undo());
btnUndo.style.transform = 'scaleX(-1)';
const btnRedo = tb('', 'rotate', 'Wiederholen (Strg+Y)', () => state.redo());
const addBtn = tb('Hinzufügen', 'plus', 'Asset hinzufügen', () => showMenu(addMenuItems(), addBtn));
const modeBtn = tb('', 'select', 'Editor-Modus (Umschalt+1…6)', () =>
  showMenu(
    MODE_ORDER.map((id, i): MenuItem => {
      const m = modes.modes.get(id)!;
      return { label: m.label, icon: m.icon, key: `Umsch+${i + 1}`, checked: modes.active.id === id, action: () => modes.set(id) };
    }),
    modeBtn,
  ),
  'tb-mode',
);
const showModeButton = () => {
  const m = modes.active;
  modeBtn.innerHTML = `${icon(m.icon)}<span>${m.label}</span><span class="caret">▾</span>`;
  modeBtn.classList.toggle('active', m.id !== 'select');
};
modes.onChange(showModeButton);
showModeButton();
document.getElementById('toolbar')!.append(
  modeBtn,
  h('div', { class: 'tb-sep' }),
  tb('Speichern', 'save', 'Im Browser speichern (Strg+S)', () => void save()),
  tb('Öffnen', 'open', 'Map öffnen (Strg+O)', () => void openDialog()),
  h('div', { class: 'tb-sep' }),
  addBtn,
  tb('Script', 'script', 'Blöcke des ausgewählten Objekts bearbeiten', () => state.primary && editScript(state.primary.id)),
  h('div', { class: 'tb-sep' }),
  btnUndo,
  btnRedo,
  h('div', { class: 'tb-spacer' }),
  h('div', { class: 'tb-group' }, btnPlay, btnSim, btnStop),
  h('div', { class: 'tb-spacer' }),
  tb('Export', 'download', 'Map als Paket (.bcmap) herunterladen', () => void exportPackage()),
);
viewport.onSimulationChange = updateToolbar;

function updateToolbar(): void {
  const sim = viewport.simulating;
  btnSim.classList.toggle('active', sim);
  btnStop.disabled = !sim;
  btnUndo.disabled = !state.canUndo || sim;
  btnRedo.disabled = !state.canRedo || sim;
}

// ---------- Viewport-Overlays (wie UE5: links Ansicht, rechts Gizmo/Snapping) ----------

const vpBtn = (html: string, title: string, action: (b: HTMLElement) => void) => {
  const b = h('div', { class: 'vp-btn', title, html });
  b.addEventListener('click', () => action(b));
  return b;
};
const viewLabels: Record<ViewMode, string> = { lit: 'Beleuchtet', bright: 'Aufgehellt', wire: 'Drahtgitter' };
const viewBtn = vpBtn('', 'Ansichtsmodus', (b) => showMenu((['lit', 'bright', 'wire'] as ViewMode[]).map((m) => ({ label: viewLabels[m], checked: viewport.viewMode === m, action: () => setViewMode(m) })), b));
function setViewMode(m: ViewMode): void {
  viewport.setViewMode(m);
  viewBtn.innerHTML = `${icon('eyeView')}${viewLabels[m]} ▾`;
}
setViewMode('lit');
const showBtn = vpBtn(`${icon('details')}Anzeigen ▾`, 'Anzeigeoptionen', (b) => showMenu(menus.Ansicht().slice(4, 9), b));
viewportEl.append(h('div', { class: 'vp-overlay left' }, vpBtn(`${icon('camera')}Perspektive`, 'Perspektivische Kamera', () => {}), viewBtn, showBtn));

const modeBtns: Record<GizmoMode, HTMLElement> = {
  select: vpBtn(icon('select'), 'Auswählen (Q)', () => setMode('select')),
  translate: vpBtn(icon('move'), 'Verschieben (W)', () => setMode('translate')),
  rotate: vpBtn(icon('rotate'), 'Drehen (E)', () => setMode('rotate')),
  scale: vpBtn(icon('scale'), 'Skalieren (R)', () => setMode('scale')),
};
function setMode(m: GizmoMode): void {
  viewport.setMode(m);
  for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('active', k === m);
}
const spaceBtn = vpBtn('', 'Welt-/Lokales Koordinatensystem (Strg+^)', () => setSpace(viewport.space === 'world' ? 'local' : 'world'));
function setSpace(s: 'world' | 'local'): void {
  viewport.setSpace(s);
  spaceBtn.innerHTML = icon(s === 'world' ? 'world' : 'local');
  spaceBtn.title = s === 'world' ? 'Welt-Koordinaten (klicken für Lokal)' : 'Lokale Koordinaten (klicken für Welt)';
}
setSpace('world');

const snapCtl = (ic: string, title: string, key: 'translate' | 'rotate' | 'scale', values: number[], unit: string) => {
  const stepKey = `${key}Step` as const;
  const toggle = vpBtn('', `${title} an/aus`, () => {
    viewport.snap[key] = !viewport.snap[key];
    update();
  });
  const value = vpBtn('', `${title}-Schritt`, (b) =>
    showMenu(values.map((v) => ({ label: `${v}${unit}`, checked: viewport.snap[stepKey] === v, action: () => ((viewport.snap[stepKey] = v), (viewport.snap[key] = true), update()) })), b),
  );
  const update = () => {
    toggle.innerHTML = icon(ic);
    toggle.classList.toggle('active', viewport.snap[key]);
    value.textContent = `${viewport.snap[stepKey]}${unit}`;
    viewport.applySnap();
  };
  update();
  return h('div', { class: 'vp-seg' }, toggle, value);
};
const speedBtn = vpBtn('', 'Kamerageschwindigkeit (Mausrad bei gedrückter rechter Maustaste)', (b) =>
  showMenu([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: `Stufe ${n}`, checked: viewport.speedIndex === n - 1, action: () => ((viewport.speedIndex = n - 1), updateSpeed()) })), b),
);
const updateSpeed = () => (speedBtn.innerHTML = `${icon('camera')}${viewport.speedIndex + 1}`);
updateSpeed();
viewportEl.addEventListener('wheel', () => requestAnimationFrame(updateSpeed));
viewportEl.append(
  h(
    'div',
    { class: 'vp-overlay right' },
    h('div', { class: 'vp-seg' }, ...Object.values(modeBtns)),
    spaceBtn,
    snapCtl('grid', 'Raster-Snapping', 'translate', [0.05, 0.1, 0.25, 0.5, 1, 2, 5], ' m'),
    snapCtl('angle', 'Winkel-Snapping', 'rotate', [1, 5, 10, 15, 30, 45, 90], '°'),
    snapCtl('scale', 'Skalierungs-Snapping', 'scale', [0.05, 0.1, 0.25, 0.5, 1], ''),
    speedBtn,
  ),
);
setMode('translate');

const contentEl = document.getElementById('content')!;
const contentSplit = document.querySelector<HTMLElement>('[data-split="content"]')!;
function toggleContent(): void {
  const hidden = contentEl.classList.toggle('hidden');
  contentSplit.classList.toggle('hidden', hidden);
}

function toggleFps(): void {
  viewport.setShowFps(!viewport.showFps);
  try {
    localStorage.setItem(FPS_KEY, viewport.showFps ? '1' : '0');
  } catch {
    /* Speicher gesperrt — Einstellung gilt nur für diese Sitzung */
  }
}
try {
  if (localStorage.getItem(FPS_KEY) === '1') viewport.setShowFps(true);
} catch {
  /* ignorieren */
}

// ---------- Statusanzeigen ----------

state.on('meta', () => {
  mapTitle.innerHTML = '';
  mapTitle.append('Map:', h('b', {}, state.map.name + (state.dirty ? ' *' : '')));
  document.title = `${state.dirty ? '* ' : ''}${state.map.name} — BodyCam Map-Editor`;
  statusDirty.textContent = state.dirty ? '● Ungespeichert' : '';
  updateToolbar();
  renderDocTabs();
});
const updateCount = () => {
  const scripts = state.map.objects.filter((o) => o.script?.code).length;
  statusCount.textContent = `${state.map.objects.length} Objekte · ${scripts} mit Script`;
};
state.on('scene', updateCount);
window.addEventListener('beforeunload', (e) => {
  if (state.dirty || (modelerOpen && modeler?.isDirty)) e.preventDefault();
});

// ---------- Tastenkürzel ----------

function showShortcuts(): void {
  const rows: [string, string][] = [
    ['RMT halten + WASD / Q E', 'Fliegen (Mausrad: Geschwindigkeit, Shift: schneller)'],
    ['Mausrad', 'Vor / zurück'],
    ['MMT ziehen', 'Kamera verschieben'],
    ['Alt + LMT ziehen', 'Um Auswahl kreisen'],
    ['F', 'Auswahl fokussieren'],
    ['Q / W / E / R', 'Auswählen / Verschieben / Drehen / Skalieren'],
    ['Leertaste', 'Gizmo-Modus wechseln'],
    ['Strg + ^', 'Welt / Lokal umschalten'],
    ['Alt + Gizmo ziehen', 'Duplizieren und verschieben'],
    ['Strg/Shift + Klick', 'Mehrfachauswahl'],
    ['Strg + D', 'Duplizieren'],
    ['Strg + C / V / X', 'Kopieren / Einfügen / Ausschneiden'],
    ['Entf', 'Löschen'],
    ['Ende', 'Auf Boden setzen'],
    ['F2', 'Umbenennen'],
    ['H / Strg + H', 'Ausblenden / Alle einblenden'],
    ['Strg + Umsch + H', 'FPS anzeigen'],
    ['G', 'Spielansicht (Editor-Hilfen aus)'],
    ['Strg + L halten + Maus', 'Sonne drehen'],
    ['Strg + Z / Y', 'Rückgängig / Wiederholen'],
    ['Strg + S', 'Speichern'],
    ['Alt + P', 'Im Spiel testen'],
    ['Alt + S / Esc', 'Simulieren / Stopp'],
    ['Strg + Leertaste', 'Content Browser ein/aus'],
    ['Umsch + 1 … 6', 'Modus: Auswahl, Landscape, Foliage, …'],
    ['1 … 9 (Landscape)', 'Werkzeug: Formen … Region, Malen'],
    ['1 … 5 (Foliage)', 'Werkzeug: Malen, Radieren, Auswählen, Neu anwenden, Füllen'],
    ['[ / ] · Strg + Mausrad', 'Pinselgröße (Landscape, Foliage)'],
    ['Strg + Umsch + Mausrad', 'Pinselstärke (Landscape) / Dichte (Foliage)'],
    ['Umsch + Pinsel', 'Umkehren: senken / Loch füllen / Layer / Foliage radieren'],
    ['Entf (Foliage)', 'Ausgewählte Instanzen löschen'],
  ];
  dialog('Tastenkürzel', h('div', { class: 'shortcuts' }, ...rows.flatMap(([k, v]) => [h('kbd', {}, k), h('span', {}, v)])), [{ label: 'OK', primary: true }]);
}

function showScriptHelp(): void {
  dialog(
    'Scripts mit Blöcken',
    `<p>Jedes Objekt kann ein Script bekommen: auswählen → <b>Details › Script hinzufügen</b> (oder Rechtsklick → Script).</p>
     <p>Ein Script beginnt immer mit einem gelben <b>Ereignis</b>-Block („Wenn …“). Darunter hängst du Aktionen, z. B.:</p>
     <p style="padding-left:12px">Wenn Spieler mich benutzt, Hinweis „Tür öffnen“<br>→ drehe in 1 Sek. um y 90°</p>
     <p>Mit <b>sende Nachricht</b> / <b>Wenn ich Nachricht empfange</b> sprechen Objekte miteinander (z. B. Schalter → Lampe).
     Trigger-Volumen + „Wenn Spieler meinen Bereich betritt“ lösen Ereignisse beim Betreten aus.</p>
     <p><b>Simulieren</b> führt Scripts direkt im Editor aus (Kamera = Spieler, Klick = Benutzen, Shift+Klick = Treffer).
     <b>Spielen</b> öffnet die Map im Spiel.</p>`,
    [{ label: 'OK', primary: true }],
  );
}

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (scriptEditor.isOpen || screenEditor.isOpen || document.querySelector('.modal-back:not(.hidden)')) return;
  if (t.closest('input, select, textarea, .blocklyWidgetDiv')) return;
  if (activeTab === 'modeler') return; // der Modeler hat eigene Tastenkürzel
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.code;
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };

  if (ctrl) {
    if (key === 'KeyS') return run(() => void (e.shiftKey ? saveAs() : save()));
    if (key === 'KeyO') return run(() => void openDialog());
    if (key === 'KeyN') return run(() => void newMap());
    if (key === 'KeyZ') return run(() => (e.shiftKey ? state.redo() : state.undo()));
    if (key === 'KeyY') return run(() => state.redo());
    if (key === 'KeyD') return run(duplicate);
    if (key === 'KeyC') return run(() => state.copy() && status(`${state.selection.length} Objekt(e) kopiert`));
    if (key === 'KeyV') return run(() => state.paste());
    if (key === 'KeyX') return run(() => state.copy() && deleteSelected());
    if (key === 'KeyA') return run(() => state.select(state.map.objects.map((o) => o.id)));
    if (key === 'KeyH') return run(e.shiftKey ? toggleFps : unhideAll);
    if (key === 'Space') return run(toggleContent);
    if (key === 'Backquote' || key === 'Backslash') return run(() => setSpace(viewport.space === 'world' ? 'local' : 'world'));
    return;
  }
  if (e.altKey) {
    if (key === 'KeyP') return run(() => void play());
    if (key === 'KeyS') return run(toggleSimulation);
    return;
  }
  if (viewport.isFlying) return; // WASDQE gehören der Kamera
  if (viewport.simulating) {
    if (key === 'Escape') run(() => viewport.stopSimulation());
    return;
  }
  if (modes.key(e)) return run(() => {});
  switch (key) {
    case 'Escape':
      return run(() => state.select([]));
    case 'KeyQ':
      return run(() => setMode('select'));
    case 'KeyW':
      return run(() => setMode('translate'));
    case 'KeyE':
      return run(() => setMode('rotate'));
    case 'KeyR':
      return run(() => setMode('scale'));
    case 'Space': {
      const order: GizmoMode[] = ['translate', 'rotate', 'scale'];
      return run(() => setMode(order[(order.indexOf(viewport.mode) + 1) % 3]));
    }
    case 'KeyF':
      return run(() => viewport.focus(state.selection));
    case 'KeyG':
      return run(() => viewport.setShowHelpers(!viewport.showHelpers));
    case 'KeyH':
      return run(hideSelected);
    case 'F2':
      return run(() => state.primary && outliner.rename(state.primary.id));
    case 'End':
      return run(() => viewport.snapToFloor());
    case 'Delete':
    case 'Backspace':
      return run(deleteSelected);
  }
});

// ---------- Start ----------

await loading.step(0.15, 'Gespeicherte Map wird gelesen …');
const last = localStorage.getItem(LAST_KEY);
let lastMap: MapData | null = null;
try {
  lastMap = last ? await loadLocalMap(last) : null;
  await openMap(lastMap ?? MAPS.start, 0.2);
} catch (e) {
  loading.fail(`Laden fehlgeschlagen: ${(e as Error).message}`);
  throw e;
}
updateCount();
status(lastMap ? `„${lastMap.name}“ geladen` : 'Startmap geladen — Strg+S speichert sie im Browser, ▶ Spielen testet sie im Spiel');
void details;

// Binär-Daten aufräumen, auf die keine gespeicherte Map mehr verweist. Nur beim Start (die Undo-Historie dieser
// Sitzung ist noch leer) und nur, wenn kein anderer Editor-Tab offen ist — der könnte importierte, noch nicht
// gespeicherte Blobs brauchen. Jeder Editor-Tab hält dazu eine geteilte Sperre, solange er offen ist.
async function collectGarbageIfAlone(): Promise<void> {
  if (!navigator.locks) return;
  await new Promise<void>((acquired) => {
    void navigator.locks.request('bodycam-editor', { mode: 'shared' }, () => {
      acquired();
      return new Promise<never>(() => {});
    });
  });
  const held = (await navigator.locks.query()).held ?? [];
  if (held.filter((l) => l.name === 'bodycam-editor').length > 1) return;
  const n = await collectBlobGarbage();
  if (n) console.info(`${n} unbenutzte Binär-Datei(en) aus dem Browser-Speicher entfernt`);
}
collectGarbageIfAlone().catch((e) => console.warn('Aufräumen des Blob-Speichers fehlgeschlagen', e));
