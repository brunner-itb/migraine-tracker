import { useState, type FormEvent } from 'react';

/**
 * AttackDetailsForm – Wizard-Schritt 2 (Schritt 6.2):
 * Zyklus & Begleitumstände, eingenommene Medikamente, Notizen/Auslöser.
 *
 * Reiner Presentation Layer (wie AttackForm, Schritt 6.1):
 *  - Hält NUR den lokalen Form-State (AttackDetailsFormData + UI-IDs).
 *  - Keine DB-/Repository-Zugriffe, kein GPS.
 *  - Datenabgabe ausschließlich über `onSubmit(data)`, Navigation nach
 *    hinten über `onBack()` (beides reine Callback-Props).
 *
 * Anmerkungen zur späteren Persistenz (Nicht-Goal dieses Schritts):
 *  - `MedicationEntry.type`     -> `Medication.role` (Katalog) bzw.
 *    `MedicationIntake` (Ereignis pro Attacke).
 *  - `MedicationEntry.efficacy` -> `MedicationIntake.effectiveness`.
 *    null bei Prophylaxe ist bewusst: Die Wirksamkeits-Bewertung ist nur
 *    für Akutmedikation relevant (s. EffectivenessScore in db/types.ts).
 *  - `isPMS` / `isMenstruation` / `missedPill` können später als
 *    `CycleEvent`-Zeilen abgeleitet werden (Datum = Attacken-Starttag).
 */

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

/** Rolle des Medikaments: akut (bei Attacke) oder Prophylaxe (Dauermedikation). */
export type MedicationType = 'acute' | 'prophylaxis';

/**
 * Feste Wirkungs-Skala 0–3 (bewusst als Union, wie EffectivenessScore in
 * db/types.ts – übersetzt 1:1 und bleibt Compiler-gesichert).
 */
export type EfficacyScore = 0 | 1 | 2 | 3;

/**
 * Ein eingenommenes Medikament innerhalb einer Attacke.
 */
export interface MedicationEntry {
  /** Lokale UI-ID als stabiler React-Key (KEINE DB-ID). */
  id: string;

  /** Name, z. B. "Sumatriptan" – Pflichtfeld. */
  name: string;

  /** Akutmedikation oder Prophylaxe. */
  type: MedicationType;

  /**
   * Subjektive Wirksamkeit, nur für Akutmedikation relevant:
   * 0 = keine, 1 = leicht, 2 = gut, 3 = schmerzfrei.
   * null = nicht bewertet (Prophylaxe).
   */
  efficacy: EfficacyScore | null;

  /** Optionale Notiz, z. B. Dosis ("50 mg") oder Einnahmezeitpunkt. */
  note: string;
}

/**
 * Form-State von Wizard-Schritt 2.
 * Wird zusammen mit `BaseAttackFormData` (Schritt 6.1) vom Wizard-Container
 * zur Persistierung weitergereicht.
 */
export interface AttackDetailsFormData {
  /** PMS-Symptome vorhanden. */
  isPMS: boolean;

  /** Regeltag / Blutung. */
  isMenstruation: boolean;

  /** Pille vergessen / Einnahmefehler. */
  missedPill: boolean;

  /** Eingenommene Medikamente (leeres Array = keine). */
  medications: MedicationEntry[];

  /** Freitext: Aura, Übelkeit, vermutete Trigger o. Ä. */
  notes: string;
}

/**
 * Vorgefüllte Details für den Edit-Mode (ohne UI-IDs – die Form generiert
 * für die Medikamenten-Einträge selbst frische IDs als React-Keys).
 */
export interface InitialDetailsData {
  isPMS: boolean;
  isMenstruation: boolean;
  missedPill: boolean;
  medications: Omit<MedicationEntry, 'id'>[];
  notes: string;
}

export interface AttackDetailsFormProps {
  /** Wird mit den validierten Details-Daten aufsubmit aufgerufen. */
  onSubmit: (data: AttackDetailsFormData) => void;

  /** Navigation zurück zu Schritt 1 (Zeiten & Schmerzstärke). */
  onBack: () => void;

  /** Vorgefüllte Daten (Edit-Mode); weggelassen = leeres Formular. */
  initialData?: InitialDetailsData;

  /**
   * Beschriftung des Submit-Buttons. Default "Weiter" (Zwischenschritt);
   * der Wizard-Container übergibt "Speichern" für den letzten Schritt.
   */
  submitLabel?: string;

  /** true, während die Daten gespeichert werden: Buttons gesperrt + Spinner. */
  isSubmitting?: boolean;
}

// ---------------------------------------------------------------------------
// Konstanten & Helfer
// ---------------------------------------------------------------------------

/** Beschriftungen der Wirkungs-Skala (0–3). */
const EFFICACY_OPTIONS: { value: EfficacyScore; label: string }[] = [
  { value: 0, label: 'keine' },
  { value: 1, label: 'leicht' },
  { value: 2, label: 'gut' },
  { value: 3, label: 'schmerzfrei' },
];

/** Medikamententypen für die Segment-Steuerung (Reihenfolge = UI-Reihenfolge). */
const MEDICATION_TYPES: { value: MedicationType; label: string }[] = [
  { value: 'acute', label: 'Akut' },
  { value: 'prophylaxis', label: 'Prophylaxe' },
];

/**
 * Lokale UI-IDs für die dynamische Medikamenten-Liste.
 * Modul-Counter (deterministisch, testbar) statt crypto.randomUUID(),
 * da die IDs keine Krypto-Eigenschaften brauchen und nie persistiert werden.
 */
let medicationIdCounter = 0;
function createMedicationId(): string {
  medicationIdCounter += 1;
  return `med-${medicationIdCounter}`;
}

/** Leerer Medikamenten-Eintrag als Ausgangszustand für "Hinzufügen". */
function createEmptyMedication(): MedicationEntry {
  return { id: createMedicationId(), name: '', type: 'acute', efficacy: 0, note: '' };
}

// ---------------------------------------------------------------------------
// Kleine interne UI-Bausteine
// ---------------------------------------------------------------------------

interface ToggleRowProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** Checkbox als volle Zeile mit Beschreibung – gut tippbar auf dem iPhone. */
function ToggleRow({ id, label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label
      htmlFor={id}
      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5
                  transition-colors ${
                    checked
                      ? 'border-sky-300 bg-sky-50'
                      : 'border-gray-200 bg-gray-50'
                  }`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-5 w-5 shrink-0 accent-sky-600"
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium text-gray-800">{label}</span>
        <span className="text-xs text-gray-500">{description}</span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function AttackDetailsForm({
  onSubmit,
  onBack,
  submitLabel = 'Weiter',
  isSubmitting = false,
  initialData,
}: AttackDetailsFormProps) {
  // --- Form-State ----------------------------------------------------------
  // Edit-Mode: wird aus initialData befüllt (frische UI-IDs pro Eintrag).
  const [isPMS, setIsPMS] = useState(initialData?.isPMS ?? false);
  const [isMenstruation, setIsMenstruation] = useState(
    initialData?.isMenstruation ?? false,
  );
  const [missedPill, setMissedPill] = useState(initialData?.missedPill ?? false);
  const [medications, setMedications] = useState<MedicationEntry[]>(() =>
    (initialData?.medications ?? []).map((m) => ({ ...m, id: createMedicationId() })),
  );
  const [notes, setNotes] = useState(initialData?.notes ?? '');

  // --- Validierung ----------------------------------------------------------
  // Einzige Pflichtregel: Jedes hinzugefügte Medikament braucht einen Namen.
  // (Leere Liste ist erlaubt = "keine Einnahme".)
  const isValid = medications.every((m) => m.name.trim() !== '');

  // --- Medikamenten-Liste: State-Updates ------------------------------------

  function addMedication(): void {
    setMedications((prev) => [...prev, createEmptyMedication()]);
  }

  function removeMedication(id: string): void {
    setMedications((prev) => prev.filter((m) => m.id !== id));
  }

  /** Gezieltes Patchen eines Felds (name, note, efficacy). */
  function updateMedication(
    id: string,
    patch: Partial<Pick<MedicationEntry, 'name' | 'note' | 'efficacy'>>,
  ): void {
    setMedications((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  /**
   * Typ-Wechsel mit Konsistenzregel für efficacy:
   *  - zu 'prophylaxis': Bewertung wird verworfen (null) – Prophylaxe wird
   *    nicht nach Wirksamkeit bewertet (s. EffectivenessScore in db/types).
   *  - zu 'acute': fehlende Bewertung wird auf 0 ("keine") gesetzt.
   */
  function handleTypeChange(id: string, type: MedicationType): void {
    setMedications((prev) =>
      prev.map((m) =>
        m.id === id
          ? { ...m, type, efficacy: type === 'acute' ? (m.efficacy ?? 0) : null }
          : m,
      ),
    );
  }

  // --- Submit ----------------------------------------------------------

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!isValid) return; // Defensive – der Button ist ohnehin disabled.

    onSubmit({ isPMS, isMenstruation, missedPill, medications, notes });
  }

  // --- Rendern ----------------------------------------------------------

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      noValidate
    >
      <h1 className="text-lg font-semibold text-gray-900">
        Details &amp; Begleitumstände
      </h1>

      {/* ------------------------------------------------------------------ */}
      {/* Zyklus & Begleitumstände                                            */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-gray-700">Zyklus &amp; Begleitumstände</h2>

        <ToggleRow
          id="details-pms"
          label="PMS-Symptome"
          description="z. B. Reizbarkeit, Brustspannen, Heißhunger"
          checked={isPMS}
          onChange={setIsPMS}
        />
        <ToggleRow
          id="details-menstruation"
          label="Regeltag / Blutung"
          description="Periode an diesem Tag"
          checked={isMenstruation}
          onChange={setIsMenstruation}
        />
        <ToggleRow
          id="details-missed-pill"
          label="Pille vergessen / Einnahmefehler"
          description="z. B. Tablette zu spät, Einnahme vergessen"
          checked={missedPill}
          onChange={setMissedPill}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Eingenommene Medikamente (dynamische Liste)                         */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-gray-700">Eingenommene Medikamente</h2>

        {medications.length === 0 && (
          <p className="text-sm text-gray-400">
            Noch keine Medikamente hinzugefügt.
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {medications.map((med, index) => (
            <li key={med.id} className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
              {/* Karten-Kopf: Nummer + Entfernen */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-700">
                  Medikament {index + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeMedication(med.id)}
                  className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-red-600
                             hover:bg-red-50 focus:outline-none focus-visible:ring-2
                             focus-visible:ring-red-400"
                >
                  Entfernen
                </button>
              </div>

              {/* Name (Pflichtfeld) */}
              <input
                type="text"
                value={med.name}
                onChange={(e) => updateMedication(med.id, { name: e.target.value })}
                placeholder="Name, z. B. Sumatriptan"
                aria-label={`Name Medikament ${index + 1}`}
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900
                           placeholder:text-gray-400
                           focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
              />

              {/* Typ: Segment-Steuerung Akut | Prophylaxe */}
              <div
                role="radiogroup"
                aria-label={`Medikamententyp Medikament ${index + 1}`}
                className="grid grid-cols-2 gap-1 rounded-lg bg-gray-200 p-1"
              >
                {MEDICATION_TYPES.map((typeOption) => {
                  const isSelected = med.type === typeOption.value;
                  return (
                    <button
                      key={typeOption.value}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleTypeChange(med.id, typeOption.value)}
                      className={`min-h-11 rounded-md text-sm font-medium transition-colors
                                  focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
                                  ${
                                    isSelected
                                      ? 'bg-white text-gray-900 shadow-sm'
                                      : 'text-gray-500 hover:text-gray-700'
                                  }`}
                    >
                      {typeOption.label}
                    </button>
                  );
                })}
              </div>

              {/* Wirksamkeit – nur für Akutmedikation relevant */}
              {med.type === 'acute' && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-gray-600">
                    Wie gut hat es gewirkt?
                  </span>
                  <div
                    role="radiogroup"
                    aria-label={`Wirksamkeit Medikament ${index + 1}`}
                    className="grid grid-cols-4 gap-1.5"
                  >
                    {EFFICACY_OPTIONS.map((option) => {
                      const isSelected = med.efficacy === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          aria-label={`Wirksamkeit ${option.value}: ${option.label}`}
                          onClick={() => updateMedication(med.id, { efficacy: option.value })}
                          className={`flex min-h-11 flex-col items-center justify-center rounded-lg
                                      transition-colors focus:outline-none focus-visible:ring-2
                                      focus-visible:ring-sky-400
                                      ${
                                        isSelected
                                          ? 'bg-sky-600 text-white shadow-sm'
                                          : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-100'
                                      }`}
                        >
                          <span className="text-sm font-semibold">{option.value}</span>
                          <span className="text-[10px] leading-tight">{option.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Dosis / Notiz (optional) */}
              <input
                type="text"
                value={med.note}
                onChange={(e) => updateMedication(med.id, { note: e.target.value })}
                placeholder="Dosis / Notiz (optional), z. B. 50 mg"
                aria-label={`Dosis/Notiz Medikament ${index + 1} (optional)`}
                className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900
                           placeholder:text-gray-400
                           focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
              />
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={addMedication}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed
                     border-gray-300 text-sm font-medium text-gray-500
                     transition-colors hover:border-sky-400 hover:text-sky-600
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          + Medikament hinzufügen
        </button>

        {!isValid && (
          <p role="alert" className="text-xs text-red-600">
            Bitte gib für jedes Medikament einen Namen ein.
          </p>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Notizen / Auslöser                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-1.5">
        <label htmlFor="details-notes" className="text-sm font-medium text-gray-700">
          Notizen &amp; Auslöser
        </label>
        <textarea
          id="details-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="Aura, Übelkeit, Stress, Schlafmangel, Wetter, Essen …"
          className="w-full resize-y rounded-lg border border-gray-300 bg-white p-3 text-base text-gray-900
                     placeholder:text-gray-400
                     focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Navigation: Zurück | Weiter                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={isSubmitting}
          className="h-12 flex-1 rounded-xl border border-gray-300 bg-white text-base font-semibold
                     text-gray-700 transition-colors hover:bg-gray-50
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
                     disabled:cursor-not-allowed disabled:opacity-60"
        >
          Zurück
        </button>
        <button
          type="submit"
          disabled={!isValid || isSubmitting}
          className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-sky-600
                     text-base font-semibold text-white shadow-sm
                     transition-colors hover:bg-sky-700
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2
                     disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          {isSubmitting && (
            <span
              aria-hidden="true"
              className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
          )}
          {isSubmitting ? 'Speichert …' : submitLabel}
        </button>
      </div>
    </form>
  );
}
