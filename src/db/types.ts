/**
 * Gemeinsame Typdefinitionen für die Offline-First-Datenhaltung (Dexie / IndexedDB).
 *
 * Konventionen:
 * - Zeitstempel: ISO-8601-Strings (z. B. '2026-07-19T14:30:00+02:00')
 * - Nur-Datum-Werte: 'YYYY-MM-DD' (Zyklus-Ereignisse)
 * - Primärschlüssel: auto-incrementierte Zahlen (Dexie), in TS optional (= Insert-Form)
 */

// ---------------------------------------------------------------------------
// Attacken
// ---------------------------------------------------------------------------

/** Klassifikation der Attacke (hilft beim Filtern und in der Auswertung) */
export type AttackType = 'migraine' | 'tension' | 'other';

export interface MigraineAttack {
  /** Auto-increment-ID (Dexie). Existiert erst nach dem Insert. */
  id?: number;

  /** Startzeit der Attacke – Pflichtfeld, ISO 8601 mit Uhrzeit. */
  startTime: string;

  /** Endzeit – komplett optional. null = offene/laufende Attacke. */
  endTime: string | null;

  /** Schmerzstärke zum Start: 1–10. */
  painLevel: number;

  /** Art der Attacke. */
  type: AttackType;

  /** Freitext: Aura, Übelkeit, Trigger, Schlafqualität o. Ä. */
  notes: string;

  /** FK -> WeatherData.id (1:1). Wird gesetzt, sobald der Abruf erledigt ist. */
  weatherId: number | null;

  /** Änderungsverwaltung (nützlich für Arztbericht und spätere Sync-Logik). */
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Zyklus & Begleitumstände
// ---------------------------------------------------------------------------

/**
 * Art des Zyklus-Ereignisses.
 * 'other' deckt Besonderheiten ab, z. B. "Pille vergessen".
 */
export type CycleEventType =
  | 'menstruation' // Periode, kann mehrere Tage umfassen
  | 'pms'          // PMS-Phase, kann mehrere Tage umfassen
  | 'spotting'     // Zwischenblutung (Blutung außerhalb der Periode)
  | 'cramps'       // Unterleibskrämpfe
  | 'ovulation'    // Eisprung / fruchtbare Phase
  | 'other';       // z. B. "Pille vergessen", "Pille pausiert"

export interface CycleEvent {
  id?: number;

  /** Art des Ereignisses. */
  type: CycleEventType;

  /** Startdatum 'YYYY-MM-DD'. */
  date: string;

  /** Endedatum 'YYYY-MM-DD' – null bei Eintages-Ereignissen. */
  endDate: string | null;

  /** Freitext, z. B. "Pille vergessen", "starke Krämpfe". */
  notes: string;

  createdAt: string;
}

// ---------------------------------------------------------------------------
// Medikation
// ---------------------------------------------------------------------------

/** Rolle: akut (bei Attacke) oder Prophylaxe (tägliche Einnahme). */
export type MedicationRole = 'acute' | 'prophylaxis';

/**
 * Katalogeintrag: ein Medikament, das die Nutzerin besitzt/verwendet.
 * Dient u. a. der aktuellen Medikationsliste im Arztbericht.
 */
export interface Medication {
  id?: number;

  /** Name, z. B. "Sumatriptan", "Topiramat". */
  name: string;

  /** Rolle des Medikaments. */
  role: MedicationRole;

  /** Darreichungsform, z. B. "Tablette", "Nasenspray", "Injektion". */
  form: string;

  /** Übliche Dosierung, Freitext, z. B. "50 mg". */
  dose: string;

  notes: string;

  /** Wird es aktuell noch eingenommen? (Filter für Arztbericht) */
  isActive: boolean;

  createdAt: string;
}

/**
 * Feste Wirksamkeitsskala für Akutmedikation (0–3).
 * Als Union-Typ, damit die Skala auch auf Compiler-Ebene erzwungen wird
 * und Arztbericht/Statistiken sauber auswertbar bleiben.
 */
export type EffectivenessScore = 0 | 1 | 2 | 3;

/**
 * Join-Tabelle (n:m) zwischen Attacken und Medikamenten:
 * "Welches Medikament wurde bei welcher Attacke wann wie eingenommen?"
 * Trägt zusätzlich die Effektivitäts-Bewertung (nur relevant bei Akutmedikation).
 */
export interface MedicationIntake {
  id?: number;

  /** FK -> MigraineAttack.id */
  attackId: number;

  /** FK -> Medication.id */
  medicationId: number;

  /** Einnahmezeitpunkt, ISO 8601 (oft = Attacken-Start). null = unbekannt. */
  takenAt: string | null;

  /** Tatsächliche Dosis an diesem Tag (kann vom Katalog abweichen). */
  dose: string;

  /**
   * Subjektive Wirksamkeit (feste Skala 0–3):
   * 0 = keine, 1 = leicht, 2 = gut, 3 = schmerzfrei.
   * null = nicht bewertet (z. B. Prophylaxe).
   */
  effectiveness: EffectivenessScore | null;

  /** Nebenwirkungen, Freitext. */
  sideEffects: string;

  /** Freie Anmerkungen zu dieser Einnahme (optional). */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Wetter (Open-Meteo, ohne API-Key)
// ---------------------------------------------------------------------------

/** Abrufstatus – erlaubt "Retry on open", falls der erste Fetch fehlschlug. */
export type WeatherStatus = 'pending' | 'fetched' | 'error';

export interface WeatherData {
  id?: number;

  /** FK -> MigraineAttack.id (1:1, durch unique Index erzwungen). */
  attackId: number;

  /** Zeitpunkt, für den die Daten gelten = Attacken-Startzeit. ISO 8601. */
  timestamp: string;

  /** Standort, für den die Daten abgerufen wurden (GPS/City-Fallback). */
  latitude: number;
  longitude: number;

  /** Luftdruck an der Erdoberfläche in hPa (Open-Meteo: surface_pressure). */
  surfacePressure: number | null;

  /** Auf Meeresniveau reduzierte Höhe in hPa (surface_pressure_msl). */
  surfacePressureMsl: number | null;

  /** Optionale Zusatzparameter für spätere Korrelations-Analysen. */
  temperature: number | null; // °C in 2 m
  humidity: number | null;    // % in 2 m

  /** 'pending' = Abruf ausgeplant, 'fetched' = erfolgreich, 'error' = Retry nötig. */
  status: WeatherStatus;

  /** Wann die Daten abgerufen wurden. ISO 8601. */
  fetchedAt: string | null;

  /** z. B. "open-meteo/v3" (aktuell) oder "open-meteo/archive" (historische Daten). */
  source: string;
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

/**
 * Bevorzugte Reihenfolge der Standortauflösung (nutzerwählbar in den
 * Einstellungen). 'last-known' ist in beiden Modi immer das letzte Netz.
 */
export type LocationMode = 'fixed-first' | 'gps-first';

/**
 * Globale App-Einstellungen – IMMER genau eine Zeile (id: 1).
 * Der feste Standort ist optional: latitude/longitude null = „GPS verwenden“.
 */
export interface UserSettings {
  /** Fixer Primärschlüssel: immer 1 (Single-Row-Tabelle). */
  id: number;

  /** Anzeigename des festen Standorts, z. B. 'Hamburg, Deutschland'. '' = kein fester Standort. */
  locationName: string;

  latitude: number | null;
  longitude: number | null;

  /** Zuletzt erfolgreich ermittelter GPS-Standort (automatisch gepflegt, Fallback). */
  lastKnownLatitude: number | null;
  lastKnownLongitude: number | null;
  lastKnownAt: string | null;

  /** Bevorzugte Reihenfolge: 'gps-first' (Default) | 'fixed-first'. */
  locationMode: LocationMode;

  updatedAt: string;
}
