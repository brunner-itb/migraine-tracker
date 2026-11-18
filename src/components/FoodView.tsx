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
 * - Datumsauswahl per Mini-Kalender (Default: heute; Tage mit Einträgen
 *   zeigen einen dezenten Punkt) + Eintragsliste des Tages.
 * - Hinzufügen: Eigenes (dezentes) Tile unter der Eintragskarte –
 *   dient NUR dem Anlegen (kein verdeckter Modus-Wechsel).
 * - Bearbeiten: Der betroffene Eintrag klappt IN-PLATZ zum Formular auf
 *   (indigo-Rahmen, weißer Hintergrund = gleiche Optik wie die Felder,
 *   „Speichern“/„Abbrechen“ direkt daneben).
 *   Der Modus ist jederzeit erkennbar, und „Abbrechen“ schließt ihn
 *   ohne Tab-Wechsel.
 * - Löschen direkt (kleine Einträge, kein ConfirmDialog – bewusst).
 */

/** 'YYYY-MM-DD' von heute (Geräte-Zeitzone). */
function todayDateOnly(): string {
  return new Date().toLocaleDateString('en-CA');
}

/** 'YYYY-MM-DD' für einen konkreten Kalendertag (Geräte-Zeitzone). */
function dateOnly(year: number, month: number, day: number): string {
  return new Date(year, month, day).toLocaleDateString('en-CA');
}

interface CalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/**
 * Zellen des Monatsrasters (Montag zuerst); führende/tailende Tage des
 * Nachbarmonats inklusive, damit volle Wochen entstehen.
 */
function buildMonthCells(year: number, month: number): CalendarCell[] {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const total = Math.ceil((offset + daysInMonth) / 7) * 7;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(year, month, 1 - offset + i);
    cells.push({
      date: d.toLocaleDateString('en-CA'),
      day: d.getDate(),
      inMonth: d.getMonth() === month,
    });
  }
  return cells;
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

/**
 * Gemeinsame Eingabefelder für Hinzufügen- und Bearbeiten-Formular
 * (beide können gleichzeitig sichtbar sein → Feld-IDs werden per
 * `prefix` eindeutig gehalten).
 */
function FoodEntryFields({
  prefix,
  form,
  onChange,
}: {
  prefix: string;
  form: FoodFormState;
  onChange: (patch: Partial<FoodFormState>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`food-name-${prefix}`} className="text-sm font-medium text-gray-700">
          Lebensmittel (Pflicht)
        </label>
        <input
          id={`food-name-${prefix}`}
          list="food-name-suggestions"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="z. B. Pizza, Rotwein, Käse"
          className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`food-category-${prefix}`} className="text-sm font-medium text-gray-700">
          Kategorie
        </label>
        <select
          id={`food-category-${prefix}`}
          value={form.category}
          onChange={(e) =>
            onChange({ category: e.target.value as FoodCategory })
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
          <label htmlFor={`food-time-${prefix}`} className="text-sm font-medium text-gray-700">
            Uhrzeit (optional)
          </label>
          <input
            id={`food-time-${prefix}`}
            type="time"
            value={form.time}
            onChange={(e) => onChange({ time: e.target.value })}
            className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`food-quantity-${prefix}`} className="text-sm font-medium text-gray-700">
            Menge (optional)
          </label>
          <input
            id={`food-quantity-${prefix}`}
            type="text"
            value={form.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            placeholder="z. B. 2 Scheiben"
            className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`food-notes-${prefix}`} className="text-sm font-medium text-gray-700">
          Notiz (optional)
        </label>
        <input
          id={`food-notes-${prefix}`}
          type="text"
          value={form.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="z. B. Mittagessen im Büro"
          className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
        />
      </div>
    </div>
  );
}

export function FoodView() {
  const [date, setDate] = useState<string>(todayDateOnly);
  /** Sichtbarer Kalender-Monat (unabhängig vom gewählten Tag navigierbar). */
  const [view, setView] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  /** 'YYYY-MM-DD' der Tage mit Eintrag im sichtbaren Monat (Punkte). */
  const [entryDates, setEntryDates] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<FoodEntry[]>([]);
  const [recentNames, setRecentNames] = useState<string[]>([]);
  // Formular-State: wird vom Hinzufügen-Formular UND vom in-place
  // Bearbeiten-Formular genutzt (maximal ein Eintrag gleichzeitig).
  const [form, setForm] = useState<FoodFormState>(EMPTY_FORM);
  /** id des Eintrags, der gerade in-place bearbeitet wird (null = keiner). */
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

  // Punkte im Kalender: Tage mit Eintrag im sichtbaren Monat laden.
  useEffect(() => {
    let cancelled = false;
    const { year, month } = view;
    const start = dateOnly(year, month, 1);
    const end = dateOnly(year, month, new Date(year, month + 1, 0).getDate());
    void foodRepository
      .getDatesWithEntries(start, end)
      .then((dates) => {
        if (!cancelled) setEntryDates(new Set(dates));
      })
      .catch((err) => {
        console.error('[FoodView] Kalendertage laden fehlgeschlagen:', err);
        if (!cancelled) setEntryDates(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [view]);

  /** Einen Monat im Kalender vor/zurück (±1). */
  function changeMonth(delta: number): void {
    setView(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  /** Form-State -> Repository-Format (date kommt vom ausgewählten Tag). */
  function buildEntryData(): NewFoodEntry {
    return {
      date,
      time: form.time === '' ? null : form.time,
      name: form.name.trim(),
      category: form.category,
      quantity: form.quantity.trim(),
      notes: form.notes.trim(),
    };
  }

  /** Gemeinsame Save-Logik: Write + Reset + Reload (Fehler als Inline-Meldung). */
  async function saveEntry(write: () => Promise<unknown>): Promise<void> {
    setIsSaving(true);
    setError(null);
    try {
      await write();
      setForm(EMPTY_FORM);
      setEditingId(null);
      await loadEntries();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }

  /** Hinzufügen-Formular: legt immer einen NEUEN Eintrag an. */
  function handleAddSubmit(e: FormEvent): void {
    e.preventDefault();
    if (form.name.trim() === '' || isSaving) return;
    void saveEntry(() => foodRepository.addFoodEntry(buildEntryData()));
  }

  /** In-place Bearbeiten-Formular: speichert den geöffneten Eintrag. */
  function handleEditSubmit(e: FormEvent): void {
    e.preventDefault();
    if (form.name.trim() === '' || isSaving || editingId === null) return;
    const id = editingId;
    void saveEntry(() => foodRepository.updateFoodEntry(id, buildEntryData()));
  }

  async function handleDelete(id: number): Promise<void> {
    await foodRepository.deleteFoodEntry(id);
    if (editingId === id) {
      setForm(EMPTY_FORM);
      setEditingId(null);
    }
    await loadEntries();
  }

  /** Eintrag zum Bearbeiten aufklappen (erneuter Tap = aufklappen). */
  function startEdit(entry: FoodEntry): void {
    if (entry.id === undefined) return;
    setForm({
      name: entry.name,
      category: entry.category,
      time: entry.time ?? '',
      quantity: entry.quantity,
      notes: entry.notes,
    });
    setEditingId(entry.id);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  function handleDateChange(value: string): void {
    // Tag-Wechsel: offene Bearbeitung verwerfen (Eintrag gehört zum alten Tag).
    if (editingId !== null) cancelEdit();
    setDate(value);
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

        {/* Mini-Kalender: Tag wählen; Tage mit Eintrag zeigen einen
            dezenten Punkt. (Native <input type="date"> ersetzt – deren
            Popup lässt sich nicht um solche Marker erweitern.) */}
        <div className="mt-4" role="group" aria-label="Datum wählen">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700">
              {new Date(view.year, view.month, 1).toLocaleDateString('de-DE', {
                month: 'long',
                year: 'numeric',
              })}
            </p>
            <div className="flex items-center gap-1">
              {!(view.year === new Date().getFullYear() &&
                view.month === new Date().getMonth()) && (
                <button
                  type="button"
                  onClick={() => {
                    const now = new Date();
                    setView({ year: now.getFullYear(), month: now.getMonth() });
                  }}
                  className="min-h-9 rounded-lg px-2 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                >
                  Heute
                </button>
              )}
              <button
                type="button"
                onClick={() => changeMonth(-1)}
                aria-label="Vorheriger Monat"
                className="flex min-h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => changeMonth(1)}
                aria-label="Nächster Monat"
                className="flex min-h-9 w-9 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((w) => (
              <p
                key={w}
                className="pb-1 text-center text-[11px] font-medium text-gray-400"
              >
                {w}
              </p>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {buildMonthCells(view.year, view.month).map((cell) => {
              const isSelected = cell.date === date;
              const isToday = cell.date === todayDateOnly();
              const hasEntry = entryDates.has(cell.date);
              return (
                <button
                  key={cell.date}
                  type="button"
                  onClick={() => handleDateChange(cell.date)}
                  aria-pressed={isSelected}
                  aria-label={`${cell.day}. ${
                    new Date(view.year, view.month, 1).toLocaleDateString(
                      'de-DE',
                      { month: 'long' },
                    )
                  }${hasEntry ? ', Eintrag vorhanden' : ''}`}
                  className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg
                    ${
                      isSelected
                        ? 'bg-indigo-600 font-semibold text-white'
                        : isToday
                          ? 'bg-indigo-50 font-semibold text-indigo-700'
                          : cell.inMonth
                            ? 'text-gray-700 hover:bg-gray-100'
                            : 'text-gray-300 hover:bg-gray-100'
                    }`}
                >
                  <span className="text-sm leading-none">{cell.day}</span>
                  {/* Punkt = Eintrag an diesem Tag (leerer Platzhalter,
                      damit die Zellenhöhe konstant bleibt). */}
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      hasEntry
                        ? isSelected
                          ? 'bg-white'
                          : 'bg-indigo-400'
                        : 'bg-transparent'
                    }`}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </div>

        {/* Autocomplete für beide Formulare (Name-Referenz per ID). */}
        <datalist id="food-name-suggestions">
          {recentNames.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>

        {/* Einträge des Tages */}
        <div className="mt-4 flex flex-col gap-2">
          {entries.length === 0 && (
            <p className="text-sm text-gray-400">Keine Einträge an diesem Tag.</p>
          )}
          {entries.map((entry) => {
            const isEditing = editingId === entry.id;
            return (
              <div
                key={entry.id}
                className={
                  isEditing
                    ? 'rounded-xl border border-indigo-300 bg-white p-3'
                    : 'flex items-center justify-between gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5'
                }
              >
                {isEditing ? (
                  /* Bearbeiten: Eintrag klappt in-place zum Formular auf –
                     indigo-Rahmen, Hintergrund weiß wie die Felder (Modus
                     bleibt über den Rahmen erkennbar), „Abbrechen“ daneben. */
                  <form onSubmit={handleEditSubmit} className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-indigo-900">
                        Eintrag bearbeiten
                      </p>
                      <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800">
                        {FOOD_CATEGORY_LABELS[form.category]}
                      </span>
                    </div>
                    <FoodEntryFields
                      prefix="edit"
                      form={form}
                      onChange={(patch) => setForm({ ...form, ...patch })}
                    />
                    {error && <p className="text-sm text-rose-600">{error}</p>}
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={isSaving || form.name.trim() === ''}
                        className="min-h-11 flex-1 rounded-xl bg-indigo-600 px-4 text-base font-semibold text-white disabled:opacity-60"
                      >
                        Speichern
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="min-h-11 rounded-xl border border-gray-300 bg-white px-4 text-base font-medium text-gray-700"
                      >
                        Abbrechen
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">
                        {entry.time !== null ? `${entry.time}  ` : ''}
                        {entry.name}
                      </p>
                      <p className="truncate text-xs text-gray-500">
                        {FOOD_CATEGORY_LABELS[entry.category]}
                        {entry.quantity !== '' ? ` · ${entry.quantity}` : ''}
                        {entry.notes !== '' ? ` – ${entry.notes}` : ''}
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
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Hinzufügen als eigenes, dezentes Tile unter der Eintragskarte
          (dient NUR dem Anlegen – Bearbeiten erfolgt in-place in der
          Liste). Wird während einer offenen Bearbeitung ausgeblendet:
          Beide Formulare teilen denselben Form-State – so kann nicht
          versehentlich ein Duplikat angelegt werden, während ein Eintrag
          bearbeitet wird. */}
      {editingId === null && (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <form onSubmit={handleAddSubmit} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-gray-700">
              Eintrag hinzufügen
            </h3>
            <FoodEntryFields
              prefix="add"
              form={form}
              onChange={(patch) => setForm({ ...form, ...patch })}
            />
            {error && <p className="text-sm text-rose-600">{error}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isSaving || form.name.trim() === ''}
                className="min-h-11 flex-1 rounded-xl bg-indigo-600 px-4 text-base font-semibold text-white disabled:opacity-60"
              >
                Hinzufügen
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
