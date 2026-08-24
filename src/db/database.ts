import Dexie, { type Table } from 'dexie';
import type {
  MigraineAttack,
  CycleEvent,
  Medication,
  MedicationIntake,
  UserSettings,
  WeatherData,
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
 */
export class MigraineDB extends Dexie {
  attacks!: Table<MigraineAttack, number>;
  cycleEvents!: Table<CycleEvent, number>;
  medications!: Table<Medication, number>;
  medicationIntakes!: Table<MedicationIntake, number>;
  weatherData!: Table<WeatherData, number>;
  settings!: Table<UserSettings, number>;

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
  }
}

/** Singleton-Export – in der App überall `import { db } from './db'`. */
export const db = new MigraineDB();
