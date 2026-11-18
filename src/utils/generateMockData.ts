/**
 * generateMockData – temporärer Seeder für Testzwecke (Schritt: Testing).
 *
 * Befüllt die lokale Dexie-DB mit realistischen Beispieldaten für die
 * letzten 3 Monate:
 *   - 2–3 Standard-Medikamente (nur wenn `medications` leer ist)
 *   - 5–8 Attacken pro Monat (nur wenn `attacks` leer ist)
 *   - ~60% der Attacken mit Medikamenteneinnahme (inkl. Wirkungsgrad)
 *   - ~50% der Attacken mit 1–3 Schmerzverlauf-Einträgen (abfallend)
 *   - Wetterdaten für alle Attacken (via attackRepository.retryMissingWeather)
 *   - Menstruations-Events ca. alle 28 Tage (nur wenn `cycleEvents` leer ist)
 *   - Lebensmittel-Einträge: ~60% der Attacken mit „Trigger“-Eintrag
 *     2–20 h vor dem Start + ~50% der übrigen Tage mit Zufalls-Einträgen
 *     (nur wenn `foodEntries` leer ist)
 *
 * Idempotenz: Jede Tabelle wird nur befüllt, wenn sie leer ist –
 * vorhandene (echte) Daten bleiben unverändert. Nach dem Seed lädt die
 * UI die Seite neu (window.location.reload()).
 */

import { db } from '../db/database';
import { attackRepository } from '../repositories/attackRepository';
import type {
  AttackType,
  EffectivenessScore,
  FoodCategory,
  Medication,
  MigraineAttack,
} from '../db/types';
import type { Coordinates } from '../services/weatherService';

// ---------------------------------------------------------------------------
// Ergebnis
// ---------------------------------------------------------------------------

export interface SeedResult {
  medicationsAdded: number;
  attacksAdded: number;
  intakesAdded: number;
  painEntriesAdded: number;
  cycleEventsAdded: number;
  foodEntriesAdded: number;
  /** Wetterabrufe, die nach dem Seed erfolgreich waren. */
  weatherFetched: number;
  /** Wetterabrufe, die fehlgeschlagen sind (Status 'error', Retry beim Start). */
  weatherFailed: number;
  /** true, wenn Attacken/Cyklus wegen vorhandener Daten übersprungen wurden. */
  skippedExistingAttacks: boolean;
}

// ---------------------------------------------------------------------------
// Zufalls-Helfer
// ---------------------------------------------------------------------------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function chance(p: number): boolean {
  return Math.random() < p;
}

/** 'YYYY-MM-DDTHH:mm' in Ortszeit (Format der App, lexikografisch sortierbar). */
function toLocalISO(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 'YYYY-MM-DD' in Ortszeit (für reine Datumsfelder). */
function toDateOnly(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

/** Wirkungsgrad 0–3 mit realistischer Verteilung (oft "gut", seltener "keine"). */
function weightedEffectiveness(): EffectivenessScore {
  const r = Math.random();
  if (r < 0.15) return 0;
  if (r < 0.4) return 1;
  if (r < 0.75) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Konstanten für realistische Daten
// ---------------------------------------------------------------------------

const MEDICATION_DEFS: Omit<Medication, 'id' | 'createdAt'>[] = [
  {
    name: 'Ibuprofen 400mg',
    role: 'acute',
    form: 'Tablette',
    dose: '400 mg',
    notes: 'Erste Wahl bei ersten Anzeichen einer Attacke',
    isActive: true,
  },
  {
    name: 'Sumatriptan 50mg',
    role: 'acute',
    form: 'Tablette',
    dose: '50 mg',
    notes: 'Wenn Ibuprofen nicht ausreichend wirkt',
    isActive: true,
  },
  {
    name: 'Topiramat 100mg',
    role: 'prophylaxis',
    form: 'Tablette',
    dose: '100 mg',
    notes: 'Täglich abends',
    isActive: true,
  },
];

const ATTACK_NOTES: string[] = [
  'Aura vor der Attacke: Zickzacklinien im Gesichtsfeld',
  'Übelkeit, keine Erbrochenheit',
  'Vermuteter Trigger: Schlafmangel',
  'Starker Luftdruckwechsel am Vortag',
  'Einseitig links, pulsierend',
  'Photosensitiv, dunkler Raum nötig',
  'Nach Stress am Arbeitsplatz',
  'Ohne erkennbaren Trigger',
  'Kaffein half leicht',
  '',
];

const SIDE_EFFECTS: string[] = [
  'Leichte Schläfrigkeit',
  'Kurzes Kribbeln im Gesicht',
  'Leichte Übelkeit nach Einnahme',
];

/** Namen pro Kategorie für den Seed (realistische DE-Beispiele). */
const FOOD_POOL: Partial<Record<FoodCategory, string[]>> = {
  alcohol: ['Rotwein', 'Bier', 'Sekt'],
  cheese: ['Käse (Brie)', 'Käse (Parmesan)', 'Käsebrot'],
  chocolate: ['Schokolade', 'Schokoladendessert'],
  curedMeats: ['Schinken', 'Salami', 'Wurstbrot'],
  processed: ['Fast Food', 'Fertiggericht', 'Pizza'],
  caffeine: ['Kaffee', 'Tee', 'Energiedrink'],
  sweet: ['Kuchen', 'Süßigkeiten'],
  spicy: ['Scharfes Essen'],
  gluten: ['Brot', 'Nudeln'],
  lactose: ['Milch', 'Yoghurt', 'Eis'],
  skippedMeal: ['Ausgefallene Mahlzeit'],
  other: ['Obst', 'Suppe', 'Salat'],
};

/** Kategorien, die vor Attacken bevorzugt seeded werden („Trigger“). */
const TRIGGER_CATEGORIES: FoodCategory[] = ['alcohol', 'cheese', 'chocolate', 'curedMeats'];

/** Kategorien für „normale“ Tages-Einträge. */
const NORMAL_CATEGORIES: FoodCategory[] = [
  'caffeine', 'gluten', 'lactose', 'sweet', 'processed', 'other',
];

// ---------------------------------------------------------------------------
// Standort für die Beispieldaten: fest Berlin (PC-Test ohne Geolocation)
// ---------------------------------------------------------------------------

const BERLIN_COORDS: Coordinates = { latitude: 52.52, longitude: 13.405 };

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export async function seedMockData(): Promise<SeedResult> {
  const now = new Date();
  const nowIso = now.toISOString();

  const result: SeedResult = {
    medicationsAdded: 0,
    attacksAdded: 0,
    intakesAdded: 0,
    painEntriesAdded: 0,
    cycleEventsAdded: 0,
    foodEntriesAdded: 0,
    weatherFetched: 0,
    weatherFailed: 0,
    skippedExistingAttacks: false,
  };

  // ------------------------------------------------------------------
  // 1) Medikamente (nur wenn Tabelle leer)
  // ------------------------------------------------------------------
  if ((await db.medications.count()) === 0) {
    for (const def of MEDICATION_DEFS) {
      await db.medications.add({ ...def, createdAt: nowIso });
      result.medicationsAdded += 1;
    }
  }

  // ------------------------------------------------------------------
  // 2) Zyklus-Events: ca. alle 28 Tage, 4–6 Tage Menstruation (nur wenn leer)
  // ------------------------------------------------------------------
  if ((await db.cycleEvents.count()) === 0) {
    // Startpunkt: vor kurzem (4–26 Tage zurück), dann 28 Tage ± 2 rückwärts.
    let cursor = new Date(now.getTime() - randInt(4, 26) * 86_400_000);
    const horizon = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    while (cursor >= horizon) {
      const durationDays = randInt(4, 6);
      const endDate = new Date(cursor.getTime() + (durationDays - 1) * 86_400_000);
      await db.cycleEvents.add({
        type: 'menstruation',
        date: toDateOnly(cursor),
        endDate: toDateOnly(endDate),
        notes: '',
        createdAt: nowIso,
      });
      result.cycleEventsAdded += 1;
      cursor = new Date(cursor.getTime() - (28 + randInt(-2, 2)) * 86_400_000);
    }
  }

  // ------------------------------------------------------------------
  // 3) Attacken: 5–8 pro Monat, letzte 3 Monate (nur wenn Tabelle leer)
  // ------------------------------------------------------------------
  if ((await db.attacks.count()) > 0) {
    // Bestehende Daten nicht anrühren – Seed wird hier abgebrochen.
    result.skippedExistingAttacks = true;
    console.info(
      '[seedMockData] Attacken existieren bereits – Attacken-/Wetter-Skip.',
    );
    return result;
  }

  const coords = BERLIN_COORDS;

  // Letzten 3 Monate (Offset 2 = zweitvorletzter Monat, 0 = aktueller).
  const months: { year: number; month: number }[] = [];
  for (let offset = 2; offset >= 0; offset--) {
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() });
  }

  const meds = await db.medications.toArray();
  const acuteMeds = meds.filter((m) => m.role === 'acute' && m.id !== undefined);

  for (const { year, month } of months) {
    const isCurrentMonth =
      year === now.getFullYear() && month === now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const maxDay = isCurrentMonth ? Math.max(1, now.getDate()) : daysInMonth;

    const countThisMonth = randInt(5, 8);
    for (let i = 0; i < countThisMonth; i++) {
      // Startzeit: zufälliger Tag + Uhrzeit (aktueller Monat: nicht in der Zukunft).
      const start = new Date(
        year,
        month,
        randInt(1, maxDay),
        randInt(0, 23),
        randInt(0, 59),
      );
      // Dauer: 4–48 Stunden (+ Zufallsminuten).
      const durationMs =
        randInt(4, 48) * 3_600_000 + randInt(0, 59) * 60_000;
      const end = new Date(start.getTime() + durationMs);

      // Typ: überwiegend Migräne, ab und zu Spannungskopfschmerz/other.
      const typeRoll = Math.random();
      const type: AttackType =
        typeRoll < 0.75 ? 'migraine' : typeRoll < 0.9 ? 'tension' : 'other';

      const attack: MigraineAttack = {
        startTime: toLocalISO(start),
        endTime: toLocalISO(end),
        painLevel: randInt(3, 9),
        type,
        notes: pick(ATTACK_NOTES),
        locationName: '',
        weatherId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      // Attacke + pending-Wetterzeile in einer atomaren Transaction
      // (gleiche Struktur wie attackRepository.addAttack).
      const attackId = await db.transaction(
        'rw',
        [db.attacks, db.weatherData],
        async () => {
          const id = await db.attacks.add(attack);
          const weatherId = await db.weatherData.add({
            attackId: id,
            timestamp: attack.startTime,
            latitude: coords.latitude,
            longitude: coords.longitude,
            surfacePressure: null,
            surfacePressureMsl: null,
            temperature: null,
            humidity: null,
            status: 'pending',
            fetchedAt: null,
            source: '',
          });
          await db.attacks.update(id, { weatherId });
          return id;
        },
      );
      result.attacksAdded += 1;

      // ----------------------------------------------------------------
      // 4) ~60% der Attacken mit Medikamenteneinnahme
      // ----------------------------------------------------------------
      if (acuteMeds.length > 0 && chance(0.6)) {
        const med = pick(acuteMeds);
        await db.medicationIntakes.add({
          attackId,
          medicationId: med.id!,
          takenAt: toLocalISO(new Date(start.getTime() + randInt(0, 30) * 60_000)),
          dose: med.dose,
          effectiveness: weightedEffectiveness(),
          sideEffects: chance(0.15) ? pick(SIDE_EFFECTS) : '',
        });
        result.intakesAdded += 1;

        // Gelegentlich zweites Akutmedikament (z. B. Sumatriptan nach Ibuprofen).
        const others = acuteMeds.filter((m) => m.id !== med.id);
        if (others.length > 0 && chance(0.25)) {
          const second = pick(others);
          await db.medicationIntakes.add({
            attackId,
            medicationId: second.id!,
            takenAt: toLocalISO(
              new Date(start.getTime() + randInt(60, 180) * 60_000),
            ),
            dose: second.dose,
            effectiveness: weightedEffectiveness(),
            sideEffects: '',
          });
          result.intakesAdded += 1;
        }
      }

      // ----------------------------------------------------------------
      // 4b) ~50% der Attacken mit Schmerzverlauf (1–3 Einträge, abfallend)
      // ----------------------------------------------------------------
      if (chance(0.5)) {
        const startLevel = attack.painLevel;
        const entryCount = randInt(1, 3);
        let t = start.getTime() + randInt(30, 120) * 60_000;
        let level = startLevel;
        for (let k = 0; k < entryCount; k++) {
          if (t >= end.getTime()) break;
          if (k > 0) level = Math.max(1, level - randInt(1, 3));
          await db.painEntries.add({
            attackId,
            time: toLocalISO(new Date(t)),
            level,
          });
          result.painEntriesAdded += 1;
          t += randInt(180, 480) * 60_000;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 5) Wetterdaten für alle Attacken (sequenziell, fair zur API).
  //    Wiederverwendet die bestehende Retry-Logik: alle 'pending'-Zeilen
  //    werden hier abgerufen und auf 'fetched'/'error' gesetzt.
  // ------------------------------------------------------------------
  const retry = await attackRepository.retryMissingWeather(coords);
  result.weatherFetched = retry.succeeded;
  result.weatherFailed = retry.failed;

  // ------------------------------------------------------------------
  // 6) Lebensmittel (nur wenn Tabelle leer):
  //    - ~60% der Attacken: „Trigger“-Eintrag 2–20 h vor dem Start
  //      (sichergestellt, dass das 24-h-Fenster getroffen wird)
  //    - ~50% aller weiteren Tage: 1–2 Zufalls-Einträge (Normal-Kategorien)
  //    Läuft auch bei vorhandenen Attacken (z. B. zweiter Seed-Versuch
  //    nach Datenlöschung) – Bedingung ist foodEntries.count() === 0.
  // ------------------------------------------------------------------
  if ((await db.foodEntries.count()) === 0) {
    const seededAttacks = await db.attacks.toArray();

    // a) Trigger-Einträge vor ~60% der Attacken.
    const daysWithEntry = new Set<string>();
    for (const a of seededAttacks) {
      if (!chance(0.6)) continue;
      const start = new Date(a.startTime);
      const t = new Date(start.getTime() - randInt(2, 20) * 3_600_000);
      const cat = pick(TRIGGER_CATEGORIES);
      const names = FOOD_POOL[cat] ?? [];
      await db.foodEntries.add({
        date: toDateOnly(t),
        time: toLocalISO(t).slice(11), // 'HH:mm'
        name: names.length > 0 ? pick(names) : cat,
        category: cat,
        quantity: chance(0.3) ? `${randInt(1, 3)} Portion(en)` : '',
        notes: '',
        createdAt: nowIso,
      });
      daysWithEntry.add(toDateOnly(t));
      result.foodEntriesAdded += 1;
    }

    // b) ~50% aller Tage der letzten 3 Monate mit 1–2 Zufalls-Einträgen.
    for (let d = 89; d >= 0; d--) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
      const dayOnly = toDateOnly(day);
      if (daysWithEntry.has(dayOnly) || !chance(0.5)) continue;
      const count = randInt(1, 2);
      for (let k = 0; k < count; k++) {
        const cat = pick(NORMAL_CATEGORIES);
        const names = FOOD_POOL[cat] ?? [];
        const t = new Date(
          day.getFullYear(),
          day.getMonth(),
          day.getDate(),
          randInt(8, 21),
          randInt(0, 59),
        );
        await db.foodEntries.add({
          date: dayOnly,
          time: toLocalISO(t).slice(11),
          name: names.length > 0 ? pick(names) : cat,
          category: cat,
          quantity: '',
          notes: '',
          createdAt: nowIso,
        });
        result.foodEntriesAdded += 1;
      }
    }
  }

  console.info('[seedMockData] Ergebnis:', result);
  return result;
}
