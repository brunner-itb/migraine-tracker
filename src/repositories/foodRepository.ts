import { db, type MigraineDB } from '../db/database';
import type { FoodEntry } from '../db/types';

/**
 * foodRepository – Persistenzschicht für das tagesbasierte
 * Lebensmittel-Log (Tab „Ernährung“).
 *
 * foodEntries ist eigenständig (kein FK zur Attacke, Semantik wie
 * cycleEvents) → Löschung ist trivial, keine Kaskaden. Die
 * Fenster-Korrelation (24 h vor Attacken) rechnet der pure
 * statisticsService; das Repository kennt sie nicht.
 */

/** Eintrag wie er in der UI eingegeben wird (id/createdAt füllt das Repository). */
export type NewFoodEntry = Omit<FoodEntry, 'id' | 'createdAt'>;

export class FoodRepository {
  constructor(private readonly database: MigraineDB = db) {}

  /** Legt einen Eintrag an und gibt ihn mit ID zurück. */
  async addFoodEntry(data: NewFoodEntry): Promise<FoodEntry> {
    this.validate(data);
    const entry: FoodEntry = { ...data, createdAt: new Date().toISOString() };
    entry.id = await this.database.foodEntries.add(entry);
    return entry;
  }

  /** Ersetzt alle Inhaltsfelder eines Eintrags (id/createdAt bleiben). */
  async updateFoodEntry(id: number, data: NewFoodEntry): Promise<void> {
    this.validate(data);
    await this.database.foodEntries.update(id, data);
  }

  /** Löscht einen Eintrag. */
  async deleteFoodEntry(id: number): Promise<void> {
    await this.database.foodEntries.delete(id);
  }

  /**
   * Alle Einträge eines Tages ('YYYY-MM-DD'), sortiert nach Uhrzeit
   * (zeitpunktlose Einträge = '99:99' → ans Ende) und dann Name (de).
   */
  async getFoodEntriesForDay(date: string): Promise<FoodEntry[]> {
    const entries = await this.database.foodEntries
      .where('date')
      .equals(date)
      .toArray();
    return entries.sort(
      (a, b) =>
        (a.time ?? '99:99').localeCompare(b.time ?? '99:99') ||
        a.name.localeCompare(b.name, 'de'),
    );
  }

  /**
   * Alle Einträge im Zeitraum [start, end] ('YYYY-MM-DD', inklusiv),
   * aufsteigend nach Datum. (Vorbereitung für PDF-Spalte/Follow-ups.)
   */
  async getFoodEntriesByDateRange(start: string, end: string): Promise<FoodEntry[]> {
    return this.database.foodEntries
      .filter((e) => e.date >= start && e.date <= end)
      .sortBy('date');
  }

  /**
   * Distinkte, neuere Namen für das Autocomplete (max. `limit`),
   * neueste zuerst (date-Index, umgekehrt).
   */
  async getRecentNames(limit = 30): Promise<string[]> {
    const all = await this.database.foodEntries.orderBy('date').reverse().toArray();
    const names = new Set<string>();
    for (const e of all) {
      names.add(e.name.trim());
      if (names.size >= limit) break;
    }
    return [...names];
  }

  /** Basis-Plausibilität vor dem Write (UI bleibt die Haupt-Validierung). */
  private validate(e: NewFoodEntry): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
      throw new Error('foodRepository: date muss das Format YYYY-MM-DD haben');
    }
    if (e.time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time)) {
      throw new Error('foodRepository: time muss das Format HH:mm haben');
    }
    if (e.name.trim() === '') {
      throw new Error('foodRepository: Name fehlt');
    }
  }
}

/** Fertige Instanz (Default: globale Dexie-DB; in Tests injizierbar). */
export const foodRepository = new FoodRepository();
