import { normalizeMap, type MapData } from '../world/mapFormat.ts';
import { NO_BLOBS, UrlBlobs, type BlobSource } from '../world/blobStore.ts';
import startMap from './start.json';
import trainingMap from './training.json';
import oldtimerMap from './oldtimer.json';

// Mitgelieferte Maps, zwei Quellen:
//  - kleine Maps ohne Binär-Daten: JSON in src/maps/<id>.json, hier eintragen (im Editor „Als JSON exportieren“)
//  - große Maps mit Blobs: .bcmap-Export entpackt nach public/maps/<id>/ (map.json + blobs/), wird per fetch geladen
// Aufruf im Spiel: /?map=<id>
export const MAPS: Record<string, MapData> = {
  start: normalizeMap(startMap),
  training: normalizeMap(trainingMap),
  // Oldtimer mit Block-Script (erzeugt von scripts/make-oldtimer-map.ts)
  oldtimer: normalizeMap(oldtimerMap),
};

export interface BundledMap {
  map: MapData;
  blobs: BlobSource;
}

/** Mitgelieferte Map laden (erst src/maps, dann public/maps/<id>/); null, wenn es sie nicht gibt */
export async function loadBundledMap(id: string): Promise<BundledMap | null> {
  if (MAPS[id]) return { map: MAPS[id], blobs: NO_BLOBS };
  if (!/^[\w-]+$/.test(id)) return null;
  const base = `${import.meta.env.BASE_URL}maps/${id}`;
  try {
    const res = await fetch(`${base}/map.json`);
    // Vite liefert für unbekannte Pfade index.html (200, text/html) → am Inhaltstyp erkennen
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return null;
    return { map: normalizeMap(await res.json()), blobs: new UrlBlobs(base) };
  } catch (e) {
    console.warn(`Map "${id}" aus public/maps konnte nicht geladen werden`, e);
    return null;
  }
}
