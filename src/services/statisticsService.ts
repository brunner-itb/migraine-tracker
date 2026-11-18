import { mean, sampleCorrelation } from 'simple-statistics';
import type {
  CycleEvent,
  FoodCategory,
  FoodEntry,
  MigraineAttack,
  WeatherData,
} from '../db/types';

/**
 * statisticsService – reiner Statistik-Layer (Schritt 4).
 *
 * Keine DB, keine UI: Die Funktionen nehmen die DB-Modelle aus
 * `db/types.ts` und liefern stark typisierte Ergebnisse für Recharts
 * bzw. den späteren Arztbericht. Dadurch ist die Schicht einfach
 * unit-testbar und von Dexie/React entkoppelt.
 *
 * Methodik:
 *
 * 1) analyzePressureCorrelation – SPEARMAN-Rangkorrelation (Schmerz vs.
 *    Luftdruck). simple-statistics kennt nur Pearson (`sampleCorrelation`),
 *    daher wird zuerst RANG-TRANSFORMIERT (Ties -> Mittelränge, der
 *    Standard bei Spearman) und Pearson auf die Ränge angewendet:
 *        rho = Pearson(rang(Schmerz), rang(Druck))
 *
 * 2) analyzeCycleCorrelation – PUNKTBISERIALE Korrelation (Schmerz vs.
 *    binärer Indikator „PMS/Regel-Tag“ 0/1). Bei einer binären Variable
 *    ist Pearson exakt die Punktbiseriale Korrelation. Zusätzlich:
 *    Ø Schmerz an Ereignistagen vs. an allen anderen Tagen.
 *
 * 3) (Schritt 4.1) Kein p-Wert mehr: Die pValue-Felder bleiben aus
 *    Interface-Gründen erhalten, liefern aber IMMER null. Stärke und
 *    Richtung des Zusammenhangs werden ausschließlich über den r-Wert
 *    (relationPhrase) in den Text-Summaries beschrieben.
 *
 * 4) getChartData – DB-Modelle in ein flaches Array für Recharts.
 *
 * 5) analyzeFoodCorrelation – Exposure-Vergleich pro Lebensmittel-Kategorie
 *    (24-h-Fenster vor Attacken-Start vs. erfasste Normaltage). Kein r-Wert,
 *    sondern Anteile (Rates) + Differenz; s. Funktionskommentar.
 *
 * Randfälle: Bei n < MIN_N, fehlenden Werten oder Varianzlosigkeit
 * (konstanter Indikator/Schmerz) geben die Funktionen r = null zurück –
 * die UI muss damit rechnen und „nicht auswertbar“ darstellen.
 */

// ---------------------------------------------------------------------------
// Öffentliche Resultat-Typen
// ---------------------------------------------------------------------------

/** Ergebnis der Druck-Korrelation (Spearman, Schmerz vs. Luftdruck). */
export interface PressureCorrelationResult {
  /** Spearman-Koeffizient ρ in [−1…1]. null = nicht berechenbar (n < 3, Varianzlosigkeit). */
  r: number | null;
  /** Immer null – p-Wert wurde in Schritt 4.1 entfernt (Feld bleibt der Interface-Stabilität halber). */
  pValue: number | null;
  /** Anzahl der verwerteten Attacke/Wetter-Paare. */
  n: number;
  /** Anzahl der Attacken ohne Druckwert (ausgeschieden, z. B. status ≠ fetched). */
  excluded: number;
  /** Deutscher Text für Plot-Fußzeile / Arztbericht. */
  summary: string;
}

/** Ergebnis der Zyklus-Auswertung (Punktbiserial + Gruppenmittelwerte). */
export interface CycleCorrelationResult {
  /** Punktbiseriale Korrelation (Schmerz vs. PMS/Regel-Tag 0/1). null = nicht berechenbar. */
  r: number | null;
  /** Immer null – p-Wert wurde in Schritt 4.1 entfernt (Feld bleibt der Interface-Stabilität halber). */
  pValue: number | null;
  /** Anzahl der betrachteten Attacken (mit parsebarem Startdatum). */
  n: number;
  /** Attacken an PMS/Regel-Tagen. */
  nOnEventDays: number;
  /** Attacken an allen anderen Tagen. */
  nOnOtherDays: number;
  /** Ø Schmerz an PMS/Regel-Tagen. null, wenn keine solche Attacke vorliegt. */
  avgPainOnEventDays: number | null;
  /** Ø Schmerz an anderen Tagen. null, wenn keine vorliegt. */
  avgPainOnOtherDays: number | null;
  /** Differenz der Mittelwerte (Ereignistage − andere Tage); null, wenn eine Gruppe fehlt. */
  painDifference: number | null;
  /** Deutscher Text für Plot-Fußzeile / Arztbericht. */
  summary: string;
}

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

/** Flacher Datenpunkt für Recharts (eine Attacke = ein Punkt). */
export interface ChartDataPoint {
  /** Attacken-Start als Epoch-Millisekunden (X-Achse / Sortierung). */
  timestamp: number;
  /** Deutsche Anzeige, z. B. '19.07.2026, 14:00'. */
  formattedDate: string;
  /** Schmerzstärke 1–10. */
  painLevel: number;
  /** Luftdruck in hPa. null = Wetter noch nicht (erfolgreich) abgerufen. */
  pressure: number | null;
  /** true, wenn der Starttag ein PMS- oder Regel-Tag ist. */
  hasPMS: boolean;
}

// ---------------------------------------------------------------------------
// Öffentliche Funktionen
// ---------------------------------------------------------------------------

/**
 * Spearman-Rangkorrelation: Schmerz vs. Luftdruck.
 *
 * Verwertet nur Paare, für die ein (nicht-null) `surfacePressure` vorliegt
 * (Zeilen mit status 'pending'/'error' oder ohne Koordinaten fallen aus
 * und werden in `excluded` gezählt).
 *
 * Gliche Werte erhalten die Mittelränge (Average Ranks), z. B.
 * [5, 5, 7] -> [1.5, 1.5, 3] – die Standard-Definition von Spearman
 * bei Ties (wie scipy.stats.spearmanr).
 */
export function analyzePressureCorrelation(
  attacks: MigraineAttack[],
  weatherData: WeatherData[],
): PressureCorrelationResult {
  // 1:1-Join über weatherData.attackId (nur Paare mit Druckwert).
  const pressureByAttack = new Map<number, number>();
  for (const w of weatherData) {
    if (w.surfacePressure !== null) {
      pressureByAttack.set(w.attackId, w.surfacePressure);
    }
  }

  const pain: number[] = [];
  const pressure: number[] = [];
  let excluded = 0;
  for (const a of attacks) {
    if (a.id === undefined) continue; // defensive: nicht persistierte Zeilen
    const p = pressureByAttack.get(a.id);
    if (p === undefined) {
      excluded += 1;
      continue;
    }
    pain.push(a.painLevel);
    pressure.push(p);
  }

  const n = pain.length;
  if (n < MIN_N) {
    return {
      r: null,
      pValue: null,
      n,
      excluded,
      summary: `Zu wenige Datenpunkte für eine Korrelationsanalyse (n = ${n}, mindestens ${MIN_N} benötigt).`,
    };
  }

  // Spearman = Pearson auf (Mittel-)Rängen.
  const { r, pValue, note } = correlationFromArrays(
    assignRanks(pain),
    assignRanks(pressure),
  );
  if (r === null) {
    return { r, pValue, n, excluded, summary: `Keine Korrelation berechenbar: ${note}.` };
  }

  return {
    r,
    pValue,
    n,
    excluded,
    summary:
      `${relationPhrase(r)} Zusammenhang zwischen Luftdruck und Schmerz ` +
      `(Spearman ρ = ${r.toFixed(2)}, n = ${n}).`,
  };
}

/**
 * Zyklus-Auswertung: Punktbiserial + Gruppenmittelwerte.
 *
 * Ereignistag = das (lokal interpretierte) Startdatum der Attacke liegt im
 * Intervall [date … endDate ?? date] eines Menstruations- oder PMS-Events.
 * Ovulations- und 'other'-Events zählen NICHT als Ereignistage.
 *
 * Die Punktbiseriale Korrelation ist hier exakt der Pearson-Koeffizient
 * zwischen Schmerz und dem 0/1-Indikator. Sie ist nur definiert, wenn BEIDE
 * Gruppen (Ereignistage und andere Tage) nicht leer sind.
 */
export function analyzeCycleCorrelation(
  attacks: MigraineAttack[],
  cycleEvents: CycleEvent[],
): CycleCorrelationResult {
  const events = cycleEvents.filter(
    (e) => e.type === 'menstruation' || e.type === 'pms',
  );

  const pain: number[] = [];
  const indicator: number[] = [];
  const painOnEventDays: number[] = [];
  const painOnOtherDays: number[] = [];

  for (const a of attacks) {
    const date = localDateOf(a.startTime);
    if (date === null) continue; // unparsebares Startdatum -> defensive aussortieren
    const onEventDay = isEventDay(date, events);
    pain.push(a.painLevel);
    indicator.push(onEventDay ? 1 : 0);
    (onEventDay ? painOnEventDays : painOnOtherDays).push(a.painLevel);
  }

  const n = pain.length;
  const nOnEventDays = painOnEventDays.length;
  const nOnOtherDays = painOnOtherDays.length;
  const avgPainOnEventDays = nOnEventDays > 0 ? mean(painOnEventDays) : null;
  const avgPainOnOtherDays = nOnOtherDays > 0 ? mean(painOnOtherDays) : null;
  const painDifference =
    avgPainOnEventDays !== null && avgPainOnOtherDays !== null
      ? avgPainOnEventDays - avgPainOnOtherDays
      : null;

  // Punktbiserial = Pearson(Schmerz, 0/1-Indikator).
  let r: number | null = null;
  let pValue: number | null = null;
  let note: string | null = null;
  if (n >= MIN_N && nOnEventDays > 0 && nOnOtherDays > 0) {
    const res = correlationFromArrays(indicator, pain);
    r = res.r;
    pValue = res.pValue;
    note = res.note;
  }

  // Text-Zusammenfassung (für UI-Fußzeile / Arztbericht).
  const parts: string[] = [];
  if (avgPainOnEventDays !== null && avgPainOnOtherDays !== null && painDifference !== null) {
    const sign = painDifference >= 0 ? '+' : '';
    parts.push(
      `Ø Schmerz an PMS/Regel-Tagen: ${avgPainOnEventDays.toFixed(1)} (n = ${nOnEventDays}) ` +
        `vs. ${avgPainOnOtherDays.toFixed(1)} (n = ${nOnOtherDays}) an anderen Tagen ` +
        `(${sign}${painDifference.toFixed(1)} Punkte).`,
    );
  } else {
    parts.push(
      'Keine Vergleichsgruppe: Es fehlen Attacken an PMS/Regel-Tagen oder an anderen Tagen.',
    );
  }
  if (r !== null) {
    parts.push(
      `Punktbiseriale Korrelation: r = ${r.toFixed(2)}, n = ${n}.`,
    );
  } else if (n < MIN_N) {
    parts.push(`Keine Korrelation möglich (n = ${n} < ${MIN_N}).`);
  } else if (nOnEventDays === 0 || nOnOtherDays === 0) {
    parts.push(
      'Keine Korrelation möglich: Alle Attacken liegen auf einer Seite des 0/1-Indikators.',
    );
  } else {
    parts.push(`Keine Korrelation möglich: ${note ?? 'unbekannter Grund'}.`);
  }

  return {
    r,
    pValue,
    n,
    nOnEventDays,
    nOnOtherDays,
    avgPainOnEventDays,
    avgPainOnOtherDays,
    painDifference,
    summary: parts.join(' '),
  };
}

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
          `Bei ${nAttacksExposed} von ${nAttacks} Attacken ` +
          `(${Math.round((nAttacksExposed / nAttacks) * 100)}%) ` +
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

/**
 * DB-Modelle in ein flaches Array für Recharts transformieren.
 * Ergebnis ist aufsteigend nach Startzeit sortiert.
 *
 * @param attacks       Alle Attacken.
 * @param weatherData   Alle Wetterzeilen (werden per attackId zugeordnet;
 *                      `surfacePressure = null` bleibt null, z. B. status
 *                      'pending'/'error' -> die UI kann dann Lücken zeigen).
 * @param cycleEvents   Optional, aber für `hasPMS` nötig. Default leer
 *                      (dann immer hasPMS = false).
 */
export function getChartData(
  attacks: MigraineAttack[],
  weatherData: WeatherData[],
  cycleEvents: CycleEvent[] = [],
): ChartDataPoint[] {
  const pressureByAttack = new Map<number, number | null>();
  for (const w of weatherData) {
    pressureByAttack.set(w.attackId, w.surfacePressure);
  }
  const events = cycleEvents.filter(
    (e) => e.type === 'menstruation' || e.type === 'pms',
  );

  const points: ChartDataPoint[] = [];
  for (const a of attacks) {
    const d = new Date(a.startTime);
    if (Number.isNaN(d.getTime())) continue; // defensive
    points.push({
      timestamp: d.getTime(),
      formattedDate:
        `${d.toLocaleDateString('de-DE')}, ` +
        d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
      painLevel: a.painLevel,
      pressure: a.id !== undefined ? (pressureByAttack.get(a.id) ?? null) : null,
      // 'en-CA' liefert zuverlässig 'YYYY-MM-DD' in der Geräte-Zeitzone.
      hasPMS: isEventDay(d.toLocaleDateString('en-CA'), events),
    });
  }
  return points.sort((x, y) => x.timestamp - y.timestamp);
}

// ---------------------------------------------------------------------------
// Interne Helfer – Statistik
// ---------------------------------------------------------------------------

/** Mindestanzahl Paare für eine Korrelations-Analyse. */
const MIN_N = 3;

interface RawCorrelation {
  r: number | null;
  pValue: number | null;
  /** Menschlicher Grund, warum r null ist. */
  note: string | null;
}

/**
 * Pearson (simple-statistics) auf zwei Arrays.
 * Gemeinsamer Kern von Spearman (auf Rängen) und Punktbiserial (auf 0/1).
 * Kein p-Wert mehr (Schritt 4.1) – pValue ist immer null.
 *
 * @returns r = null, wenn simple-statistics NaN liefert (keine Varianz in
 *          mindestens einem Array).
 */
function correlationFromArrays(x: number[], y: number[]): RawCorrelation {
  const r = sampleCorrelation(x, y);
  if (Number.isNaN(r)) {
    return {
      r: null,
      pValue: null,
      note: 'keine Varianz in den Werten (z. B. identische Schmerzstärke in allen Einträgen)',
    };
  }
  const clamped = Math.min(1, Math.max(-1, r)); // FP-Abrundung absichern
  return { r: clamped, pValue: null, note: null };
}

/**
 * Ränge 1…n (aufsteigend, kleinster Wert = Rang 1) für ein Wertearray.
 * Gliche Werte erhalten die MITTEL der von ihnen besetzten Ränge
 * („Average Ranks" – der Standard für Spearman mit Ties).
 * Beispiel: [5, 5, 7] -> [1.5, 1.5, 3]
 */
function assignRanks(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j += 1;
    const averageRank = (i + j) / 2 + 1; // Ränge (i+1)…(j+1)
    for (let k = i; k <= j; k += 1) ranks[order[k].i] = averageRank;
    i = j + 1;
  }
  return ranks;
}

// ---------------------------------------------------------------------------
// Interne Helfer – Daten/Text
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' in der Geräte-Zeitzone (null bei unparsebarem Datum). */
function localDateOf(iso: string): string | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA');
}

/** 'YYYY-MM-DDTHH:mm' in der Geräte-Zeitzone (null bei unparseablem Datum). */
function localTimeOf(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * true, wenn das ISO-Datum im Intervall eines (bereits gefilterten)
 * Zyklus-Events liegt. Events ohne endDate gelten als eintägig.
 * String-Vergleich ist gültig dank des festen 'YYYY-MM-DD'-Formats.
 */
function isEventDay(date: string, events: CycleEvent[]): boolean {
  return events.some((e) => date >= e.date && date <= (e.endDate ?? e.date));
}

/** Stärke/Richtung des Zusammenhangs als Adjektiv, z. B. 'mittlerer positiver'. */
function relationPhrase(r: number): string {
  const a = Math.abs(r);
  if (a < 0.1) return 'kein nennenswerter';
  const strength =
    a < 0.3 ? 'schwacher'
    : a < 0.5 ? 'mittlerer'
    : a < 0.7 ? 'ausgeprägter'
    : 'starker';
  return `${r >= 0 ? 'positiver' : 'negativer'} ${strength}`;
}


