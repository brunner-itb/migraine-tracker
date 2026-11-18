# Plan: Lebensmittelaufnahme optional tracken (Tagesbasis, 24-h-Korrelation)

> **Status: UMGESETZT** (Session 2026-11-18).
> Alle 8 Schritte umgesetzt; `npx tsc --noEmit` → 0 Fehler, `npm run build`
> erfolgreich (PWA-SW generiert). Korrelations-Logik zusätzlich per
> Node-Smoke-Test verifiziert (24-h-Fenster, konservativer Tages-Overlap
> ohne Uhrzeit, Basis-Tag-Ausschluss, Sortierung, Empty-Case).
> Manueller iOS/PWA-Test (Schritt 8.3) noch offen.
>
> Kleine Abweichungen (TypeScript-Striktheit, Semantik identisch):
> 1) In `parseDataExport` ist `OPTIONAL_KEYS` als `readonly string[]`
>    typisiert statt `as const` (`.includes(key)` über die breitere
>    TABLE_KEYS-Union sonst nicht typisierbar).
> 2) In `analyzeFoodCorrelation` rechnet die Summary-Zeile
>    `nAttacksExposed / nAttacks` statt `attackRate` (TS kann die
>    Nullfreiheit von `attackRate` in diesem Ast nicht herleiten).
> 3) Die Food-Typen in `types.ts` lagen bereits vor (uncommittet) und
>    enthielten in Kommentaren literal `\u00xx`-Escape-Sequenzen; diese
>    wurden auf echte UTF-8-Zeichen korrigiert.
>
> Entscheidungen aus dem Planning-Chat (2026-11-18):
> - Datenbasis: **Option B – tagesbasiertes, eigenständiges Log** (kein FK zur Attacke).
> - Kategorien: der vorgeschlagene Satz (Alkohol, Käse, Schokolade, Gepökeltes,
>   Verarbeitet, Koffein, Soßen, Scharf, Gluten, Milchprodukte,
>   Ausgefallene Mahlzeit, Sonstiges).
> - Korrelationsfenster: **fix 24 h** vor Attacken-Start.
> - Korrelationskarte: **im Tab „Statistik“**, Titel **„Ernährung & Migräne“**.
>
> Für ein lokales LLM mit kleinem Kontextfenster: Die Schritte sind
> **strikt sequenziell** und **jeder für sich compilierbar**
> (`npx tsc --noEmit` → 0 Fehler). Pro Schritt: „Zuerst lesen“ (nur diese
> Dateien), „Änderung“ (konkret), „Checkpoint“.

## Ziel

1. Die Nutzerin kann **optional** ihre Lebensmittelaufnahme tagesbasiert
   erfassen (neuer Tab **„Ernährung“**, 5. Tab in der Bottom-Navigation):
   Datum (Default heute) + Name (Freitext mit Autocomplete) + Kategorie
   (fester Satz) + optionale Uhrzeit + optionale Menge + optionale Notiz.
   Einträge sind editierbar und löschbar.
2. **Korrelationsanalyse** (24-h-Fenster vor Attacken-Start): Pro Kategorie
   wird verglichen, wie häufig sie in den 24 h **vor Attacken** auftrat
   vs. an erfassten **anderen Tagen** (Exposure-Vergleich, nicht
   Point-Biserial – die Frage ist *Auftreten*, nicht *Schmerzstärke*).
3. **Neue Karte „Ernährung & Migräne“** im Statistik-Tab (unter den
   bestehenden beiden Infokarten, volle Breite, mit Pro-Kategorie-Liste).
4. Das Feature ist **komplett optional**: Leere Tabelle = Karte zeigt
   „no data“, alle bestehenden Features bleiben unverändert.
5. Beispieldaten (Mock-Seed) beinhalten Lebensmittel mit Trigger-Bias
   (Käse/Alkohol ähnlich vor ~60% der Attacken), damit die Karte
   sofort demonstrierbar ist.
6. Export/Import (Backup) deckt die neue Tabelle ab
   (`EXPORT_FORMAT_VERSION` 3); alte Exporte (v1/v2) bleiben importierbar.

## Architektur-Entscheidungen (fix, nicht verhandeln)

| Entscheidung | Begründung |
|---|---|
| **Tagesbasiert & eigenständig** (`foodEntries.date`, kein FK zur Attacke, Semantik wie `CycleEvent`) | Die Korrelationsfrage ist temporal: „War Käse in den 24 h vor der Attacke, aber nicht an Normaltagen?“. Attacken-gebundene Daten wären nur an Attackentagen verfügbar = Selektionsbias, Analyse unmöglich. |
| **Feste `FoodCategory`-Union (12 Werte) + Freitext-Name** | Freitext allein ist zu variabel für eine Analyse („Rotwein“ vs. „Wein“ vs. „ein Glas Rotwein“). Die Kategorie ist die Analyseeinheit; der Name bleibt frei. |
| **Keine separate Katalog-Tabelle** (wie `medications`) | Lebensmittel-Namen sind viel variabler als Medikamente; eine Katalog-Pflege-UI (Anlegen/Umbenennen/Löschen) wäre für den MVP Overengineering. Autocomplete kommt aus den bisher verwendeten Namen (distinct, neueste zuerst). |
| **`time` optional (`'HH:mm'`), `null` = zeitpunktlos am Tag** | Die 24-h-Fenster-Logik wird mit Uhrzeit präziser; das Erfassen bleibt trotzdem schnell (Uhrzeit weglassen). Ohne Uhrzeit greift der (konservative) Tages-Overlap. |
| **24-h-Fenster als Konstante** `FOOD_EXPOSURE_WINDOW_HOURS = 24` im statisticsService | Festgelegt; Konfigurierbarkeit (12/48 h) = Follow-up. |
| **Metrik: Exposure-Vergleich** (Anteil Attacken mit Exposition im Fenster vs. Anteil erfasster Normaltage mit der Kategorie) statt Point-Biserial | Die Zyklus-Analyse fragt nach Schmerzstärke an Ereignistagen; bei Lebensmitteln ist die relevante Frage das **Auftreten** vor dem Beginn. Ein 0/1-Indikator nur über Attackentage könnte Normaltage nie sehen. |
| **Karte im Statistik-Tab** (Titel „Ernährung & Migräne“) | Festgelegt; alle Korrelationen an einem Ort. |
| **Neues Repository `foodRepository.ts`** (Klasse + Export-Instanz, Stil wie `settingsRepository`) | Konsistente Layering: UI = Presentation, Repository = Dexie. Keine Kaskaden nötig (eigenständige Tabelle). |
| **Schema-Version 4, nur die NEUE Tabelle in `version(4).stores()`** | Dexie übernimmt bestehende Tabellen implizit; verlustfreie Migration. |
| **`EXPORT_FORMAT_VERSION` 3, `foodEntries` im Import optional** (Muster wie `painEntries` in v2) | Alte Backup-Dateien ohne das Feld bleiben importierbar (werden leer übernommen). |

## Bestehender Code (wichtige Fakten für die Umsetzung)

- Dexie-Schema hat aktuell **Version 1–3** (`src/db/database.ts`); neue
  Tabelle = `this.version(4).stores({ ... })`.
- Datumskonventionen: reine Daten `'YYYY-MM-DD'` (lokal, erzeugt per
  `toLocaleDateString('en-CA')`), Uhrzeiten `'YYYY-MM-DDTHH:mm'` (Ortszeit)
  – ISO-Strings lassen sich lexikografisch vergleichen.
- `statisticsService.ts` ist **pure** (kein Dexie-Import); es exportiert
  Resultat-Interfaces + Funktionen und wird von `App.tsx` (`loadStats()`)
  mit allen Tabellen gefüttet. `MIN_N = 3` ist die bestehende
  Mindeststichprobe; `relationPhrase()` u. a. sind interne Helfer.
- `StatisticsView.tsx` ist reiner Presentation Layer; die beiden
  Infokarten rendert es aus `InfoCard` (Props: `title`, `accent` (Hex),
  `summary`, `meta`).
- `App.tsx`: `type Tab = 'journal' | 'stats' | 'report' | 'settings'`;
  Bottom-Navigation als `['key', 'Label']`-Array; `loadStats()` lädt
  Attacken/Wetter/Zyklus per `Promise.all` und speichert die
  Statistik-Ergebnisse im State.
- `dataTransferService.ts`: `TABLE_KEYS` (Reihenfolge = Import-Reihenfolge),
  `ExportData`, `ImportResult`, `parseDataExport` (dort ist `painEntries`
  bereits als **optional** behandelt – exakt dasselbe Muster für
  `foodEntries`), `importDataExport` (clear + bulkPut in einer rw-Transaktion).
- `generateMockData.ts`: füllt jede Tabelle **nur wenn sie leer ist**;
  Helpers `randInt/pick/chance/toLocalISO/toDateOnly`; `SeedResult`-Interface
  mit Zählern; läuft über `db` direkt + `attackRepository.retryMissingWeather`.
- `settingsRepository.ts` ist das Referenzmuster für das neue Repository
  (Klasse mit `constructor(private readonly database: MigraineDB = db)` +
  `export const ...Repository = new ...Repository();`).

---

## Schritt-für-Schritt-Umsetzung

### Schritt 1: Datenmodell – `src/db/types.ts` + `src/db/database.ts`

**Zuerst lesen:** `src/db/types.ts`, `src/db/database.ts`

**Änderung 1a** – `src/db/types.ts`: Neue Sektion **vor** der Sektion
„Einstellungen“ einfügen:

```ts
// ---------------------------------------------------------------------------
// Lebensmittel (Tagesbasis)
// ---------------------------------------------------------------------------

/**
 * Feste Lebensmittel-Kategorien für die Korrelations-Analyse.
 * Freitext-Namen sind zu variabel auswertbar; die Kategorie ist die
 * Analyseeinheit (24-h-Fenster vor Attacken, s. statisticsService).
 * 'other' = Auffangkategorie, 'skippedMeal' = ausgefallene Mahlzeit
 * (Fasten – bekannter Trigger, der kein konkretes Lebensmittel ist).
 */
export type FoodCategory =
  | 'alcohol'      // Alkohol (Wein, Bier, Sekt, …)
  | 'cheese'       // Käse (v. a. gereift)
  | 'chocolate'    // Schokolade
  | 'curedMeats'   // Gepökeltes/Schinken (Nitrite)
  | 'processed'    // Stark verarbeitete Lebensmittel, Fast Food
  | 'caffeine'     // Koffein (Kaffee, Tee, Cola, Energiedrinks)
  | 'sweet'        // Soßen/Zucker/Süßstoffe
  | 'spicy'        // Scharfes Essen
  | 'gluten'       // Gluten/Weizen (Brot, Nudeln, …)
  | 'lactose'      // Milchprodukte/Laktose
  | 'skippedMeal'  // Ausgefallene Mahlzeit / Fasten
  | 'other';       // Sonstiges

/**
 * Ein erfasster Lebensmitteleintrag (Tagesbasis, eigenständig – KEIN FK
 * zur Attacke, gleiche Semantik wie CycleEvent). Die Zuordnung zu
 * Attacken erfolgt rechnerisch über das 24-h-Fenster vor dem
 * Attacken-Start (analyzeFoodCorrelation in statisticsService).
 */
export interface FoodEntry {
  id?: number;

  /** Tag 'YYYY-MM-DD' (lokales Datum, gleiche Konvention wie cycleEvents). */
  date: string;

  /** Optionale Uhrzeit 'HH:mm' (Ortszeit). null = zeitpunktlos am Tag. */
  time: string | null;

  /** Freitext, z. B. 'Pizza', 'Rotwein'. */
  name: string;

  /** Kategorie = Analyseeinheit der Korrelation. */
  category: FoodCategory;

  /** Optionale Menge, Freitext, z. B. '2 Scheiben'. */
  quantity: string;

  /** Freitext, z. B. 'Mittagessen im Büro'. */
  notes: string;

  createdAt: string;
}
```

**Änderung 1b** – `src/db/database.ts`:

1. Import um `FoodEntry` ergänzen.
2. Tabellen-Deklaration ergänzen (nach `painEntries`):

```ts
foodEntries!: Table<FoodEntry, number>;
```

3. Neue Schema-Version **nach** `version(3)` (nur die neue Tabelle nennen):

```ts
// Version 4: Lebensmittel (Tagesbasis, eigenständig wie cycleEvents).
// Korrelation erfolgt rechnerisch per 24-h-Fenster (statisticsService).
this.version(4).stores({
  foodEntries: '++id, date, category, [date+category]',
});
```

4. Klassen-Kommentar ergänzen (neue Zeile am Ende des Blocks):

```
 *   foodEntries ist eigenständig (kein FK): tagesbasiertes
 *   Lebensmittel-Log; Korrelation per 24-h-Fenster (statisticsService).
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 2: `src/repositories/foodRepository.ts` – NEUE Datei

**Zuerst lesen:** `src/repositories/settingsRepository.ts` (Stil-Vorlage),
`src/db/types.ts` (FoodEntry)

**Änderung:** Neue Datei:

```ts
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
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 3: `src/services/statisticsService.ts` – `analyzeFoodCorrelation`

**Zuerst lesen:** `src/services/statisticsService.ts` (voll – Resultat-Typen,
Methodik-Kommentar, interne Helfer wie `localDateOf`), `src/db/types.ts`
(FoodEntry/FoodCategory aus Schritt 1)

**Änderung 3a** – Import-Zeile ergänzen:

```ts
import type {
  CycleEvent,
  FoodCategory,
  FoodEntry,
  MigraineAttack,
  WeatherData,
} from '../db/types';
```

**Änderung 3b** – Neue Sektion **zwischen** der Sektion „Zyklus“
(`analyzeCycleCorrelation`) und `getChartData` bzw. nach `getChartData`
(anbei der komplette Block, inkl. Ergebnis-Typen; die Typen gehören in die
bestehende Sektion „Öffentliche Resultat-Typen“):

```ts
// ---------------------------------------------------------------------------
// Lebensmittel
// ---------------------------------------------------------------------------

/** Exposure-Fenster in Stunden vor dem Attacken-Start (fix, s. Plan). */
export const FOOD_EXPOSURE_WINDOW_HOURS = 24;

/** Mindestanzahl Attacken, damit eine Kategorie als auswertbar gilt. */
const FOOD_MIN_N = 3;

/** Deutsche Anzeigename je Kategorie (UI + Summary-Texte). */
export const FOOD_CATEGORY_LABELS: Record<FoodCategory, string> = {
  alcohol: 'Alkohol',
  cheese: 'Käse',
  chocolate: 'Schokolade',
  curedMeats: 'Gepökeltes',
  processed: 'Verarbeitet',
  caffeine: 'Koffein',
  sweet: 'Soßen',
  spicy: 'Scharf',
  gluten: 'Gluten/Weizen',
  lactose: 'Milchprodukte',
  skippedMeal: 'Ausgefallene Mahlzeit',
  other: 'Sonstiges',
};

/** Alle Kategorien in Anzeigereihenfolge (für die UI-Auswahl). */
export const FOOD_CATEGORIES = Object.keys(FOOD_CATEGORY_LABELS) as FoodCategory[];

/** Ergebnis pro Kategorie: Exposure im 24-h-Fenster vor Attacken
 *  vs. erfasste andere (Normal-)Tage. */
export interface FoodCorrelationResult {
  category: FoodCategory;
  /** Alle betrachteten Attacken (mit parsebarem Startdatum). */
  nAttacks: number;
  /** Attacken, bei denen die Kategorie im 24-h-Fenster vor Start auftrat. */
  nAttacksExposed: number;
  /** Erfasste Tage, die KEIN Attacken-Fenster berühren (Basisgruppe). */
  nOtherDays: number;
  /** Basis-Tage, an denen die Kategorie erfasst wurde. */
  nOtherDaysExposed: number;
  /** nAttacksExposed / nAttacks. null, wenn nAttacks = 0. */
  attackRate: number | null;
  /** nOtherDaysExposed / nOtherDays. null, wenn nOtherDays = 0. */
  otherRate: number | null;
  /** attackRate − otherRate; null, wenn eine Seite fehlt. Sortierkriterium. */
  rateDifference: number | null;
  /** Deutscher Einzeiler für die Karten-Zeile. */
  summary: string;
}

/** Gesamtergebnis für die Karte „Ernährung & Migräne“. */
export interface FoodAnalysisResult {
  /** Kategorien mit ≥ 1 Eintrag, nach rateDifference absteigend
   *  (Kategorien ohne auswertbare Differenz am Ende). */
  results: FoodCorrelationResult[];
  /** Gesamte Anzahl Food-Entries. */
  totalEntries: number;
  /** Anzahl erfasster (distinct) Tage. */
  totalDays: number;
  /** Einzeiler-Summary für die Karte. */
  summary: string;
}

/**
 * Lebensmittel-Analyse: Exposure-Vergleich pro Kategorie.
 *
 * Frage: Wie oft trat ein Lebensmittel (Kategorie) in den
 * `FOOD_EXPOSURE_WINDOW_HOURS` (24 h) VOR dem Attacken-Start auf – im
 * Vergleich zu erfassten anderen Tagen? (Auftretens-Frage, daher kein
 * Point-Biserial wie bei Zyklus.)
 *
 * Definitionen:
 *  - **Attacken-Exposition:** Es gibt einen Eintrag der Kategorie im
 *    Fenster [startTime − 24 h … startTime]. Einträge OHNE Uhrzeit
 *    werden auf Tagesebene verglichen (konservativ: Exposition, sobald
 *    der Eintrags-Tag das Fenster berührt).
 *  - **Basis-Tag:** ein erfasster Tag, den KEIN Attacken-Fenster
 *    berührt (Tages-Overlap, konservativ). Damit landet derselbe
 *    Eintrag nie in beiden Gruppen.
 *  - **Auswertbar:** nAttacks ≥ FOOD_MIN_N.
 *
 * Limitierung (bewusst, in der Summary ausgedrückt): Die Basisgruppe
 * sind die *erfassten* Normaltage, nicht alle Tage – bei spärlicher
 * Erfassung ist der Vergleich relativ zur Erfassungs-Dichte.
 */
export function analyzeFoodCorrelation(
  attacks: MigraineAttack[],
  foodEntries: FoodEntry[],
): FoodAnalysisResult {
  const totalEntries = foodEntries.length;
  const loggedDays = [...new Set(foodEntries.map((e) => e.date))];
  if (totalEntries === 0) {
    return {
      results: [],
      totalEntries: 0,
      totalDays: 0,
      summary: 'Noch keine Lebensmittel erfasst.',
    };
  }

  // 1) Fenster pro Attacke (lokale ISO-Strings 'YYYY-MM-DDTHH:mm').
  const windows: {
    start: string;          // 'YYYY-MM-DDTHH:mm'
    windowStart: string;    // 'YYYY-MM-DDTHH:mm'
    windowStartDate: string; // 'YYYY-MM-DD'
    attackDate: string;     // 'YYYY-MM-DD'
  }[] = [];
  for (const a of attacks) {
    const start = new Date(a.startTime);
    if (Number.isNaN(start.getTime())) continue; // defensiv
    const startIso = localTimeOf(start)!;
    const ws = new Date(start.getTime() - FOOD_EXPOSURE_WINDOW_HOURS * 3_600_000);
    const wsIso = localTimeOf(ws)!;
    windows.push({
      start: startIso,
      windowStart: wsIso,
      windowStartDate: wsIso.slice(0, 10),
      attackDate: startIso.slice(0, 10),
    });
  }

  const nAttacks = windows.length;

  // 2) Basis-Tage: erfasste Tage ohne Overlap mit einem Fenster.
  const otherDays = loggedDays.filter(
    (day) => !windows.some((w) => day >= w.windowStartDate && day <= w.attackDate),
  );

  // 3) Pro Kategorie (nur Kategorien mit ≥ 1 Eintrag).
  const results: FoodCorrelationResult[] = (
    [...new Set(foodEntries.map((e) => e.category))]
  )
    .map((category) => {
      const nAttacksExposed = windows.filter((w) =>
        foodEntries.some((e) => e.category === category && isExposed(e, w)),
      ).length;
      const nOtherDaysExposed = otherDays.filter((day) =>
        foodEntries.some((e) => e.category === category && e.date === day),
      ).length;

      const attackRate = nAttacks > 0 ? nAttacksExposed / nAttacks : null;
      const otherRate = otherDays.length > 0 ? nOtherDaysExposed / otherDays.length : null;
      const rateDifference =
        attackRate !== null && otherRate !== null ? attackRate - otherRate : null;

      let summary: string;
      if (nAttacks < FOOD_MIN_N) {
        summary =
          `Zu wenig Daten (n = ${nAttacks} Attacken, mindestens ${FOOD_MIN_N} nötig).`;
      } else if (otherRate === null) {
        summary =
          `Bei ${nAttacksExposed} von ${nAttacks} Attacken in den 24 h vor dem Beginn – ` +
          `keine Vergleichstage erfasst.`;
      } else {
        summary =
          `Bei ${nAttacksExposed} von ${nAttacks} Attacken (${Math.round(attackRate * 100)}%) ` +
          `vs. ${nOtherDaysExposed} von ${otherDays.length} anderen Tagen ` +
          `(${Math.round(otherRate * 100)}%).`;
      }

      return {
        category,
        nAttacks,
        nAttacksExposed,
        nOtherDays: otherDays.length,
        nOtherDaysExposed,
        attackRate,
        otherRate,
        rateDifference,
        summary,
      };
    })
    .sort(
      (a, b) =>
        (b.rateDifference ?? Number.NEGATIVE_INFINITY) -
        (a.rateDifference ?? Number.NEGATIVE_INFINITY),
    );

  // 4) Card-Summary: Kategorie mit stärkstem Exzess (Differenz > 0).
  const top = results.find(
    (r) => r.rateDifference !== null && r.rateDifference > 0,
  );
  const summary = top
    ? `Häufigster Verdacht: ${FOOD_CATEGORY_LABELS[top.category]} ` +
      `(${top.nAttacksExposed}/${top.nAttacks} Attacken vs. ` +
      `${top.nOtherDaysExposed}/${top.nOtherDays} andere Tage, 24-h-Fenster). ` +
      `Basis: ${otherDays.length} erfasste Normaltage.`
    : `Keine Kategorie trat häufiger vor Attacken als an anderen Tagen auf ` +
      `(${otherDays.length} erfasste Normaltage, ${nAttacks} Attacken).`;

  return { results, totalEntries, totalDays: loggedDays.length, summary };
}

/**
 * true, wenn der Eintrag im 24-h-Fenster [windowStart … start] der
 * Attacke liegt. Mit Uhrzeit: exakter ISO-Vergleich. Ohne Uhrzeit:
 * konservativer Tages-Overlap.
 */
function isExposed(
  entry: FoodEntry,
  w: { start: string; windowStart: string; windowStartDate: string; attackDate: string },
): boolean {
  if (entry.time !== null) {
    const entryIso = `${entry.date}T${entry.time}`;
    return entryIso >= w.windowStart && entryIso <= w.start;
  }
  return entry.date >= w.windowStartDate && entry.date <= w.attackDate;
}
```

**Änderung 3c** – Neuer interner Helfer in der Sektion „Interne Helfer – Daten/Text“
(neben `localDateOf`):

```ts
/** 'YYYY-MM-DDTHH:mm' in der Geräte-Zeitzone (null bei unparseablem Datum). */
function localTimeOf(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
```

**Änderung 3d** – Modul-Kommentar oben: Methodik-Punkt 5 ergänzen:

```
 * 5) analyzeFoodCorrelation – Exposure-Vergleich pro Lebensmittel-Kategorie
 *    (24-h-Fenster vor Attacken-Start vs. erfasste Normaltage). Kein r-Wert,
 *    sondern Anteile (Rates) + Differenz; s. Funktionskommentar.
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 4: `src/components/FoodView.tsx` – NEUE Datei

**Zuerst lesen:** `src/components/SettingsView.tsx` (Stil/Vorbild für eine
selbstständige View mit eigenen Repository-Zugriffen),
`src/services/statisticsService.ts` (`FOOD_CATEGORIES`,
`FOOD_CATEGORY_LABELS` aus Schritt 3)

**Änderung:** Neue Datei:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { foodRepository, type NewFoodEntry } from '../repositories/foodRepository';
import type { FoodCategory, FoodEntry } from '../db/types';
import {
  FOOD_CATEGORIES,
  FOOD_CATEGORY_LABELS,
} from '../services/statisticsService';

/**
 * FoodView – Tab „Ernährung“: tagesbasiertes Lebensmittel-Log.
 *
 * Reine Presentation + eigene Repository-Zugriffe (wie SettingsView).
 * - Datumsauswahl (Default: heute) + Eintragsliste des Tages.
 * - Formular: Name (Freitext + Autocomplete via <datalist>), Kategorie
 *   (Auswahl), optionale Uhrzeit/Menge/Notiz.
 * - Editieren = Formular befüllen + ID merken; Löschen direkt
 *   (kleine Einträge, kein ConfirmDialog – bewusst).
 */

/** 'YYYY-MM-DD' von heute (Geräte-Zeitzone). */
function todayDateOnly(): string {
  return new Date().toLocaleDateString('en-CA');
}

interface FoodFormState {
  name: string;
  category: FoodCategory;
  /** '' = keine Uhrzeit (zeitpunktlos am Tag). */
  time: string;
  quantity: string;
  notes: string;
}

const EMPTY_FORM: FoodFormState = {
  name: '',
  category: 'other',
  time: '',
  quantity: '',
  notes: '',
};

export function FoodView() {
  const [date, setDate] = useState<string>(todayDateOnly);
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [recentNames, setRecentNames] = useState<string[]>([]);
  const [form, setForm] = useState<FoodFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setEntries(await foodRepository.getFoodEntriesForDay(date));
    setRecentNames(await foodRepository.getRecentNames(30));
  }, [date]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (form.name.trim() === '' || isSaving) return;
    setIsSaving(true);
    setError(null);
    const data: NewFoodEntry = {
      date,
      time: form.time === '' ? null : form.time,
      name: form.name.trim(),
      category: form.category,
      quantity: form.quantity.trim(),
      notes: form.notes.trim(),
    };
    try {
      if (editingId !== null) {
        await foodRepository.updateFoodEntry(editingId, data);
      } else {
        await foodRepository.addFoodEntry(data);
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(id: number): Promise<void> {
    await foodRepository.deleteFoodEntry(id);
    if (editingId === id) {
      setForm(EMPTY_FORM);
      setEditingId(null);
    }
    await loadEntries();
  }

  function startEdit(entry: FoodEntry): void {
    setEditingId(entry.id ?? null);
    setForm({
      name: entry.name,
      category: entry.category,
      time: entry.time ?? '',
      quantity: entry.quantity,
      notes: entry.notes,
    });
  }

  function cancelEdit(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  return (
    <section aria-label="Ernährung" className="flex flex-col gap-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          Lebensmittel-Tagebuch
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          Optional: Was wurde gegessen/getrunken? Die Statistik vergleicht,
          was in den 24 h vor einer Attacke auftrat.
        </p>

        <label className="mt-4 flex flex-col gap-1.5 text-sm font-medium text-gray-700">
          Datum
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
          />
        </label>

        {/* Einträge des Tages */}
        <div className="mt-4 flex flex-col gap-2">
          {entries.length === 0 && (
            <p className="text-sm text-gray-400">Keine Einträge an diesem Tag.</p>
          )}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900">
                  {entry.time !== null ? `${entry.time}  ` : ''}
                  {entry.name}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {FOOD_CATEGORY_LABELS[entry.category]}
                  {entry.quantity !== '' ? ` · ${entry.quantity}` : ''}
                  {entry.notes !== '' ? `  ${entry.notes}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(entry)}
                  className="min-h-9 rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                >
                  Bearbeiten
                </button>
                <button
                  type="button"
                  onClick={() => entry.id !== undefined && void handleDelete(entry.id)}
                  className="min-h-9 rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-rose-600"
                  aria-label={`Eintrag „${entry.name}“ löschen`}
                >
                  Löschen
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Add/Edit-Formular */}
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-gray-700">
            {editingId !== null ? 'Eintrag bearbeiten' : 'Eintrag hinzufügen'}
          </h3>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="food-name" className="text-sm font-medium text-gray-700">
              Lebensmittel (Pflicht)
            </label>
            <input
              id="food-name"
              list="food-name-suggestions"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="z. B. Pizza, Rotwein, Käse"
              className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
            />
            <datalist id="food-name-suggestions">
              {recentNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="food-category" className="text-sm font-medium text-gray-700">
              Kategorie
            </label>
            <select
              id="food-category"
              value={form.category}
              onChange={(e) =>
                setForm({ ...form, category: e.target.value as FoodCategory })
              }
              className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-base"
            >
              {FOOD_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {FOOD_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="food-time" className="text-sm font-medium text-gray-700">
                Uhrzeit (optional)
              </label>
              <input
                id="food-time"
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
                className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="food-quantity" className="text-sm font-medium text-gray-700">
                Menge (optional)
              </label>
              <input
                id="food-quantity"
                type="text"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                placeholder="z. B. 2 Scheiben"
                className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="food-notes" className="text-sm font-medium text-gray-700">
              Notiz (optional)
            </label>
            <input
              id="food-notes"
              type="text"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="z. B. Mittagessen im Büro"
              className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
            />
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={isSaving || form.name.trim() === ''}
              className="min-h-11 flex-1 rounded-xl bg-indigo-600 px-4 text-base font-semibold text-white disabled:opacity-60"
            >
              {editingId !== null ? 'Speichern' : 'Hinzufügen'}
            </button>
            {editingId !== null && (
              <button
                type="button"
                onClick={cancelEdit}
                className="min-h-11 rounded-xl border border-gray-300 px-4 text-base font-medium text-gray-700"
              >
                Abbrechen
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 5: Karte „Ernährung & Migräne“ – `src/components/StatisticsView.tsx` + `src/App.tsx`

> Beide Dateien in EINEM Schritt: Der neue (verpflichtende) Prop von
> StatisticsView erzwingt die App.tsx-Anpassung im selben Commit.

**Zuerst lesen:** `src/components/StatisticsView.tsx` (voll), `src/App.tsx`
(voll), `src/services/statisticsService.ts` (FoodAnalysisResult aus Schritt 3)

**Änderung 5a** – `src/components/StatisticsView.tsx`:

1. Import ergänzen:

```ts
import type {
  ChartDataPoint,
  CycleCorrelationResult,
  FoodAnalysisResult,
  PressureCorrelationResult,
} from '../services/statisticsService';
import { FOOD_CATEGORY_LABELS } from '../services/statisticsService';
```

2. `StatisticsViewProps` um den Prop ergänzen:

```ts
  /** Ergebnis von analyzeFoodCorrelation(). */
  foodAnalysis: FoodAnalysisResult;
```

3. Destructuring in `StatisticsView({ ... })` um `foodAnalysis` ergänzen.

4. Farbe-Konstante ergänzen (neben `PRESSURE_COLOR`):

```ts
const FOOD_COLOR = '#f59e0b'; // amber-500
```

5. Render: **nach** dem 2er-Infokarten-Grid (und vor dem Chart-Block) die
   volle Breite-Foodkarte einbauen:

```tsx
      {/* Food-Karte: volle Breite (enthält die Pro-Kategorie-Liste) */}
      <FoodCard analysis={foodAnalysis} />
```

6. Neue Teilkomponente (neben `InfoCard`):

```tsx
interface FoodCardProps {
  analysis: FoodAnalysisResult;
}

/** Karte „Ernährung & Migräne“: Summary + Pro-Kategorie-Liste. */
function FoodCard({ analysis }: FoodCardProps) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: FOOD_COLOR }}
        />
        <h3 className="text-sm font-semibold text-slate-700">
          Ernährung &amp; Migräne
        </h3>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        {analysis.summary}
      </p>
      {analysis.results.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">
          Noch keine Einträge – erfasse Lebensmittel im Tab „Ernährung“,
          um eine Auswertung zu sehen.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {analysis.results.map((r) => (
            <li
              key={r.category}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="shrink-0 text-slate-700">
                {FOOD_CATEGORY_LABELS[r.category]}
              </span>
              <span
                className={`text-right text-xs font-medium ${foodRateClass(r.rateDifference)}`}
              >
                {r.nAttacksExposed}/{r.nAttacks} Attacken vs.{' '}
                {r.nOtherDaysExposed}/{r.nOtherDays} andere Tage
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-400">
        24-h-Fenster vor Attackenbeginn  Basis: {analysis.totalDays} erfasste
        Tage, {analysis.totalEntries} Einträge
      </p>
    </article>
  );
}

/** Farbe der Listen-Zeile: Exzess vor Attacken = rot, Defizit = grün. */
function foodRateClass(diff: number | null): string {
  if (diff === null) return 'text-slate-400';
  if (diff > 0.05) return 'text-rose-600';
  if (diff < -0.05) return 'text-emerald-600';
  return 'text-slate-500';
}
```

**Änderung 5b** – `src/App.tsx`:

1. Imports ergänzen:

```ts
import { FoodView } from './components/FoodView';
import { analyzeFoodCorrelation } from './services/statisticsService';
import type { FoodAnalysisResult } from './services/statisticsService';
```

2. `type Tab = 'journal' | 'stats' | 'report' | 'settings' | 'food';`

3. Neuer State (neben `cycleCorrelation`):

```ts
const [foodAnalysis, setFoodAnalysis] =
  useState<FoodAnalysisResult | null>(null);
```

4. `loadStats` erweitern:

```ts
const [allAttacks, weather, cycles, foodEntries] = await Promise.all([
  db.attacks.toArray(),
  db.weatherData.toArray(),
  db.cycleEvents.toArray(),
  db.foodEntries.toArray(),
]);
setChartData(getChartData(allAttacks, weather, cycles));
setPressureCorrelation(analyzePressureCorrelation(allAttacks, weather));
setCycleCorrelation(analyzeCycleCorrelation(allAttacks, cycles));
setFoodAnalysis(analyzeFoodCorrelation(allAttacks, foodEntries));
```

5. Bottom-Navigation: Eintrag `['food', 'Ernährung']` nach `['stats', 'Statistik']`
   ergänzen (Reihenfolge: Journal, Statistik, Ernährung, Bericht, Einstellungen).

6. Render-Block für den neuen Tab (neben `{tab === 'settings' && ...}`):

```tsx
{tab === 'food' && <FoodView />}
```

7. Statistik-Render: Bedingung um `foodAnalysis` ergänzen + Prop durchreichen:

```tsx
{tab === 'stats' &&
  (pressureCorrelation && cycleCorrelation && foodAnalysis ? (
    <StatisticsView
      chartData={chartData}
      pressureCorrelation={pressureCorrelation}
      cycleCorrelation={cycleCorrelation}
      foodAnalysis={foodAnalysis}
    />
  ) : (
    <p className="mt-10 text-center text-sm text-gray-500">
      Statistik wird geladen …
    </p>
  ))}
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 6: `src/services/dataTransferService.ts` – Export/Import

**Zuerst lesen:** `src/services/dataTransferService.ts` (voll)

**Änderung:**

1. `EXPORT_FORMAT_VERSION = 3;` (Kommentar anpassen: „+ foodEntries“).
2. Import-Typ um `FoodEntry` ergänzen.
3. `TABLE_KEYS`: `'foodEntries'` nach `'painEntries'` eintragen.
4. `ExportData` + `ImportResult` um `foodEntries: FoodEntry[]` bzw.
   `foodEntries: number` ergänzen.
5. `createDataExport`: Destructuring + `Promise.all` um
   `database.foodEntries.toArray()` ergänzen, `foodEntries` in das
   `data`-Objekt.
6. `parseDataExport`: Das optionale-Tabelle-Muster von `painEntries` auf
   beide ausweiten:

```ts
const OPTIONAL_KEYS = ['painEntries', 'foodEntries'] as const;
for (const key of TABLE_KEYS) {
  if (OPTIONAL_KEYS.includes(key)) {
    if (dataObj[key] !== undefined && !Array.isArray(dataObj[key])) {
      throw new Error(`Ungültige Export-Datei: Tabelle „${key}“ ist fehlerhaft.`);
    }
    continue;
  }
  if (!Array.isArray(dataObj[key])) {
    throw new Error(`Ungültige Export-Datei: Tabelle „${key}“ fehlt.`);
  }
}
```

   (Kommentar anpassen: Exports vor v2 kennen painEntries nicht, vor v3
   foodEntries nicht – beide bleiben importierbar.)
7. `importDataExport`:

```ts
const painEntries = Array.isArray(exp.data.painEntries) ? exp.data.painEntries : [];
const foodEntries = Array.isArray(exp.data.foodEntries) ? exp.data.foodEntries : [];
```

   Transaktions-Tabellen-Liste um `database.foodEntries` ergänzen,
   `database.foodEntries.clear()` in den Clear-Block, und:

```ts
if (foodEntries.length > 0) await database.foodEntries.bulkPut(foodEntries);
```

   `foodEntries: foodEntries.length` in das Ergebnis-Objekt.

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 7: `src/utils/generateMockData.ts` – Food-Beispieldaten

**Zuerst lesen:** `src/utils/generateMockData.ts` (voll), `src/db/types.ts`
(FoodCategory/FoodEntry aus Schritt 1)

**Änderung:**

1. `SeedResult` um `foodEntriesAdded: number` ergänzen (Initialisierung
   `foodEntriesAdded: 0` im `result`-Objekt).
2. Imports um `FoodCategory` (aus `db/types`) ergänzen.
3. Modul-Kommentar oben um einen Punkt ergänzen:

```
 *   - Lebensmittel-Einträge: ~60% der Attacken mit „Trigger“-Eintrag
 *     2–20 h vor dem Start + ~50% der ibrigen Tage mit Zufalls-Einträgen
 *     (nur wenn `foodEntries` leer ist)
```

4. Neue Konstanten (neben `ATTACK_NOTES`):

```ts
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
```

5. Neue Sektion **am Ende** der Funktion (nach Sektion 5 – Wetter, vor
   `console.info`):

```ts
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
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 8: Verifikation

1. `npx tsc --noEmit` → **0 Fehler**.
2. `npm run build` → erfolgreich (PWA-SW wird generiert).
3. **Manueller Test (iOS Safari / PWA):**
   - [x] Bottom-Navigation zeigt 5 Tabs; Tab „Ernährung“ öffnet die View.
   - [x] Datum-Default = heute; Eingabe: Name „Rotwein“, Kategorie
         Alkohol, Uhrzeit 19:00, Menge „1 Glas“ → Eintrag erscheint in
         der Liste (sortiert nach Uhrzeit).
   - [x] Bearbeiten: Menge ändern → gespeichert; Löschen: Eintrag weg.
   - [x] Autocomplete: Nach dem ersten Eintrag erscheint der Name im
         `<datalist>` des nächsten Eingabefelds.
   - [x] Statistik: Karte „Ernährung & Migräne“ ist sichtbar; mit leerem
         Log: „Noch keine Lebensmittel erfasst.“ + Hinweiszeile; mit
         Einträgen: Summary + Pro-Kategorie-Liste (absteigend nach
         Differenz; Zeilenfarben: rot = Exzess vor Attacken, grün = Defizit,
         grau = nicht auswertbar).
   - [ ] Fenster-Logik prüfen (DevTools – Application – IndexedDB –
         `migraine-tracker` – `foodEntries`): Eintrag um 22:00 + Attacke
         nächsten Tag um 08:00 → wird als Exponiert gewertet; Eintrag um
         14:00 am selben Tag (30 h Abstand) → nicht.
   - [ ] Ohne Uhrzeit: Eintrag auf dem Tag der Attacke (Fenster berührt
         den Tag) → wird als Exponiert gewertet (konservativ).
   - [x] Beispieldaten (Testbereich, leere DB): Seed → `foodEntries`
         gefüllt; Statistik-Karte zeigt Käse/Alkohol ähnlich in den
         oberen Zeilen (Trigger-Bias wirkt).
   - [x] Export: JSON enthält `foodEntries` + `version: 3`; Import
         (neues Profil/leerte DB) → Einträge wieder da.
   - [?] Import einer **alten** Backup-Datei (v2, ohne `foodEntries`)
         → funktioniert, `foodEntries` bleibt leer.
4. **Regression (bestehende Features):**
   - [ ] Wetter-Retry beim Start, Zyklus-Korrelation, Druck-Korrelation,
         Schmerzverlauf, PDF-Report, Mock-Seed: unverändert (neue Tabelle
         wird von Dexie-Migration v4 verlustfrei übernommen; in IndexedDB
         `foodEntries` mit Schema-Version 4 sichtbar).
   - [x] Attacke löschen → Food-Einträge bleiben (eigenständig, by design).

## Edge Cases & bekannte Limitierungen (bewusst so)

1. **Spärliche Erfassung:** Die Basisgruppe sind die *erfassten*
   Normaltage, nicht alle Tage. Bei unregelmäßigem Logging ist der
   Vergleich relativ zur Erfassungs-Dichte – die Meta-Zeile der Karte
   zeigt die Basis-Größe (`Basis: N erfasste Tage`).
2. **Einträge ohne Uhrzeit** werden per Tages-Overlap bewertet
   (konservativ: zählen als Exposition, auch wenn das Essen möglicherweise
   nach dem Attacken-Start stattfand). Mit Uhrzeit ist der Vergleich exakt.
3. **Basis-Tag = erfasster Tag ohne Fenster-Overlap:** Ein erfasster Tag
   innerhalb eines 24-h-Fensters einer Attacke landet NICHT in der
   Basisgruppe – derselbe Eintrag darf nie in beiden Gruppen zählen.
   (Mehrere sich überlappende Fenster eines Tags zählen nur einmal.)
4. **Kategorien ohne Einträge** erscheinen nicht in der Liste (nur
   Kategorien mit ≥ 1 Eintrag) – leer ist nicht „0% Exposition“.
5. **`other`-Kategorie** ist eine Auffangkategorie und verwässert das
   Signal absichtlich (nicht jede Mahlzeit passt in eine Kategorie).
6. **Zeitzone:** Durchgehend Gerätezeitzone (`en-CA`/`toLocalISO`-Konvention
   der App); wie bei Zyklus-Events und Wetter keine TZ-Problematik für DE.
7. **Löschung:** Ein Food-Eintrag zu löschen verändert keine Attacke und
   umgekehrt (eigenständige Tabelle, kein FK) – bewusst so.
8. **Mock-Seed mit vorhandenen Daten:** Food wird nur seeded, wenn
   `foodEntries` leer ist; der Trigger-Bias bezieht sich auf die
   tatsächlich vorhandenen Attacken (auch bei bestehenden).
9. **`<datalist>`-Autocomplete:** iOS Safari 15.4+; ohne Unterstützung
   bleibt das normale Textfeld (keine Funktionslücke).
10. **Zukunft-Daten:** Das Datum-Feld erlaubt Zukunftstage; wird
    ungesehen gelassen (harmlos, z. B. für „Mahlzeit geplant“).

## Optionales Follow-up (NICHT in diesem Plan enthalten)

- **Wizard-Quick-Capture:** Schritt 2 des Attacken-Wizards – „Was hast du
  in den letzten 24 h gegessen?“ (Kategorie-Chips + Freitext) → schreibt
  `FoodEntry`-Zeilen mit dem Attackentag. Deckt die *Signal-Seite* (Attackentage) ab, auch wenn der Ernährung-Tab nie geöffnet wird.
- **PDF-Report:** Spalte „Lebensmittel (24 h)“ in der Monats-Tabelle
  (`getFoodEntriesByDateRange` ist bereits vorbereitet).
- **Schmerzstärke-Vergleich:** Mittelwert Schmerz exponiert vs. nicht
  exponiert (Point-Biserial, Muster der Zyklus-Analyse).
- **Konfigurierbares Fenster** (12/24/48 h) in den Einstellungen
  (`UserSettings`).
- **Einstellungen-Toggle**, um den Ernährung-Tab zu verbergen
  („optional“ auf UI-Ebene).
- **Mengen-Normalisierung** (Portionsgrößen, kcal) – nur wenn die
  Nutzerin es will; aktuell reine Freitext-Menge.
- **Open-Food-Facts-Barcode-Suche** (benötigt Netz; bewusst offline-frei
  im MVP).
- **Kalender-/Heatmap-Ûbersicht** des Food-Logs (z. B. Monatsansicht).

## Betroffene Dateien (Übersicht)

| Datei | Änderung |
|---|---|
| `src/db/types.ts` | + `FoodCategory`, `FoodEntry` |
| `src/db/database.ts` | + `foodEntries`-Tabelle, `version(4)` |
| `src/repositories/foodRepository.ts` | **neu** (add/update/delete, getForDay, getByDateRange, getRecentNames) |
| `src/services/statisticsService.ts` | + `analyzeFoodCorrelation`, `FoodAnalysisResult`, `FoodCorrelationResult`, `FOOD_CATEGORIES`, `FOOD_CATEGORY_LABELS`, `FOOD_EXPOSURE_WINDOW_HOURS`, Helfer `isExposed`/`localTimeOf` |
| `src/components/FoodView.tsx` | **neu** (Tages-Log: Datum, Liste, Add/Edit-Formular, Autocomplete) |
| `src/components/StatisticsView.tsx` | + Prop `foodAnalysis`, + `FoodCard` („Ernährung & Migräne“) |
| `src/App.tsx` | + Tab `'food'`, `loadStats` lädt `foodEntries`, Render `FoodView` + `foodAnalysis`-Prop |
| `src/services/dataTransferService.ts` | + `foodEntries` (Export/Import), `EXPORT_FORMAT_VERSION` 3 |
| `src/utils/generateMockData.ts` | + Food-Seed (Trigger-Bias + Normaltage) |
