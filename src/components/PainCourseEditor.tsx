/**
 * PainCourseEditor – optionaler Schmerzverlauf einer Attacke.
 *
 * Reine Präsentations-Komponente (controlled): Die Einträge leben im
 * Parent (AttackDetailsForm). Eingabe = Liste + Zeitpicker + 1–10-Auswahl
 * (bewusst KEIN Graph als Eingabe). Der Graph ist nur Anzeige
 * (PainCourseChart).
 */

import { PainCourseChart } from './PainCourseChart';

/** Ein Schmerzverlauf-Eintrag im Formular (level 0 = nicht gewählt). */
export interface PainEntryFormData {
  /** Lokale UI-ID (keine DB-ID) für React-Keys. */
  uiId: string;
  /** 'YYYY-MM-DDTHH:mm' (datetime-local-Format, Ortszeit). */
  time: string;
  /** 1–10; 0 = noch nicht gewählt. */
  level: number;
}

interface PainCourseEditorProps {
  entries: PainEntryFormData[];
  onChange: (entries: PainEntryFormData[]) => void;
  /** Attacken-Start (Minimum für den Zeitpicker). */
  startTime: string;
  /** Attacken-Ende (Maximum für den Zeitpicker); null = läuft noch. */
  endTime: string | null;
  /** Schmerzlevel aus dem Hauptfeld (Schritt 1, für Peak-Hinweis). */
  mainLevel: number;
}

/** Date -> 'YYYY-MM-DDTHH:mm' (datetime-local-Format, Ortszeit). */
function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function PainCourseEditor({
  entries,
  onChange,
  startTime,
  endTime,
  mainLevel,
}: PainCourseEditorProps) {
  // Zeitpicker-Grenzen: Einträge dürfen nicht vor dem Start liegen
  // (nach dem Ende ist erlaubt – Nachwehen).
  const min = startTime;
  const max = endTime ?? undefined;

  function addEntry() {
    // Default: 60 Minuten nach dem letzten Eintrag bzw. nach dem Start.
    const last = entries[entries.length - 1];
    const baseMs = last
      ? new Date(last.time).getTime()
      : new Date(startTime).getTime();
    const next = new Date(baseMs + 60 * 60 * 1000);
    onChange([
      ...entries,
      { uiId: crypto.randomUUID(), time: toLocalInputValue(next), level: 0 },
    ]);
  }

  function updateEntry(uiId: string, patch: Partial<PainEntryFormData>) {
    onChange(entries.map((e) => (e.uiId === uiId ? { ...e, ...patch } : e)));
  }

  function removeEntry(uiId: string) {
    onChange(entries.filter((e) => e.uiId !== uiId));
  }

  const peak = Math.max(mainLevel, ...entries.map((e) => e.level));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-gray-700">Schmerzverlauf</h2>
          <p className="text-xs text-gray-500">
            Optional: Schmerzstärke zu späteren Zeitpunkten der Attacke.
          </p>
        </div>
        <button
          type="button"
          onClick={addEntry}
          className="flex min-h-11 items-center rounded-lg border border-sky-300 bg-sky-50
                     px-3 text-sm font-medium text-sky-700
                     transition-colors hover:bg-sky-100
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          + Zeitpunkt
        </button>
      </div>

      {entries.length > 0 && (
        <PainCourseChart mainLevel={mainLevel} entries={entries} />
      )}

      {entries.length > 0 && (
        <ul className="flex flex-col gap-3">
          {entries.map((e, i) => (
            <li key={e.uiId} className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-500">{i + 1}</span>
                <input
                  type="datetime-local"
                  value={e.time}
                  min={min}
                  max={max}
                  onChange={(ev) => updateEntry(e.uiId, { time: ev.target.value })}
                  aria-label={`Zeitpunkt ${i + 1}`}
                  className="h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base
                             focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
                />
                <button
                  type="button"
                  onClick={() => removeEntry(e.uiId)}
                  aria-label={`Zeitpunkt ${i + 1} entfernen`}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-red-600
                             hover:bg-red-50 focus:outline-none focus-visible:ring-2
                             focus-visible:ring-red-400"
                >
                  ✕
                </button>
              </div>

              <div
                role="radiogroup"
                aria-label={`Schmerzstärke ${i + 1}`}
                className="grid grid-cols-5 gap-1.5"
              >
                {LEVELS.map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    role="radio"
                    aria-checked={e.level === lv}
                    onClick={() => updateEntry(e.uiId, { level: lv })}
                    className={`h-11 rounded-lg text-sm font-semibold transition-colors
                                focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
                                ${
                                  e.level === lv
                                    ? 'bg-sky-600 text-white shadow-sm'
                                    : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-100'
                                }`}
                  >
                    {lv}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {entries.length > 0 && (
        <p className="text-xs text-gray-500">
          Gespicher wird der höchste Wert als Gesamtschmerz (aktuell {peak}/10).
          Die Statistik nutzt diesen Peak.
        </p>
      )}
    </section>
  );
}
