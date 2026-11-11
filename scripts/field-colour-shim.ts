// Ersatz für @blockly/field-colour beim Ausführen in Node (run-with-vite.mjs): das Paket braucht ein DOM.
// Für das Erzeugen von Script-Code reicht ein Feld, das den Farbwert als Text hält.
import * as Blockly from 'blockly';

class FieldColour extends Blockly.FieldTextInput {
  static override fromJson(o: { colour?: string }): FieldColour {
    return new FieldColour(o.colour ?? '#ffffff');
  }
}

export function registerFieldColour(): void {
  Blockly.fieldRegistry.register('field_colour', FieldColour);
}

export const colourPicker = { installBlock(): void {} };
