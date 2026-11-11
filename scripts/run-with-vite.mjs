// Führt ein TypeScript-Script mit den Modul-Regeln des Projekts aus (Vite löst .ts und virtuelle Module auf):
//   node scripts/run-with-vite.mjs scripts/make-oldtimer-map.ts
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
if (!file) throw new Error('Aufruf: node scripts/run-with-vite.mjs <script.ts>');
const server = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
  // das Farbfeld-Paket braucht ein DOM → für Node durch ein einfaches Textfeld ersetzen
  resolve: { alias: { '@blockly/field-colour': fileURLToPath(new URL('./field-colour-shim.ts', import.meta.url)) } },
});
try {
  await server.ssrLoadModule('/' + file.split('\\').join('/').replace(/^\.?\//, ''));
} finally {
  await server.close();
}
