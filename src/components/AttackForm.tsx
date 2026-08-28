import { useState, type FormEvent } from 'react';
import type { AttackLocation } from '../db/types';
import { LocationPicker } from './LocationPicker';
import {
  PainCourseEditor,
  validatePainEntries,
  type PainEntryFormData,
} from './PainCourseEditor';

/**
 * AttackForm – Basis-Formular für die Hauptdaten einer Attacke (Schritt 6.1).
 *
 * Reiner Presentation Layer:
 *  - Hält NUR den lokalen Form-State (BaseAttackFormData + UI-Flags).
 *  - Weis weder etwas von Dexie/Repositories noch von Medikation oder GPS.
 *  - Gibt die Daten ausschließlich über die Callback-Prop `onNext` nach
 *    außen ab – der Aufrufer entscheidet, was damit passiert
 *    (weiterer Wizard-Schritt, Speichern, …).
 *
 * Felder (Schritt 6.1):
 *  - Startzeitpunkt: datetime-local, voreingestellt auf die aktuelle Uhrzeit.
 *  - Endzeitpunkt: erst sichtbar, wenn "Attacke ist bereits beendet" aktiv
 *    ist. Solange die Checkbox deaktiviert ist, bleibt `endTime` im
 *    Form-State undefined (≙ offene/laufende Attacke).
 *  - Standort (optional): LocationPicker mit Progressive Disclosure –
 *    Default "Automatisch (GPS / Einstellungen)", optionaler Custom-Ort
 *    per Suche oder GPS (wichtig für nachträgliche Erfassungen).
 *  - Schmerzstärke: interaktive Skala 1–10 (nummerierte Buttons,
 *    farblich von grün nach rot), Auswahl ist Pflicht.
 *  - Schmerzverlauf (optional): zusätzliche Schmerzpunkte zu späteren
 *    Zeitpunkten der Attacke (PainCourseEditor, direkt unter der Skala).
 *
 * iOS-Hinweise:
 *  - `datetime-local` rendert in Safari (iOS 15.4+) die native
 *    Datum/Uhrzeit-Picker – kein eigenes Picker-UI nötig.
 *  - Alle tippbaren Elemente sind mind. 44×44 pt groß (HIG-Touch-Target).
 */

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

/**
 * Basis-Form-State für eine Attacke (Schritt 6.1).
 *
 * Bewusst abgegrenzt von der DB-Zeile `MigraineAttack`:
 *  - `endTime` ist hier `string | undefined` (undefined = nicht beendet),
 *    während die DB `string | null` nutzt – die Übersetzung (undefined ->
 *    null) passiert erst in der Persistenzschicht.
 *  - Spätere Wizard-Schritte erweitern das Objekt um Medikation,
 *    Anmerkungen, Trigger u. Ä. (eigene Interfaces, die dieses enthalten).
 */
export interface BaseAttackFormData {
  /** Startzeit, ISO 8601 mit Uhrzeit (lokal), z. B. '2026-07-19T14:30'. */
  startTime: string;

  /** Endzeit, ISO 8601 mit Uhrzeit – undefined, wenn die Attacke läuft. */
  endTime: string | undefined;

  /** Schmerzstärke zum Start: Ganzzahl 1–10. */
  painLevel: number;

  /**
   * Optionaler Schmerzverlauf: zusätzliche Schmerzpunkte zu späteren
   * Zeitpunkten der Attacke (leeres Array = nur Hauptwert, wie bisher).
   */
  painEntries: PainEntryFormData[];

  /**
   * Optionaler, manuell gesetzter Standort (z. B. nachträgliche Erfassung
   * für eine Attacke an einem anderen Ort). null = automatisch
   * (Einstellungen/GPS – die Auflösung passiert im Wizard).
   */
  location: AttackLocation | null;
}

export interface AttackFormProps {
  /**
   * Wird mit den validierten Basisdaten aufsubmit aufgerufen.
   * Der Aufrufer kann danach z. B. den nächsten Wizard-Schritt zeigen
   * oder die Attacke direkt speichern.
   */
  onNext: (data: BaseAttackFormData) => void;

  /** Kopfzeile. Default „Neue Attacke erfassen“ (Edit-Mode: „Attacke bearbeiten“). */
  title?: string;

  /** Voreingestellter Startzeitpunkt (Edit-Mode), Format 'YYYY-MM-DDTHH:mm'. */
  initialStartTime?: string;

  /** true, wenn die Attacke bereits beendet war (Edit-Mode). */
  initialIsEnded?: boolean;

  /** Voreingestellter Endzeitpunkt (Edit-Mode). */
  initialEndTime?: string;

  /** Voreingestellte Schmerzstärke (Edit-Mode). */
  initialPainLevel?: number;

  /** Vorhandene Schmerzverlauf-Einträge (Edit-Mode); ohne UI-IDs. */
  initialPainEntries?: Array<{ time: string; level: number }>;

  /**
   * Voreingestellter Custom-Standort (Edit-Mode). null/undefined =
   * automatisch (kein Custom-Standort gesetzt).
   */
  initialLocation?: AttackLocation | null;
}

// ---------------------------------------------------------------------------
// Konstanten & Helfer
// ---------------------------------------------------------------------------

/** Alle möglichen Schmerzstärken (1–10). */
const PAIN_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * Hintergrundfarbe pro Stufe (grün -> gelb -> rot).
 * Explizite Klassen-Strings, damit der Tailwind-JIT sie findet
 * (keine dynamisch zusammengesetzten Klassennamen).
 */
const PAIN_BG_BY_LEVEL: Record<number, string> = {
  1: 'bg-emerald-500',
  2: 'bg-emerald-400',
  3: 'bg-lime-400',
  4: 'bg-yellow-400',
  5: 'bg-yellow-500',
  6: 'bg-amber-500',
  7: 'bg-orange-500',
  8: 'bg-red-400',
  9: 'bg-red-500',
  10: 'bg-red-600',
};

/** Kurze Beschreibung der gewählten Stufe (Feedback unter der Skala). */
function painDescriptor(level: number): string {
  if (level <= 3) return 'leicht';
  if (level <= 6) return 'mittel';
  return 'stark';
}

/**
 * Wandelt einen Date-Wert in das Format von `<input type="datetime-local">`
 * um: 'YYYY-MM-DDTHH:mm' (Lokalzeit, ohne Sekunden/Timezone).
 */
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** true, wenn der datetime-local-String ein parsebares Datum darstellt. */
function isValidDatetime(value: string | undefined): value is string {
  return value !== undefined && value !== '' && !Number.isNaN(new Date(value).getTime());
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function AttackForm({
  onNext,
  title = 'Neue Attacke erfassen',
  initialStartTime,
  initialIsEnded = false,
  initialEndTime,
  initialPainLevel,
  initialPainEntries,
  initialLocation = null,
}: AttackFormProps) {
  // --- Form-State ----------------------------------------------------------
  // startTime: direkt als datetime-local-String gehalten (das ist zugleich
  // das ISO-Format, das die DB erwartet – keine Umrechnung nötig).
  // Edit-Mode: wird aus initialStartTime befüllt (gleiches Format).
  const [startTime, setStartTime] = useState<string>(() =>
    initialStartTime ?? toDatetimeLocalValue(new Date()),
  );

  // isEnded: UI-Flag für die Checkbox – steuert Sichtbarkeit des Endfelds.
  const [isEnded, setIsEnded] = useState(initialIsEnded);

  // endTime: undefined, solange die Attacke läuft (Anforderung Schritt 6.1).
  const [endTime, setEndTime] = useState<string | undefined>(() =>
    initialIsEnded
      ? (initialEndTime ?? toDatetimeLocalValue(new Date()))
      : undefined,
  );

  // painLevel: 0 = bewusst noch nicht gewählt (Pflichtfeld).
  const [painLevel, setPainLevel] = useState(initialPainLevel ?? 0);

  // painEntries: optionaler Verlauf (leer = nur Hauptwert). Edit-Mode:
  // wird aus initialPainEntries befüllt (frische UI-IDs als React-Keys).
  const [painEntries, setPainEntries] = useState<PainEntryFormData[]>(() =>
    (initialPainEntries ?? []).map((e, i) => ({
      uiId: `pe-${i}`,
      time: e.time,
      level: e.level,
    })),
  );

  // location: null = automatisch (Einstellungen/GPS). Edit-Mode: wird aus
  // initialLocation befüllt (Name aus der Attacke, Koordinaten aus der
  // verknüpften Wetterzeile – Rekonstruktion passiert im Wizard).
  const [location, setLocation] = useState<AttackLocation | null>(initialLocation);

  // --- Validierung ----------------------------------------------------------

  const isStartValid = isValidDatetime(startTime);
  const isEndValid = !isEnded || isValidDatetime(endTime);
  const isEndAfterStart =
    !isEnded ||
    (isValidDatetime(endTime) &&
      isValidDatetime(startTime) &&
      new Date(endTime) >= new Date(startTime));
  const isPainValid = painLevel >= 1 && painLevel <= 10;

  // Schmerzverlauf: Einträge brauchen gültige Zeiten (innerhalb Start/Ende)
  // und ein Level 1–10. Fehlermeldung wird unter dem Editor angezeigt,
  // der "Weiter"-Button bleibt deaktiviert.
  const painEntriesError = validatePainEntries(
    painEntries,
    startTime,
    isEnded ? (endTime ?? null) : null,
  );

  const isValid =
    isStartValid &&
    isEndValid &&
    isEndAfterStart &&
    isPainValid &&
    painEntriesError === null;

  // --- Event-Handler ----------------------------------------------------------

  function handleEndedToggle(checked: boolean): void {
    setIsEnded(checked);
    if (checked) {
      // Sinnvoller Default: "endet gerade eben" – bleibt frei anpassbar.
      setEndTime(toDatetimeLocalValue(new Date()));
    } else {
      // Checkbox aus -> Endzeit wird verworfen, endTime bleibt undefined.
      setEndTime(undefined);
    }
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!isValid) return; // Defensive – der Button ist ohnehin disabled.

    onNext({
      startTime,
      endTime: isEnded ? endTime : undefined,
      painLevel,
      painEntries,
      location,
    });
  }

  // --- Rendern ----------------------------------------------------------

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      noValidate
    >
      <h1 className="text-lg font-semibold text-gray-900">{title}</h1>

      {/* ------------------------------------------------------------------ */}
      {/* Startzeitpunkt                                                      */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-1.5">
        <label htmlFor="attack-start" className="text-sm font-medium text-gray-700">
          Startzeitpunkt
        </label>
        <input
          id="attack-start"
          name="startTime"
          type="datetime-local"
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          className="h-11 rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900
                     focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Endzeitpunkt (toggle-gesteuert)                                     */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-2">
        <label
          htmlFor="attack-ended"
          className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-gray-700"
        >
          <input
            id="attack-ended"
            name="isEnded"
            type="checkbox"
            checked={isEnded}
            onChange={(e) => handleEndedToggle(e.target.checked)}
            className="h-5 w-5 rounded border-gray-300 accent-sky-600"
          />
          Attacke ist bereits beendet
        </label>

        {isEnded && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="attack-end" className="text-sm font-medium text-gray-700">
              Endzeitpunkt
            </label>
            <input
              id="attack-end"
              name="endTime"
              type="datetime-local"
              value={endTime ?? ''}
              min={startTime}
              onChange={(e) => setEndTime(e.target.value)}
              className="h-11 rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900
                         focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
            {isEndValid && !isEndAfterStart && (
              <p role="alert" className="text-xs text-red-600">
                Die Endzeit darf nicht vor der Startzeit liegen.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Standort (optional, Progressive Disclosure)                        */}
      {/* ------------------------------------------------------------------ */}
      <LocationPicker value={location} onChange={setLocation} />

      {/* ------------------------------------------------------------------ */}
      {/* Schmerzstärke (Skala 1–10)                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium text-gray-700">
          Schmerzstärke (1 = leicht, 10 = maximal)
        </span>

        <div
          role="radiogroup"
          aria-label="Schmerzstärke von 1 bis 10"
          className="grid grid-cols-5 gap-2"
        >
          {PAIN_LEVELS.map((level) => {
            const isSelected = painLevel === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={`Schmerzstärke ${level} (${painDescriptor(level)})`}
                onClick={() => setPainLevel(level)}
                className={`flex h-11 items-center justify-center rounded-lg text-base font-semibold
                            transition-transform duration-100 focus:outline-none focus-visible:ring-2
                            focus-visible:ring-sky-400 focus-visible:ring-offset-1
                            ${
                              isSelected
                                ? `${PAIN_BG_BY_LEVEL[level]} scale-110 text-white shadow-md ring-2 ring-gray-900/20`
                                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                            }`}
              >
                {level}
              </button>
            );
          })}
        </div>

        <p aria-live="polite" className="text-sm text-gray-600">
          {isPainValid
            ? `Ausgewählt: ${painLevel} von 10 (${painDescriptor(painLevel)})`
            : 'Bitte eine Stufe auswählen.'}
        </p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Schmerzverlauf (optional, direkt unter der Skala)                   */}
      {/* ------------------------------------------------------------------ */}
      <PainCourseEditor
        entries={painEntries}
        onChange={setPainEntries}
        startTime={startTime}
        endTime={isEnded ? (endTime ?? null) : null}
        mainLevel={painLevel}
      />
      {painEntriesError !== null && (
        <p role="alert" className="text-xs text-red-600">
          {painEntriesError}
        </p>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Submit                                                               */}
      {/* ------------------------------------------------------------------ */}
      <button
        type="submit"
        disabled={!isValid}
        className="h-12 rounded-xl bg-sky-600 text-base font-semibold text-white shadow-sm
                   transition-colors hover:bg-sky-700 focus:outline-none focus-visible:ring-2
                   focus-visible:ring-sky-400 focus-visible:ring-offset-2
                   disabled:cursor-not-allowed disabled:bg-gray-300"
      >
        Weiter
      </button>
    </form>
  );
}
