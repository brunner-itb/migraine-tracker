import Dexie, { type Table } from 'dexie';
import type {
  MigraineAttack,
  CycleEvent,
  Medication,
  MedicationIntake,
  UserSettings,
  WeatherData,
  PainEntry,
  FoodEntry,
} from './types';

/**
 * MigraineDB – die zentrale Dexie-Instanz.
 *
 * Relationen (logisch, über FK-Felder; IndexedDB hat keine echten FKs):
 *
 *   MigraineAttack ──1:1──> WeatherData        via attacks.weatherId
 *   MigraineAttack ──1:n──> MedicationIntake   via intakes.attackId
 *   Medication     ──1:n──> MedicationIntake   via intakes.medicationId
 *   (MedicationIntake ist die n:m-Verbindung zwischen Attacke und Medikament)
 *
 *   CycleEvent ist bewusst "eigenständig" (kein FK zur Attacke):
 *   Zyklus-Phasen werden über Datum-Overlaps zur Attacke zugeordnet,
 *   weil eine Attacke in mehrere Ereignisse fallen kann und umgekehrt.
 *
 *   UserSettings ist eigenständig (kein FK): Single-Row-Tabelle (id: 1)
 *   für globale App-Einstellungen, z. B. festen Standort + GPS-Fallback.
 *
 *   painEntries.attackId -> attacks.id (logisch, Kaskade in attackRepository.deleteAttack)
 *
 *   foodEntries ist eigenständig (kein FK): tagesbasiertes
 *   Lebensmittel-Log; Korrelation per 24-h-Fenster (statisticsService).
 */
export class MigraineDB extends Dexie {
  attacks!: Table<MigraineAttack, number>;
  cycleEvents!: Table<CycleEvent, number>;
  medications!: Table<Medication, number>;
  medicationIntakes!: Table<MedicationIntake, number>;
  weatherData!: Table<WeatherData, number>;
  settings!: Table<UserSettings, number>;
  painEntries!: Table<PainEntry, number>;
  foodEntries!: Table<FoodEntry, number>;

  constructor() {
    super('migraine-tracker');

    // Index-Syntax (Dexie):
    //   ++id      -> auto-incrementing Primärschlüssel
    //   &feld     -> unique Index (z. B. &attackId erzwingt 1:1)
    //   [a+b]     -> Composite-Index (für Joins/Overlaps)
    this.version(1).stores({
      attacks:
        '++id, startTime, painLevel, type, weatherId, [startTime+endTime]',

      // Overlap-Abfragen: "welche PMS-/Menstruations-Tage berühren diese Attacke?"
      cycleEvents: '++id, type, date, endDate, [type+date]',

      medications: '++id, name, role, isActive',

      // Joins von beiden Seiten + Vermeidung doppelter Einnahmen pro Attacke
      medicationIntakes:
        '++id, attackId, medicationId, [attackId+medicationId]',

      // &attackId = unique -> garantiert 1:1 zwischen Attacke und Wetter
      weatherData: '++id, &attackId, timestamp, status',
    });

    // Version 2: globale Einstellungen (Single-Row, id: 1).
    // Bestehende Tabellen werden von Dexie implizit übernommen.
    this.version(2).stores({
      settings: 'id',
    });

    // Version 3: Schmerzverlauf (Schmerzzeitpunkte pro Attacke).
    // Bestehende Tabellen werden von Dexie implizit übernommen.
    this.version(3).stores({
      painEntries: '++id, attackId, time',
    });

    // Version 4: Lebensmittel (Tagesbasis, eigenständig wie cycleEvents).
    // Korrelation erfolgt rechnerisch per 24-h-Fenster (statisticsService).
    this.version(4).stores({
      foodEntries: '++id, date, category, [date+category]',
    });
  }
}

/** Singleton-Export – in der App überall `import { db } from './db'`. */
export const db = new MigraineDB();
