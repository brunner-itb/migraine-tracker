import { useEffect, useRef, useState } from 'react';
import { AttackForm, type BaseAttackFormData } from './AttackForm';
import {
  AttackDetailsForm,
  type AttackDetailsFormData,
  type InitialDetailsData,
} from './AttackDetailsForm';
import {
  attackRepository,
  MISSED_PILL_NOTE,
  type NewAttack,
  type UpdatedAttack,
} from '../repositories/attackRepository';
import { settingsRepository } from '../repositories/settingsRepository';
import { db } from '../db/database';
import type { CycleEvent, MigraineAttack } from '../db/types';

/**
 * AddAttackWizard – Container-Komponente (Schritt 6.3):
 * verbindet die beiden Formular-Schritte mit GPS und DB-Speicherung.
 *
 * Zuständigkeiten (einzige Komponente mit "Nebenwirkungen"):
 *  - Schritt-State (1 = Grunddaten, 2 = Details) + Daten-Sammlung:
 *      Schritt 1 liefert BaseAttackFormData (wird hier zwischengespeichert),
 *      Schritt 2 liefert AttackDetailsFormData direkt per onSubmit.
 *  - Standortauflösung (Settings -> GPS), blockiert nie:
 *    settingsRepository.resolveLocation() liefert je nach locationMode
 *    festen Standort, Live-GPS (5 s-Timeout) oder den zuletzt bekannten
 *    Standort. `undefined` nur, wenn KEINE Quelle verfügbar ist.
 *    (Repository-Konvention: ohne Koordinaten wird die Attacke ohne
 *    Wetterzeile gespeichert – Retry beim nächsten App-Start.)
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
 */
function toNewAttack(
  base: BaseAttackFormData,
  details: AttackDetailsFormData,
): NewAttack {
  return {
    startTime: base.startTime,
    endTime: base.endTime ?? null,
    painLevel: base.painLevel,
    type: 'migraine',
    notes: details.notes,
  };
}

/**
 * Persistiert die Details-Daten (Schritt 2) für eine bereits gespeicherte
 * Attacke: Zyklus-Ereignisse + Medikamenten-Einnahmen.
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
 */
async function persistAttackDetails(
  attackId: number,
  details: AttackDetailsFormData,
  attackStart: string,
): Promise<void> {
  // 'YYYY-MM-DDTHH:mm' (Lokalzeit) -> 'YYYY-MM-DD'; Slice ohne Date-Objekt,
  // damit keine Timezone-Umrechnung dazwischenspielt.
  const day = attackStart.slice(0, 10);
  const now = new Date().toISOString();

  await db.transaction(
    'rw',
    [db.cycleEvents, db.medications, db.medicationIntakes],
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
   * anzulegen. GPS wird im Edit-Mode nicht abgefragt (die Wetter-Zeile
   * existiert bereits bzw. wird bei Startzeit-Wechsel per Retry erneuert).
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
      const [intakes, cycleEvents] = await Promise.all([
        db.medicationIntakes.where('attackId').equals(attackId).toArray(),
        db.cycleEvents.where('date').equals(day).toArray(),
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
    })();
    return () => {
      cancelled = true;
    };
  }, [isEditMode, initialAttack]);

  // --- Navigation ----------------------------------------------------------

  function handleBaseNext(data: BaseAttackFormData): void {
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
        // Edit-Mode: bestehende Zeile + Detail-Daten aktualisieren (kein GPS).
        await attackRepository.updateAttack(
          initialAttack.id,
          toUpdatedAttack(baseData, details),
        );
      } else {
        // 1) Standort auflösen – Reihenfolge je nach locationMode
        //    (s. settingsRepository). 'fixed-first' + fester Standort =
        //    KEIN GPS-Prompt. Blockiert nie; undefined nur ohne jede Quelle
        //    (dann: Attacke ohne Wetterzeile, Backfill beim nächsten Start).
        const loc = await settingsRepository.resolveLocation();
        const coords = loc
          ? { latitude: loc.latitude, longitude: loc.longitude }
          : undefined;

        // 2) Attacke (+ Wetter-Planung) offline-first persistieren.
        const saved = await attackRepository.addAttack(
          toNewAttack(baseData, details),
          coords,
        );
        if (saved.id === undefined) {
          throw new Error('addAttack lieferte keine Attacken-ID');
        }

        // 3) Details (Zyklus-Ereignisse + Medikamenten-Einnahmen) persistieren.
        await persistAttackDetails(saved.id, details, baseData.startTime);
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
  ): UpdatedAttack {
    return {
      startTime: base.startTime,
      endTime: base.endTime ?? null,
      painLevel: base.painLevel,
      notes: details.notes,
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

      {step === 1 ? (
        <AttackForm
          onNext={handleBaseNext}
          title={isEditMode ? 'Attacke bearbeiten' : 'Neue Attacke erfassen'}
          initialStartTime={initialAttack?.startTime}
          initialIsEnded={initialAttack?.endTime != null}
          initialEndTime={initialAttack?.endTime ?? undefined}
          initialPainLevel={initialAttack?.painLevel}
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
