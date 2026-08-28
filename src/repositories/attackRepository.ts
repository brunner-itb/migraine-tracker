import { db, type MigraineDB } from '../db/database';
import type {
  CycleEvent,
  EffectivenessScore,
  MedicationRole,
  MigraineAttack,
  PainEntry,
  WeatherData,
} from '../db/types';
import {
  fetchPressureForTimestamp,
  WeatherApiError,
  type Coordinates,
} from '../services/weatherService';

/**
 * attackRepository – Persistenzschicht (Repository) zwischen UI und Dexie.
 *
 * Zuständigkeiten:
 *  - Offline-First-Speicherung von Attacken (sofort, ohne Netz).
 *  - Asynchroner Wetterabruf (weatherService) mit Status-Verwaltung
 *    (pending -> fetched | error).
 *  - Retry-Logik beim App-Start für alle fehlenden/fehlschlagenden Wetterdaten.
 *
 * Designentscheidungen:
 *  - "Keine Koordinaten" => es wird KEINE WeatherData-Zeile angelegt
 *    (≙ skipped). Die Attacke wird dennoch gespeichert. Sobald Koordinaten
 *    verfügbar sind (z. B. nächster App-Start), wird die Zeile von
 *    retryMissingWeather(coords) nachträglich angelegt und befüllt.
 *    So bleiben 1:1-Relation und unique Index sauber – ohne Dummy-Koordinaten.
 *  - Das Repository wirft wegen WETTER nie Exceptions: Wetterfehler landen
 *    im Status der WeatherData-Zeile, die Attacke geht nie verloren.
 */

/**
 * Attacke wie sie in der UI eingegeben wird.
 * Technische Felder (id, weatherId, createdAt, updatedAt) füllt das Repository.
 */
export type NewAttack = Omit<
  MigraineAttack,
  'id' | 'weatherId' | 'createdAt' | 'updatedAt'
>;

/**
 * Medikamenteneintrag für updateAttack (Edit-Mode):
 * Name + Rolle + Dosis + Wirksamkeit. Der Katalog (medications) wird
 * wie bei addAttack per Name wiederverwendet oder neu angelegt.
 */
export interface UpdatedMedication {
  name: string;
  role: MedicationRole;
  dose: string;
  effectiveness: EffectivenessScore | null;
}

/**
 * Attacken-Daten für updateAttack (Edit-Mode):
 * Basisdaten (wie NewAttack, außer type – der Typ wird in der UI
 * noch nicht editiert) + Zyklus-Toggles + Medikamente.
 */
export type UpdatedAttack = Omit<NewAttack, 'type'> & {
  isPMS: boolean;
  isMenstruation: boolean;
  spotBleeding: boolean;
  cramps: boolean;
  missedPill: boolean;
  medications: UpdatedMedication[];
  /**
   * Neue Custom-Standort-Koordinaten – nur setzen, wenn sich der manuell
   * gesetzte Standort geändert hat. Vorhanden => Wetter-Zeile wird auf
   * diese Koordinaten + Timestamp umgestellt (oder neu angelegt) und im
   * Hintergrund neu abgerufen. Abwesend => unverändertes Wetterverhalten
   * (Startzeit-Wechsel -> Retry beim nächsten App-Start).
   */
  locationCoords?: Coordinates;
  /**
   * Schmerzverlauf: VOLLER Ersatz (alle vorhandenen Einträge werden gelöscht
   * und diese neu angelegt). Leeres Array = keine Einträge.
   * Optional (`?? []` im Repository), damit Schritt 2 eigenständig
   * compilierbar bleibt – der Wizard setzt es ab Schritt 3 immer.
   */
  painEntries?: Array<{ time: string; level: number }>;
};

/**
 * Feste Notiz für „Pille vergessen“-Zyklus-Events.
 * Zentrale Konstante, damit Erzeugung (Wizard) und Edit (updateAttack)
 * dieselbe Zeichenfolge nutzen und Wizard-Events zuverlässig erkannt
 * werden können (Delete-und-Neu-Strategie).
 */
export const MISSED_PILL_NOTE = 'Pille vergessen / Einnahmefehler';

/** Ergebnis eines Retry-Laufs (für UI-Feedback, z. B. Toast). */
export interface RetryResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export class AttackRepository {
  constructor(private readonly database: MigraineDB = db) {}

  // -----------------------------------------------------------------------
  // Schreiben
  // -----------------------------------------------------------------------

  /**
   * Speichert eine neue Attacke sofort (Offline-First) und triggert –
   * sofern Koordinaten vorliegen – den Wetterabruf asynchron im Hintergrund.
   *
   * @param attackData Eingegebene Attacke (startTime, painLevel, …).
   * @param coords     Optionale Geokoordinaten (UI -> navigator.geolocation).
   *                    Ohne Koordinaten wird die Attacke ohne Wetterzeile
   *                    gespeichert (≙ skipped, s. Module-Kommentar).
   * @returns Die gespeicherte Attacke (mit id). Resolve, sobald der
   *          IndexedDB-Write abgeschlossen ist – NICHT erst nach dem
   *          Wetter-Fetch.
   */
  async addAttack(
    attackData: NewAttack,
    coords?: Coordinates,
  ): Promise<MigraineAttack> {
    this.validate(attackData);

    const now = new Date().toISOString();

    // 1) Attacke + (ggf.) Wetterzeile in EINER atomaren Transaction.
    const saved = await this.database.transaction(
      'rw',
      [this.database.attacks, this.database.weatherData],
      async () => {
        const attackId = await this.database.attacks.add({
          ...attackData,
          weatherId: null,
          createdAt: now,
          updatedAt: now,
        });

        let weatherId: number | null = null;
        if (coords) {
          weatherId = await this.database.weatherData.add(
            pendingWeatherRow(attackId, attackData.startTime, coords),
          );
          await this.database.attacks.update(attackId, { weatherId });
        }

        return {
          ...attackData,
          id: attackId,
          weatherId,
          createdAt: now,
          updatedAt: now,
        };
      },
    );

    // 2) Hintergrund-Fetch – blockiert die UI nicht, verliert die Attacke nicht.
    //    Fehlerbehandlung läuft komplett in refreshWeather() (Status -> 'error').
    if (saved.weatherId !== null && coords) {
      void this.refreshWeather(saved.weatherId, coords).catch((err) => {
        // Nur Safety-Net – refreshWeather() wirft normalerweise keine Exceptions.
        console.warn('[attackRepository] Unerwarteter Wetterfehler:', err);
      });
    }

    return saved;
  }

  /**
   * Aktualisiert eine bestehende Attacke (Edit-Mode) und synchronisiert
   * die zugehörigen Detail-Daten (Medikamente + Zyklus-Events des Tags).
   *
   * Strategie (eine atomare Transaction):
   *  1) Attacken-Zeile wird aktualisiert (startTime, endTime, painLevel,
   *     notes, locationName, updatedAt). Der Typ bleibt unverändert.
   *  2) Medikamente: Alle Intakes der Attacke werden gelöscht und aus dem
   *     Form-State neu angelegt (Katalog wie bei addAttack per Name
   *     wiederverwendet/angelegt).
   *  3) Zyklus-Events: Sie sind pro TAG gespeichert (kein FK zur Attacke).
   *     Von der UI (Wizard) erzeugte Events – Eintages-Events mit fester
   *     Notiz – werden für den alten und (falls anders) neuen Tag gelöscht
   *     und aus dem Form-State neu angelegt.
   *     Hinweis: Teilen sich zwei Attacken denselben Tag, teilen sie auch
   *     die Zyklus-Events des Tags – das zuletzt gespeicherte Formular
   *     gewinnt (bewusste Tag-Semantik, s. CycleEvent in db/types.ts).
   *  4) Wetter:
   *     a) locationCoords vorhanden (Custom-Standort gesetzt/geändert):
   *        Wetter-Zeile wird auf die neuen Koordinaten + Timestamp
   *        umgestellt (Status 'pending') oder neu angelegt; danach
   *        Hintergrund-Re-Fetch (blockiert nie, Fehler -> Status 'error').
   *     b) Sonst: Hat sich die Startzeit geändert, wird die vorhandene
   *        Wetter-Zeile auf 'error' gesetzt (mit neuem Timestamp), damit
   *        der Retry beim nächsten App-Start die Daten mit den
   *        gespeicherten Koordinaten neu abruft.
   */
  async updateAttack(
    attackId: number,
    data: UpdatedAttack,
  ): Promise<MigraineAttack> {
    const oldAttack = await this.database.attacks.get(attackId);
    if (!oldAttack) {
      throw new Error(`updateAttack: Attacke mit ID ${attackId} nicht gefunden`);
    }
    this.validate({
      startTime: data.startTime,
      endTime: data.endTime,
      painLevel: data.painLevel,
      type: oldAttack.type,
      notes: data.notes,
      locationName: data.locationName,
    });
    for (const med of data.medications) {
      if (med.name.trim() === '') {
        throw new Error('updateAttack: Medikament ohne Namen');
      }
    }

    const now = new Date().toISOString();
    const oldDay = oldAttack.startTime.slice(0, 10);
    const newDay = data.startTime.slice(0, 10);
    // Betroffene Tage, deren Wizard-Zyklus-Events zurückgesetzt werden.
    const daysToReset = oldDay === newDay ? [oldDay] : [oldDay, newDay];

    const result = await this.database.transaction(
      'rw',
      [
        this.database.attacks,
        this.database.medications,
        this.database.medicationIntakes,
        this.database.cycleEvents,
        this.database.weatherData,
        this.database.painEntries,
      ],
      async () => {
        // 1) Attacken-Zeile
        await this.database.attacks.update(attackId, {
          startTime: data.startTime,
          endTime: data.endTime,
          painLevel: data.painLevel,
          notes: data.notes,
          updatedAt: now,
        });

        // 2) Medikamente: löschen + neu anlegen
        await this.database.medicationIntakes
          .where('attackId')
          .equals(attackId)
          .delete();

        for (const med of data.medications) {
          const name = med.name.trim();
          const existing = await this.database.medications
            .where('name')
            .equalsIgnoreCase(name)
            .first();

          const medicationId =
            existing?.id ??
            (await this.database.medications.add({
              name,
              role: med.role,
              form: '',
              dose: '',
              notes: '',
              isActive: true,
              createdAt: now,
            }));

          await this.database.medicationIntakes.add({
            attackId,
            medicationId,
            takenAt: data.startTime,
            dose: med.dose,
            effectiveness: med.effectiveness,
            sideEffects: '',
          });
        }

        // 3) Zyklus-Events: Wizard-Events der betroffenen Tage zurücksetzen
        for (const day of daysToReset) {
          const events = await this.database.cycleEvents
            .where('date')
            .equals(day)
            .toArray();
          const wizardIds = events
            .filter(isWizardCycleEvent)
            .map((e) => e.id)
            .filter((id): id is number => id !== undefined);
          if (wizardIds.length > 0) {
            await this.database.cycleEvents.bulkDelete(wizardIds);
          }
        }

        const cycleEvents: CycleEvent[] = [];
        if (data.isMenstruation) {
          cycleEvents.push({
            type: 'menstruation',
            date: newDay,
            endDate: null,
            notes: '',
            createdAt: now,
          });
        }
        if (data.isPMS) {
          cycleEvents.push({
            type: 'pms',
            date: newDay,
            endDate: null,
            notes: '',
            createdAt: now,
          });
        }
        if (data.spotBleeding) {
          cycleEvents.push({
            type: 'spotting',
            date: newDay,
            endDate: null,
            notes: '',
            createdAt: now,
          });
        }
        if (data.cramps) {
          cycleEvents.push({
            type: 'cramps',
            date: newDay,
            endDate: null,
            notes: '',
            createdAt: now,
          });
        }
        if (data.missedPill) {
          cycleEvents.push({
            type: 'other',
            date: newDay,
            endDate: null,
            notes: MISSED_PILL_NOTE,
            createdAt: now,
          });
        }
        if (cycleEvents.length > 0) {
          await this.database.cycleEvents.bulkAdd(cycleEvents);
        }

        // 3b) Schmerzverlauf: voller Ersatz (delete + bulkAdd,
        //     gleiches Muster wie die Medikamenten-Einnahmen oben).
        await this.database.painEntries
          .where('attackId')
          .equals(attackId)
          .delete();
        const painEntries = data.painEntries ?? [];
        if (painEntries.length > 0) {
          await this.database.painEntries.bulkAdd(
            painEntries.map((e) => ({ attackId, time: e.time, level: e.level })),
          );
        }

        // 4) Wetter-Zeile
        let weatherIdToRefresh: number | null = null;
        if (data.locationCoords !== undefined) {
          // a) Custom-Standort gesetzt/geändert: Zeile umstellen (oder neu
          //    anlegen) + Status 'pending' -> Re-Fetch nach der Transaktion.
          const existing = await this.database.weatherData
            .where('attackId')
            .equals(attackId)
            .first();
          if (existing?.id !== undefined) {
            await this.database.weatherData.update(existing.id, {
              latitude: data.locationCoords.latitude,
              longitude: data.locationCoords.longitude,
              timestamp: data.startTime,
              status: 'pending',
              fetchedAt: null,
            });
            weatherIdToRefresh = existing.id;
          } else {
            const newWeatherId = await this.database.weatherData.add(
              pendingWeatherRow(attackId, data.startTime, data.locationCoords),
            );
            await this.database.attacks.update(attackId, { weatherId: newWeatherId });
            weatherIdToRefresh = newWeatherId;
          }
        } else if (
          oldAttack.weatherId !== null &&
          data.startTime !== oldAttack.startTime
        ) {
          // b) Startzeit-Wechsel ohne Standortwechsel: Retry beim nächsten
          //    App-Start (mit den gespeicherten Koordinaten).
          await this.database.weatherData.update(oldAttack.weatherId, {
            timestamp: data.startTime,
            status: 'error',
            fetchedAt: null,
          });
        }

        return {
          attack: {
            ...oldAttack,
            startTime: data.startTime,
            endTime: data.endTime,
            painLevel: data.painLevel,
            notes: data.notes,
            locationName: data.locationName,
            updatedAt: now,
          },
          weatherIdToRefresh,
        };
      },
    );

    // 5) Hintergrund-Re-Fetch für den geänderten Custom-Standort –
    //    blockiert die UI nicht, Fehler landen im Status ('error').
    if (result.weatherIdToRefresh !== null && data.locationCoords !== undefined) {
      void this.refreshWeather(result.weatherIdToRefresh, data.locationCoords).catch(
        (err) => {
          console.warn('[attackRepository] Unerwarteter Wetterfehler:', err);
        },
      );
    }

    return result.attack;
  }

  /**
   * Löscht eine Attacke inkl. aller abhängigen Daten (Kaskade, atomar):
   *  - Wetter-Zeile (1:1, unique attackId)
   *  - Medikamenten-Einnahmen (n:1)
   *  - Schmerzverlauf (n:1)
   *
   * Zyklus-Events werden bewusst NICHT gelöscht: Sie sind tagbasiert und
   * eigenständig (kein FK zur Attacke) – derselbe Tag kann weitere Attacken
   * oder manuell gepflegte Events tragen (s. CycleEvent in db/types.ts).
   */
  async deleteAttack(attackId: number): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        this.database.weatherData,
        this.database.medicationIntakes,
        this.database.painEntries,
        this.database.attacks,
      ],
      async () => {
        await this.database.weatherData
          .where('attackId')
          .equals(attackId)
          .delete();
        await this.database.medicationIntakes
          .where('attackId')
          .equals(attackId)
          .delete();
        await this.database.painEntries
          .where('attackId')
          .equals(attackId)
          .delete();
        await this.database.attacks.delete(attackId);
      },
    );
  }

  // -----------------------------------------------------------------------
  // Lesen
  // -----------------------------------------------------------------------

  /**
   * Liest alle Attacken im Zeitraum [startISO, endISO) – aufsteigend nach
   * startTime sortiert.
   *
   * Bewusst zeitraum-agnostisch (Monat, Woche, Quartal, Jahr …): Die UI
   * berechnet die Grenzen, z. B. für "August 2026":
   *   start = '2026-08-01T00:00', end = '2026-09-01T00:00'
   * (ISO-Strings im einheitlichen 'YYYY-MM-DDTHH:mm'-Format lassen sich
   * lexikografisch vergleichen – keine Date-Objekte, kein TZ-Risiko.)
   */
  async getAttacksByDateRange(
    startISO: string,
    endISO: string,
  ): Promise<MigraineAttack[]> {
    return this.database.attacks
      .filter((a) => a.startTime >= startISO && a.startTime < endISO)
      .sortBy('startTime');
  }

  // -----------------------------------------------------------------------
  // Retry beim App-Start
  // -----------------------------------------------------------------------

  /**
   * Versucht alle fehlenden oder fehlgeschlagenen Wetterdaten erneut
   * (beim App-Start aufrufen).
   *
   * Deckt zwei Gruppen ab:
   *  1. Vorhandene WeatherData-Zeilen mit Status 'pending' oder 'error'
   *     (z. B. Gerät war offline, als die Attacke erfasst wurde).
   *  2. Attacken OHNE Wetterzeile (ohne Koordinaten erfasst) – werden nur
   *     backfilled, wenn aktuelle Koordinaten übergeben werden.
   *
   * Läufe sequenziell (kleine Datenmengen, fair zur API).
   *
   * @param coords Aktuelle Koordinaten (optional, z. B. via Geolocation).
   * @returns Anzahl Versuche/Erfolge/Fehler für UI-Feedback.
   */
  async retryMissingWeather(coords?: Coordinates): Promise<RetryResult> {
    const result: RetryResult = { attempted: 0, succeeded: 0, failed: 0 };

    // Gruppe 1: vorhandene Zeilen mit pending/error
    const missingRows = await this.database.weatherData
      .where('status')
      .anyOf(['pending', 'error'])
      .toArray();

    for (const row of missingRows) {
      if (row.id === undefined) continue; // defensiv – kann nicht vorkommen
      result.attempted += 1;
      const ok = await this.refreshWeather(row.id, {
        latitude: row.latitude,
        longitude: row.longitude,
      });
      if (ok) result.succeeded += 1;
      else result.failed += 1;
    }

    // Gruppe 2: Attacken ohne Wetterzeile (nur mit aktuellen Koordinaten)
    if (coords) {
      const orphanAttacks = await this.database.attacks
        .filter((a) => a.weatherId === null)
        .toArray();

      for (const attack of orphanAttacks) {
        if (attack.id === undefined) continue; // defensiv
        result.attempted += 1;
        const weatherId = await this.database.transaction(
          'rw',
          [this.database.weatherData, this.database.attacks],
          async () => {
            const id = await this.database.weatherData.add(
              pendingWeatherRow(attack.id!, attack.startTime, coords),
            );
            await this.database.attacks.update(attack.id!, { weatherId: id });
            return id;
          },
        );
        const ok = await this.refreshWeather(weatherId, coords);
        if (ok) result.succeeded += 1;
        else result.failed += 1;
      }
    }

    return result;
  }

  /**
   * Ruft die Wetterdaten für ALLE Attacken mit den übergebenen Koordinaten
   * neu ab (nach Standortwechsel, nur auf explizite Nutzer-Bestätigung).
   *
   * Pro Attacke:
   *  - vorhandene Wetter-Zeile: Koordinaten aktualisieren + Status 'pending'
   *    -> refreshWeather()
   *  - fehlende Wetter-Zeile:  Zeile anlegen (pending) + 1:1-Link + refresh
   *
   * Läufe sequenziell (fair zur API). Wirft nie – Fehler landen im Status.
   *
   * @param onProgress Optionales UI-Feedback (done, total).
   */
  async refetchAllWeather(
    coords: Coordinates,
    onProgress?: (done: number, total: number) => void,
  ): Promise<RetryResult> {
    const attacks = await this.database.attacks.toArray();
    const result: RetryResult = { attempted: 0, succeeded: 0, failed: 0 };

    for (const attack of attacks) {
      if (attack.id === undefined) continue; // defensiv
      result.attempted += 1;

      const existing = await this.database.weatherData
        .where('attackId')
        .equals(attack.id)
        .first();

      let weatherId: number;
      if (existing?.id !== undefined) {
        await this.database.weatherData.update(existing.id, {
          latitude: coords.latitude,
          longitude: coords.longitude,
          status: 'pending',
          fetchedAt: null,
        });
        weatherId = existing.id;
      } else {
        weatherId = await this.database.transaction(
          'rw',
          [this.database.weatherData, this.database.attacks],
          async () => {
            const id = await this.database.weatherData.add(
              pendingWeatherRow(attack.id!, attack.startTime, coords),
            );
            await this.database.attacks.update(attack.id!, { weatherId: id });
            return id;
          },
        );
      }

      const ok = await this.refreshWeather(weatherId, coords);
      if (ok) result.succeeded += 1;
      else result.failed += 1;
      onProgress?.(result.attempted, attacks.length);
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Interne Helfer
  // -----------------------------------------------------------------------

  /**
   * Ruft Wetter für eine vorhandene WeatherData-Zeile ab und persistiert
   * das Ergebnis. Wirft NIE: Jeder Fehler wird als Status 'error'
   * protokolliert, damit retryMissingWeather() ihn beim nächsten App-Start
   * wieder aufgreift.
   *
   * @returns true, wenn die Zeile jetzt 'fetched' ist, sonst false.
   */
  private async refreshWeather(
    weatherId: number,
    coords: Coordinates,
  ): Promise<boolean> {
    const weatherTable = this.database.weatherData;
    const row = await weatherTable.get(weatherId);
    if (!row) return false;
    if (row.status === 'fetched') return true;

    try {
      const snapshot = await fetchPressureForTimestamp(row.timestamp, coords);
      if (snapshot.surfacePressure === null) {
        // API hat geantwortet, aber kein Druckwert für diese Stunde
        // (z. B. ERA5-Lücke) -> später erneut versuchen.
        throw new WeatherApiError('surface_pressure für die Zielstunde fehlt');
      }

      await this.database.transaction(
        'rw',
        [weatherTable, this.database.attacks],
        async () => {
          await weatherTable.update(weatherId, {
            surfacePressure: snapshot.surfacePressure,
            surfacePressureMsl: snapshot.surfacePressureMsl,
            temperature: snapshot.temperature,
            humidity: snapshot.humidity,
            status: 'fetched',
            fetchedAt: new Date().toISOString(),
            source: snapshot.source,
          });

          // Backfill-Fall: Zeile wurde nachträglich angelegt (Retry mit
          // späten Koordinaten) -> 1:1-Verknüpfung zur Attacke herstellen.
          const attack = await this.database.attacks.get(row.attackId);
          if (attack && attack.id !== undefined && attack.weatherId !== weatherId) {
            await this.database.attacks.update(attack.id, {
              weatherId,
              updatedAt: new Date().toISOString(),
            });
          }
        },
      );
      return true;
    } catch (err) {
      // Offline / Timeout / Datenlücke -> 'error' für den nächsten Retry-Lauf.
      console.warn(
        `[attackRepository] Wetterabruf fehlgeschlagen (attackId ${row.attackId}):`,
        err,
      );
      try {
        await weatherTable.update(weatherId, { status: 'error' });
      } catch {
        // Darf die App unter keinen Umständen brechen.
      }
      return false;
    }
  }

  /** Basis-Plausibilität vor dem ersten Write (UI bleibt die Haupt-Validierung). */
  private validate(a: NewAttack): void {
    if (Number.isNaN(new Date(a.startTime).getTime())) {
      throw new Error('addAttack: startTime ist kein gültiges Datum');
    }
    if (a.endTime !== null && Number.isNaN(new Date(a.endTime).getTime())) {
      throw new Error('addAttack: endTime ist kein gültiges Datum');
    }
    if (!Number.isInteger(a.painLevel) || a.painLevel < 1 || a.painLevel > 10) {
      throw new Error('addAttack: painLevel muss eine Ganzzahl 1–10 sein');
    }
  }
}

/**
 * true, wenn das Event vom Wizard erzeugt wurde: Eintages-Event (endDate
 * null) mit leerer oder fester „Pille vergessen“-Notiz. Nur diese Events
 * darf updateAttack() zurücksetzen – manuell ergänzte Events (spätere
 * UI-Features) bleiben unberührt.
 */
function isWizardCycleEvent(e: CycleEvent): boolean {
  return e.endDate === null && (e.notes === '' || e.notes === MISSED_PILL_NOTE);
}

/** Factory: WeatherData-Zeile im Anfangszustand 'pending'. */
function pendingWeatherRow(
  attackId: number,
  startTime: string,
  coords: Coordinates,
): WeatherData {
  return {
    attackId,
    timestamp: startTime,
    latitude: coords.latitude,
    longitude: coords.longitude,
    surfacePressure: null,
    surfacePressureMsl: null,
    temperature: null,
    humidity: null,
    status: 'pending',
    fetchedAt: null,
    source: '',
  };
}

/** Fertige Instanz (Default: globale Dexie-DB; in Tests injizierbar). */
export const attackRepository = new AttackRepository();
