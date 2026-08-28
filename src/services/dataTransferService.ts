/**
 * dataTransferService – Daten-Export/-Import (Backup & Restore).
 *
 * Bewusst einfach gehalten (Todo: "zunächst einfach halten"):
 *  - Export: ALLE Tabellen der Dexie-DB als eine JSON-Datei (Download).
 *  - Import: JSON-Datei -> Validieren -> ALLE Daten ersetzen (atomare
 *    Transaktion, bei Fehler Rollback). Semantik: Backup/Restore, z. B.
 *    neues Gerät. Die UI schützt mit einem Bestätigungs-Dialog.
 *
 * Keine UI-Logik hier: reine Funktionen (erstellen/serialisieren/
 * parsen/validieren/importieren + Download-Trigger). Die SettingsView
 * orchestriert Datei-Picker, Bestätigung und Statusmeldungen.
 */

import { db, type MigraineDB } from '../db/database';
import type {
  CycleEvent,
  Medication,
  MedicationIntake,
  MigraineAttack,
  PainEntry,
  UserSettings,
  WeatherData,
} from '../db/types';

/** Export-Formatversion (für zukünftige Kompatibilität). */
export const EXPORT_FORMAT_VERSION = 2;

/** App-Kennung im Export (Schutz vor falschen Dateien). */
const APP_ID = 'migraine-tracker';

/** Tabellennamen im Export (Reihenfolge = Import-Reihenfolge). */
const TABLE_KEYS = [
  'attacks',
  'cycleEvents',
  'medications',
  'medicationIntakes',
  'painEntries',
  'weatherData',
  'settings',
] as const;

/** Der Daten-Block: Inhalt aller Tabellen. */
export interface ExportData {
  attacks: MigraineAttack[];
  cycleEvents: CycleEvent[];
  medications: Medication[];
  medicationIntakes: MedicationIntake[];
  painEntries: PainEntry[];
  weatherData: WeatherData[];
  settings: UserSettings[];
}

/** Top-Level-Struktur der Export-Datei. */
export interface DataExport {
  app: typeof APP_ID;
  version: number;
  /** ISO-Zeitstempel des Exports. */
  exportedAt: string;
  data: ExportData;
}

/** Zähler pro Tabelle (für UI-Feedback nach dem Import). */
export interface ImportResult {
  attacks: number;
  cycleEvents: number;
  medications: number;
  medicationIntakes: number;
  painEntries: number;
  weatherData: number;
  settings: number;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Lädt alle Tabellen und baut den Export-Objektbaum.
 * @param database injizierbare DB (Default: globale Dexie-Instanz).
 */
export async function createDataExport(
  database: MigraineDB = db,
): Promise<DataExport> {
  const [attacks, cycleEvents, medications, medicationIntakes, painEntries, weatherData, settings] =
    await Promise.all([
      database.attacks.toArray(),
      database.cycleEvents.toArray(),
      database.medications.toArray(),
      database.medicationIntakes.toArray(),
      database.painEntries.toArray(),
      database.weatherData.toArray(),
      database.settings.toArray(),
    ]);
  return {
    app: APP_ID,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    data: { attacks, cycleEvents, medications, medicationIntakes, painEntries, weatherData, settings },
  };
}

/** Export-Objekt als JSON-String (formatiert, für Lesbarkeit beim Backup). */
export function serializeDataExport(exp: DataExport): string {
  return JSON.stringify(exp, null, 2);
}

/**
 * Startet den Download der Export-Datei (iOS-Safari: <a download> +
 * Object-URL; Safari 13+ unterstützt das in PWA-Standalone-Modus).
 */
export function downloadDataExport(exp: DataExport): void {
  const blob = new Blob([serializeDataExport(exp)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `migranetracker-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Object-URL erst verzögert freigeben, damit Safari den Download
  // zuverlässig starten kann.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Parst und validiert eine Export-Datei (JSON-String).
 * @throws Error mit deutscher Meldung, wenn die Datei kein gültiger
 *          Migräne-Tracker-Export ist.
 */
export function parseDataExport(json: string): DataExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Die Datei ist kein gültiges JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Ungültige Export-Datei: erwartetes Datenobjekt fehlt.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.app !== APP_ID) {
    throw new Error('Das ist kein Migräne-Tracker-Export (falsche App).');
  }
  if (
    typeof obj.version !== 'number' ||
    obj.version < 1 ||
    obj.version > EXPORT_FORMAT_VERSION
  ) {
    throw new Error('Die Export-Datei ist für eine andere App-Version.');
  }
  if (
    typeof obj.exportedAt !== 'string' ||
    Number.isNaN(new Date(obj.exportedAt).getTime())
  ) {
    throw new Error('Ungültige Export-Datei: Exportdatum fehlt.');
  }
  const data = obj.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Ungültige Export-Datei: Daten-Block fehlt.');
  }
  const dataObj = data as Record<string, unknown>;
  // painEntries ist optional: Exports vor Version 2 kennen die Tabelle
  // noch nicht und bleiben importierbar (werden leer übernommen).
  for (const key of TABLE_KEYS) {
    if (key === 'painEntries') {
      if (dataObj[key] !== undefined && !Array.isArray(dataObj[key])) {
        throw new Error(`Ungültige Export-Datei: Tabelle „${key}“ ist fehlerhaft.`);
      }
      continue;
    }
    if (!Array.isArray(dataObj[key])) {
      throw new Error(`Ungültige Export-Datei: Tabelle „${key}“ fehlt.`);
    }
  }
  return parsed as DataExport;
}

/**
 * Importiert einen validierten Export: ALLE Tabellen werden ersetzt
 * (clear + bulkPut in einer einzigen rw-Transaktion -> atomar, bei
 * Fehler vollständig zurückgerollt).
 * @returns Zähler pro Tabelle (für UI-Feedback).
 */
export async function importDataExport(
  exp: DataExport,
  database: MigraineDB = db,
): Promise<ImportResult> {
  const { attacks, cycleEvents, medications, medicationIntakes, weatherData, settings } =
    exp.data;
  // Optional: Exports vor Version 2 kennen die Tabelle noch nicht.
  const painEntries = Array.isArray(exp.data.painEntries) ? exp.data.painEntries : [];

  await database.transaction(
    'rw',
    [
      database.attacks,
      database.cycleEvents,
      database.medications,
      database.medicationIntakes,
      database.painEntries,
      database.weatherData,
      database.settings,
    ],
    async () => {
      await Promise.all([
        database.attacks.clear(),
        database.cycleEvents.clear(),
        database.medications.clear(),
        database.medicationIntakes.clear(),
        database.painEntries.clear(),
        database.weatherData.clear(),
        database.settings.clear(),
      ]);
      // bulkPut statt bulkAdd: Zeilen haben bereits IDs (Auto-Increment
      // setzt nach dem Import auf max(id)+1 fort, keine Kollisionen).
      // Normalisierung: ältere Exports kennen locationName noch nicht ->
      // Default '' (= automatisch), damit alle Zeilen das Feld tragen.
      if (attacks.length > 0) {
        await database.attacks.bulkPut(
          attacks.map((a) => ({ ...a, locationName: a.locationName ?? '' })),
        );
      }
      if (cycleEvents.length > 0) await database.cycleEvents.bulkPut(cycleEvents);
      if (medications.length > 0) await database.medications.bulkPut(medications);
      if (medicationIntakes.length > 0) {
        await database.medicationIntakes.bulkPut(medicationIntakes);
      }
      if (painEntries.length > 0) await database.painEntries.bulkPut(painEntries);
      if (weatherData.length > 0) await database.weatherData.bulkPut(weatherData);
      if (settings.length > 0) await database.settings.bulkPut(settings);
    },
  );

  return {
    attacks: attacks.length,
    cycleEvents: cycleEvents.length,
    medications: medications.length,
    medicationIntakes: medicationIntakes.length,
    painEntries: painEntries.length,
    weatherData: weatherData.length,
    settings: settings.length,
  };
}
