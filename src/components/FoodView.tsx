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
