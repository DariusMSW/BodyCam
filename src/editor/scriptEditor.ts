import * as Blockly from 'blockly';
import { BLOCKLY_THEME, TOOLBOX, generateCode, installBlocks, setScriptParts } from '../scripting/blocks.ts';
import { loadModel } from '../world/modelStore.ts';
import type { MapObjectData, ScriptData } from '../world/mapFormat.ts';
import { ASSETS } from '../world/assets.ts';
import { h, iconEl, toast } from './ui.ts';

// Fenster zum Programmieren eines Objekts mit Scratch-ähnlichen Blöcken (Blockly, Zelos-Renderer).

export class ScriptEditor {
  private back: HTMLElement;
  private win: HTMLElement;
  private title: HTMLElement;
  private sub: HTMLElement;
  private codeEl: HTMLElement;
  private placeholder: HTMLElement;
  private host: HTMLElement;
  private ws: Blockly.WorkspaceSvg | null = null;
  private target: MapObjectData | null = null;
  private onApply: ((script: ScriptData | undefined) => void) | null = null;
  private showCode = false;

  constructor() {
    this.title = h('div', { class: 'title' });
    this.sub = h('div', { class: 'sub' });
    this.codeEl = h('div', { class: 'script-code hidden' });
    this.host = h('div', { class: 'script-blockly' });
    this.placeholder = h('div', { class: 'script-placeholder', html: 'Ziehe einen <b style="color:#ffbf00">Ereignis</b>-Block hierher,<br>z. B. „Wenn Spieler mich benutzt“' });
    this.host.append(this.placeholder);
    const codeBtn = h('button', { class: 'btn' }, 'Code anzeigen');
    codeBtn.addEventListener('click', () => {
      this.showCode = !this.showCode;
      this.codeEl.classList.toggle('hidden', !this.showCode);
      codeBtn.textContent = this.showCode ? 'Code ausblenden' : 'Code anzeigen';
      this.updateCode();
      if (this.ws) Blockly.svgResize(this.ws);
    });
    const cancel = h('button', { class: 'btn' }, 'Abbrechen');
    cancel.addEventListener('click', () => this.close(false));
    const apply = h('button', { class: 'btn primary' }, 'Übernehmen & Schließen');
    apply.addEventListener('click', () => this.close(true));
    this.win = h(
      'div',
      { class: 'script-window' },
      h('div', { class: 'script-bar' }, iconEl('script'), this.title, this.sub, h('div', { class: 'tb-spacer' }), codeBtn, cancel, apply),
      h('div', { class: 'script-main' }, this.host, this.codeEl),
    );
    this.back = h('div', { class: 'modal-back hidden' }, this.win);
    // Kein stopPropagation: Blockly braucht die Tasten (Entf, Strg+C/V/Z) am document.
    // Die globalen Editor-Kürzel pausieren, solange das Fenster offen ist (isOpen).
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen || e.key !== 'Escape') return;
      if (document.querySelector('.blocklyDropDownDiv[style*="display: block"], .blocklyWidgetDiv[style*="display: block"]')) return;
      this.close(true);
    });
    document.body.append(this.back);
  }

  get isOpen(): boolean {
    return this.target !== null;
  }

  open(obj: MapObjectData, onApply: (script: ScriptData | undefined) => void): void {
    installBlocks();
    this.target = obj;
    this.onApply = onApply;
    this.title.innerHTML = '';
    this.title.append(h('span', { class: 'tag' }, 'SCRIPT'), obj.name);
    this.sub.textContent = ASSETS[obj.type]?.label ?? obj.type;
    this.back.classList.remove('hidden');
    this.loadParts(obj);
    if (!this.ws) {
      this.ws = Blockly.inject(this.host, {
        toolbox: TOOLBOX,
        renderer: 'zelos',
        theme: BLOCKLY_THEME(),
        trashcan: true,
        sounds: false,
        grid: { spacing: 24, length: 2, colour: '#2a2a2a', snap: true },
        zoom: { controls: true, wheel: true, startScale: 0.75, maxScale: 2, minScale: 0.3, scaleSpeed: 1.15 },
        move: { scrollbars: true, drag: true, wheel: false },
      });
      this.ws.addChangeListener((e) => {
        if (e.isUiEvent) return;
        this.updateCode();
      });
    }
    this.ws.clear();
    if (obj.script?.blocks) {
      try {
        Blockly.serialization.workspaces.load(obj.script.blocks as object, this.ws);
      } catch (e) {
        toast(`Script konnte nicht geladen werden: ${(e as Error).message}`, 'error');
      }
    }
    requestAnimationFrame(() => {
      if (!this.ws) return;
      Blockly.svgResize(this.ws);
      if (this.ws.getTopBlocks(false).length) this.ws.scrollCenter();
      this.updateCode();
    });
  }

  /** Benannte Teile des Modells für die Auswahllisten der „Modell-Teile“-Blöcke */
  private loadParts(obj: MapObjectData): void {
    setScriptParts([]);
    const ref = obj.type === 'model' ? String(obj.props.model ?? '') : '';
    if (!ref) return;
    void loadModel(ref).then((model) => {
      if (!model || this.target !== obj) return;
      const names = new Set<string>();
      model.traverse((o) => {
        if (!o.name || o === model) return;
        // Meshes mit mehreren Materialien kommen als Gruppe "Tür" mit Kindern "Tür_1", "Tür_2" … — nur die Gruppe zählt
        const tail = o.parent?.name && o.name.startsWith(o.parent.name + '_') ? o.name.slice(o.parent.name.length + 1) : '';
        if ((o as { isMesh?: boolean }).isMesh && /^\d+$/.test(tail)) return;
        names.add(o.name);
      });
      setScriptParts([...names]);
    });
  }

  private updateCode(): void {
    if (!this.ws) return;
    this.placeholder.classList.toggle('hidden', this.ws.getTopBlocks(false).length > 0);
    if (this.showCode) this.codeEl.textContent = generateCode(this.ws) || '// Noch keine Ereignis-Blöcke';
  }

  private close(apply: boolean): void {
    if (!this.target || !this.ws) return;
    if (apply) {
      const code = generateCode(this.ws);
      try {
        // Syntaxprüfung (async, weil Handler await benutzen)
        new Function('api', code);
      } catch (e) {
        toast(`Script-Fehler: ${(e as Error).message}`, 'error', 5000);
        return;
      }
      const blocks = Blockly.serialization.workspaces.save(this.ws);
      const empty = this.ws.getTopBlocks(false).length === 0;
      this.onApply?.(empty ? undefined : { blocks, code });
    }
    Blockly.hideChaff();
    this.target = null;
    this.onApply = null;
    this.back.classList.add('hidden');
  }
}
