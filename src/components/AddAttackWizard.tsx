import { useEffect, useRef, useState } from 'react';
import { AttackForm, type BaseAttackFormData } from './AttackForm';
import {
  AttackDetailsForm,
  type AttackDetailsFormData,
  type InitialDetailsData,
} from './AttackDetailsForm';
import { validatePainEntries } from './PainCourseEditor';
import {
  attackRepository,
  MISSED_PILL_NOTE,
  type NewAttack,
  type UpdatedAttack,
} from '../repositories/attackRepository';
import { settingsRepository } from '../repositories/settingsRepository';
import { db } from '../db/database';
import type { AttackLocation, CycleEvent, MigraineAttack } from '../db/types';

/**
 * AddAttackWizard – Container-Komponente (Schritt 6.3):
 * verbindet die beiden Formular-Schritte mit GPS und DB-Speicherung.
 *
 * Zuständigkeiten (einzige Komponente mit "Nebenwirkungen"):
 *  - Schritt-State (1 = Grunddaten, 2 = Details) + Daten-Sammlung:
 *      Schritt 1 liefert BaseAttackFormData (wird hier zwischengespeichert),
 *      Schritt 2 liefert AttackDetailsFormData direkt per onSubmit.
 *  - Standortauflösung, blockiert nie:
 *    Custom-Standort aus dem Formular (LocationPicker, Schritt 1) hat
 *    Vorrang – z. B. nachträgliche Erfassung für eine Attacke, die an
 *    einem anderen Ort stattfand. Sonst settingsRepository.resolveLocation():
 *    je nach locationMode fester Standort, Live-GPS (5 s-Timeout) oder der
 *    zuletzt bekannte Standort. `undefined` nur, wenn KEINE Quelle
 *    verfügbar ist. (Repository-Konvention: ohne Koordinaten wird die
 *    Attacke ohne Wetterzeile gespeichert – Retry beim nächsten Start.)
 *  - Persistenz in zwei Stufen (beide offline-first, lokal):
 *      1) attackRepository.addAttack()  -> Attacke (+ Wetter-Planung)
 *      2) persistAttackDetails()        -> CycleEvents + MedicationIntakes
 *    Stufenfolge bewusst: Schlägt Stufe 2 (praktisch nur bei DB-Fehlern)
 *    fehl, ist die Attacke selbst trotzdem sicher gespeichert.
 *
 * UI-Formulare bleiben reine Presentation Layer – sie kennen weder GPS
 * noch die Datenbank.
 */

// ---------------------------------------------------------------------------
// DB-Mapping
// ---------------------------------------------------------------------------

/**
 * Mappt die lokalen UI-Daten auf `NewAttack` (das Format von
 * attackRepository.addAttack).
 *
 * Konvertierungen:
 *  - `endTime: undefined` (Attacke läuft) -> `null` (DB-Konvention).
 *  - `type`: wird von den Formularen noch nicht erfasst -> Default
 *    'migraine'. TODO (folgender Schritt): Attackentyp in Schritt 1
 *    erfassen ('migraine' | 'tension' | 'other').
 *  - `notes`: Freitext aus Schritt 2 (Trigger/Aura/Übelkeit).
 *  - `locationName`: Anzeigename des Custom-Standorts ('' = automatisch).
 *  - `painLevel` = Peak aus Hauptwert + Verlaufseinträgen.
 */
function toNewAttack(
  base: BaseAttackFormData,
  details: AttackDetailsFormData,
  locationName: string,
): NewAttack {
  return {
    startTime: base.startTime,
    endTime: base.endTime ?? null,
    painLevel: Math.max(
      base.painLevel,
      ...base.painEntries.map((e) => e.level),
    ),
    type: 'migraine',
    notes: details.notes,
    locationName,
  };
}

/**
 * Persistiert die Details-Daten (Schritt 2) + Schmerzverlauf (Schritt 1)
 * für eine bereits gespeicherte Attacke: Zyklus-Ereignisse,
 * Medikamenten-Einnahmen, Verlaufseinträge.
 *
 * Hinweis: Direkter `db`-Zugriff als platzsparende Übergangslösung, bis ein
 * dediziertes medicationRepository/cycleRepository existiert (Refactoring-
 * Kandidat für Schritt 6.4). Die lokale UI-ID (`MedicationEntry.id`) wird
 * hier bewusst verworfen – sie ist nur React-Key und wird durch die
 * `medicationIntakes`-Zeilen ersetzt.
 *
 * Zyklus-Toggles -> CycleEvent-Zeilen:
 *  - Nur der Attacken-Tag ist bekannt -> Eintages-Events (endDate: null).
 *  - `spotBleeding` -> type 'spotting', `cramps` -> type 'cramps'.
 *  - `missedPill` -> type 'other' mit Beschreibung in notes.
 *
 * Medikamente:
 *  - Katalog-Eintrag (`medications`) wird per Name wiederverwendet
 *    (case-insensitiv, Index vorhanden) oder neu angelegt.
 *  - Pro Eintrag eine `medicationIntakes`-Zeile: takenAt = Attacken-Start,
 *    dose = Notizfeld der UI ("Dosis / Notiz"), effectiveness nur für
 *    Akutmedikation (Prophylaxe -> null, s. EffectivenessScore).
 *
 * Schmerzverlauf: painEntries-Zeilen (leere Liste = keine Einträge).
 */
async function persistAttackDetails(
  attackId: number,
  details: AttackDetailsFormData,
  attackStart: string,
  painEntries: Array<{ time: string; level: number }>,
): Promise<void> {
  // 'YYYY-MM-DDTHH:mm' (Lokalzeit) -> 'YYYY-MM-DD'; Slice ohne Date-Objekt,
  // damit keine Timezone-Umrechnung dazwischenspielt.
  const day = attackStart.slice(0, 10);
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.cycleEvents, db.medications, db.medicationIntakes, db.painEntries],
    async () => {
      // 1) Zyklus & Begleitumstände
      const cycleEvents: CycleEvent[] = [];
      if (details.isMenstruation) {
        cycleEvents.push({
          type: 'menstruation',
          date: day,
          endDate: null,
          notes: '',
          createdAt: now,
        });
      }
      if (details.isPMS) {
        cycleEvents.push({
          type: 'pms',
          date: day,
          endDate: null,
          notes: '',
          createdAt: now,
        });
      }
      if (details.spotBleeding) {
        cycleEvents.push({
          type: 'spotting',
          date: day,
          endDate: null,
          notes: '',
          createdAt: now,
        });
      }
      if (details.cramps) {
        cycleEvents.push({
          type: 'cramps',
          date: day,
          endDate: null,
          notes: '',
          createdAt: now,
        });
      }
      if (details.missedPill) {
        cycleEvents.push({
          type: 'other',
          date: day,
          endDate: null,
          notes: MISSED_PILL_NOTE,
          createdAt: now,
        });
      }
      if (cycleEvents.length > 0) {
        await db.cycleEvents.bulkAdd(cycleEvents);
      }

      // 2) Medikamente: Katalog upserten + Intake-Zeilen anlegen
      for (const entry of details.medications) {
        const name = entry.name.trim();
        const existing = await db.medications
          .where('name')
          .equalsIgnoreCase(name)
          .first();

        const medicationId =
          existing?.id ??
          (await db.medications.add({
            name,
            role: entry.type,
            form: '',
            dose: '',
            notes: '',
            isActive: true,
            createdAt: now,
          }));

        await db.medicationIntakes.add({
          attackId,
          medicationId,
          takenAt: attackStart,
          dose: entry.note.trim(),
          effectiveness: entry.type === 'acute' ? entry.efficacy : null,
          sideEffects: '',
        });
      }

      // 3) Schmerzverlauf (kommt aus Schritt 1 – s. BaseAttackFormData)
      if (painEntries.length > 0) {
        await db.painEntries.bulkAdd(
          painEntries.map((e) => ({
            attackId,
            time: e.time,
            level: e.level,
          })),
        );
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

type WizardStep = 1 | 2;

export interface AddAttackWizardProps {
  /**
   * Wird nach erfolgreichem Speichern (Attacke + Details) aufgerufen –
   * z. B. um den Wizard zu schließen oder die Liste zu aktualisieren.
   */
  onSuccess?: () => void;
  /**
   * Wenn gesetzt, läuft der Wizard im Edit-Mode: Die Formulare werden mit
   * den Daten dieser Attacke befüllt und "Speichern" aktualisiert die
   * bestehende Zeile (attackRepository.updateAttack) statt einer neuen
   * anzulegen. GPS wird im Edit-Mode nicht automatisch abgefragt (die
   * Wetter-Zeile existiert bereits bzw. wird bei Startzeit-Wechsel per
   * Retry erneuert). Ein manuell geänderter Custom-Standort löst dagegen
   * einen Hintergrund-Re-Fetch der Wetterzeile aus.
   */
  initialAttack?: MigraineAttack | null;
}

export function AddAttackWizard({
  onSuccess,
  initialAttack = null,
}: AddAttackWizardProps) {
  const isEditMode = initialAttack !== null && initialAttack.id !== undefined;

  // --- State ----------------------------------------------------------
  const [step, setStep] = useState<WizardStep>(1);
  /** Zwischengespeicherte Daten aus Schritt 1 (null = Schritt 1 noch offen). */
  const [baseData, setBaseData] = useState<BaseAttackFormData | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Edit-Mode: Initialdaten für Schritt 2 (Intakes + Zyklus-Events) laden.
  const [detailsInitial, setDetailsInitial] = useState<InitialDetailsData | null>(null);

  // Edit-Mode: geladene Schmerzverlauf-Einträge für Schritt 1.
  const [initialPainEntries, setInitialPainEntries] = useState<
    Array<{ time: string; level: number }> | null
  >(null);

  // Edit-Mode: rekonstruierter Custom-Standort (Name aus der Attacke,
  // Koordinaten aus der verknüpften Wetterzeile). null = automatisch.
  const [initialLocation, setInitialLocation] = useState<AttackLocation | null>(null);

  // Edit-Mode: true, sobald alle Initialdaten (Details + Wetterzeile)
  // geladen sind – bis dahin wird KEIN Formular gerendert (sonst würde
  // der Standort-Picker vor der Rekonstruktion mit null starten).
  const [initialDataReady, setInitialDataReady] = useState(!isEditMode);

  // Ref-Guard gegen Doppel-Submit: Der State-Update rendert asynchron,
  // ein schneller Doppelklick würde sonst zweimal durchlaufen.
  const submittingRef = useRef(false);

  // --- Initialdaten laden (Edit-Mode) --------------------------------------
  useEffect(() => {
    if (!isEditMode || initialAttack === null || initialAttack.id === undefined) return;
    // IDs als lokale Consts fixieren: Property-Narrowing (initialAttack.id)
    // würde im async-Closure verloren gehen.
    const attackId = initialAttack.id;
    const day = initialAttack.startTime.slice(0, 10);
    let cancelled = false;
    void (async () => {
      const [intakes, cycleEvents, weatherRow, painEntries] = await Promise.all([
        db.medicationIntakes.where('attackId').equals(attackId).toArray(),
        db.cycleEvents.where('date').equals(day).toArray(),
        db.weatherData.where('attackId').equals(attackId).first(),
        db.painEntries.where('attackId').equals(attackId).sortBy('time'),
      ]);
      const medIds = intakes.map((i) => i.medicationId).filter((id): id is number => id !== undefined);
      const medications = medIds.length > 0 ? await db.medications.bulkGet(medIds) : [];
      if (cancelled) return;
      setDetailsInitial({
        isPMS: cycleEvents.some((e) => e.type === 'pms' && e.endDate === null),
        isMenstruation: cycleEvents.some((e) => e.type === 'menstruation' && e.endDate === null),
        spotBleeding: cycleEvents.some((e) => e.type === 'spotting' && e.endDate === null),
        cramps: cycleEvents.some((e) => e.type === 'cramps' && e.endDate === null),
        missedPill: cycleEvents.some(
          (e) => e.type === 'other' && e.endDate === null && e.notes === MISSED_PILL_NOTE,
        ),
        medications: intakes
          .map((i) => {
            const med = medications.find((m) => m?.id === i.medicationId);
            return {
              name: med?.name ?? '',
              type: med?.role ?? 'acute',
              efficacy: i.effectiveness,
              note: i.dose,
            };
          })
          .filter((m) => m.name !== ''),
        notes: initialAttack.notes,
      });
      setInitialPainEntries(
        painEntries.map((e) => ({ time: e.time, level: e.level })),
      );
      // Custom-Standort rekonstruieren: Name aus der Attacke, Koordinaten
      // aus der 1:1-Wetterzeile. Leerer Name = automatisch (null) – die
      // Wetterzeile trägt dann die automatisch ermittelten Koordinaten.
      if (initialAttack.locationName !== '' && weatherRow !== undefined) {
        setInitialLocation({
          name: initialAttack.locationName,
          latitude: weatherRow.latitude,
          longitude: weatherRow.longitude,
        });
      }
      setInitialDataReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [isEditMode, initialAttack]);

  // --- Navigation ----------------------------------------------------------

  function handleBaseNext(data: BaseAttackFormData): void {
    // Defensive: AttackForm blockiert bereits über den deaktivierten
    // "Weiter"-Button + Inline-Fehler; hier wird der Datenvertrag
    // doppelt geprüft.
    const painError = validatePainEntries(
      data.painEntries,
      data.startTime,
      data.endTime ?? null,
    );
    if (painError !== null) {
      alert(painError);
      return;
    }
    setBaseData(data);
    setStep(2);
    window.scrollTo({ top: 0 });
  }

  function handleDetailsBack(): void {
    setStep(1);
    window.scrollTo({ top: 0 });
  }

  // --- GPS + Speichern ----------------------------------------------------------

  async function handleDetailsSubmit(
    details: AttackDetailsFormData,
  ): Promise<void> {
    if (baseData === null || submittingRef.current) return;

    submittingRef.current = true;
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (isEditMode && initialAttack !== null && initialAttack.id !== undefined) {
        // Edit-Mode: bestehende Zeile + Detail-Daten aktualisieren.
        // Custom-Standort: neue Koordinaten nur bei echter Änderung
        // (sonst unnötiger Wetter-Re-Fetch), s. toUpdatedAttack().
        await attackRepository.updateAttack(
          initialAttack.id,
          toUpdatedAttack(baseData, details, initialLocation),
        );
      } else {
        // 1) Standort bestimmen: Custom-Standort aus dem Formular hat
        //    Vorrang (z. B. nachträgliche Erfassung für einen anderen
        //    Ort), sonst automatische Auflösung – Reihenfolge je nach
        //    locationMode (s. settingsRepository). Blockiert nie;
        //    undefined nur ohne jede Quelle (dann: Attacke ohne
        //    Wetterzeile, Backfill beim nächsten Start).
        const custom = baseData.location;
        const loc =
          custom !== null
            ? { name: custom.name, latitude: custom.latitude, longitude: custom.longitude }
            : await settingsRepository.resolveLocation();
        const coords = loc
          ? { latitude: loc.latitude, longitude: loc.longitude }
          : undefined;

        // 2) Attacke (+ Wetter-Planung) offline-first persistieren.
        const saved = await attackRepository.addAttack(
          toNewAttack(baseData, details, custom?.name ?? ''),
          coords,
        );
        if (saved.id === undefined) {
          throw new Error('addAttack lieferte keine Attacken-ID');
        }

        // 3) Details (Zyklus-Ereignisse + Medikamenten-Einnahmen) +
        //    Schmerzverlauf (aus Schritt 1) persistieren.
        await persistAttackDetails(
          saved.id,
          details,
          baseData.startTime,
          baseData.painEntries,
        );
      }

      onSuccess?.();
    } catch (err) {
      console.error('[AddAttackWizard] Speichern der Attacke fehlgeschlagen:', err);
      setErrorMessage(
        isEditMode
          ? 'Die Änderungen konnten nicht gespeichert werden. Bitte versuche es erneut.'
          : 'Die Attacke konnte nicht vollständig gespeichert werden. Bitte versuche es erneut.',
      );
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  // --- Mapping für Edit-Mode -----------------------------------------------

  function toUpdatedAttack(
    base: BaseAttackFormData,
    details: AttackDetailsFormData,
    initialLoc: AttackLocation | null,
  ): UpdatedAttack {
    const custom = base.location;
    // Standort geändert, wenn sich Existenz/Name/Koordinaten gegenüber
    // dem geladenen Zustand unterscheiden. Nur dann bekommt das
    // Repository neue Koordinaten (-> Wetter-Re-Fetch); "entfernt" wird
    // nur der Name geleert (Wetterzeile bleibt, kein GPS-Prompt).
    const locationChanged =
      (custom === null) !== (initialLoc === null) ||
      (custom !== null &&
        initialLoc !== null &&
        (custom.name !== initialLoc.name ||
          custom.latitude !== initialLoc.latitude ||
          custom.longitude !== initialLoc.longitude));
    return {
      startTime: base.startTime,
      endTime: base.endTime ?? null,
      painLevel: Math.max(
        base.painLevel,
        ...base.painEntries.map((e) => e.level),
      ),
      painEntries: base.painEntries,
      notes: details.notes,
      locationName: custom?.name ?? '',
      locationCoords:
        locationChanged && custom !== null
          ? { latitude: custom.latitude, longitude: custom.longitude }
          : undefined,
      isPMS: details.isPMS,
      isMenstruation: details.isMenstruation,
      spotBleeding: details.spotBleeding,
      cramps: details.cramps,
      missedPill: details.missedPill,
      medications: details.medications.map((m) => ({
        name: m.name.trim(),
        role: m.type,
        dose: m.note.trim(),
        effectiveness: m.type === 'acute' ? m.efficacy : null,
      })),
    };
  }

  // --- Rendern ----------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Schritt-Anzeige */}
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
        {step === 1
          ? 'Schritt 1 von 2 · Grunddaten'
          : 'Schritt 2 von 2 · Details'}
      </p>

      {isEditMode && !initialDataReady ? (
        <p className="mt-10 text-center text-sm text-gray-500">
          Daten werden geladen …
        </p>
      ) : step === 1 ? (
        <AttackForm
          onNext={handleBaseNext}
          title={isEditMode ? 'Attacke bearbeiten' : 'Neue Attacke erfassen'}
          initialStartTime={initialAttack?.startTime}
          initialIsEnded={initialAttack?.endTime != null}
          initialEndTime={initialAttack?.endTime ?? undefined}
          initialPainLevel={initialAttack?.painLevel}
          initialPainEntries={initialPainEntries ?? undefined}
          initialLocation={initialLocation}
        />
      ) : isEditMode && detailsInitial === null ? (
        <p className="mt-10 text-center text-sm text-gray-500">
          Details werden geladen …
        </p>
      ) : (
        <AttackDetailsForm
          onSubmit={handleDetailsSubmit}
          onBack={handleDetailsBack}
          submitLabel="Speichern"
          isSubmitting={isSubmitting}
          initialData={detailsInitial ?? undefined}
        />
      )}

      {errorMessage && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </p>
      )}
    </div>
  );
}
