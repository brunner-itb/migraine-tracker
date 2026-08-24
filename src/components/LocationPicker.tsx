/**
 * LocationPicker – optionaler, manuell setzbarer Standort für eine Attacke.
 *
 * UI-Design (Progressive Disclosure, bleibt im Normalfall auf einer Zeile):
 *
 *  1. "Automatisch" (Default):
 *     Graue Zeile "Automatisch (GPS / Einstellungen)" + Button "Festlegen".
 *  2. Editor (aufgeklappt):
 *     Ortssuche (Open-Meteo-Geocoding) mit Trefferliste + Button
 *     "Gerätestandort übernehmen" (GPS).
 *  3. Custom-Standort gesetzt:
 *     Indigo-Karte mit Pin, Ortsname + Koordinaten + Buttons "Ändern"
 *     (öffnet den Editor) und "Entfernen" (kehrt zu "Automatisch" zurück).
 *
 * Der Picker ist selbständig: Er kapselt Geocoding (searchLocations) und
 * GPS (getPositionWithTimeout) und meldet die Auswahl nach oben als
 * `AttackLocation | null`. Keine DB-/Repository-Zugriffe.
 */

import { useState, type FormEvent } from 'react';
import type { AttackLocation } from '../db/types';
import { getPositionWithTimeout, GPS_TIMEOUT_MS } from '../services/locationService';
import { searchLocations, type GeocodingResult } from '../services/geocodingService';

export interface LocationPickerProps {
  /** Aktueller Custom-Standort; null = automatisch (Einstellungen/GPS). */
  value: AttackLocation | null;
  /** onChange(null) = Custom-Standort entfernen (zurück auf automatisch). */
  onChange: (location: AttackLocation | null) => void;
}

/** Kleine Pin-Icon (Heroicons "map-pin", Outline) – inline statt Emoji. */
function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
      />
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
      />
    </svg>
  );
}

export function LocationPicker({ value, onChange }: LocationPickerProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  /** Auswahl bestätigen: Picker klappen, Eingaben zurücksetzen. */
  const select = (loc: AttackLocation) => {
    onChange(loc);
    setExpanded(false);
    setQuery('');
    setResults([]);
    setSearchError(null);
    setGpsError(null);
  };

  /** Ortssuche ausführen (Enter oder Button). */
  const runSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = query.trim();
    if (q.length === 0 || isSearching) return;
    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const found = await searchLocations(q);
      setResults(found);
      if (found.length === 0) {
        setSearchError('Keine Treffer – bitte anderen Ort versuchen.');
      }
    } catch {
      setSearchError('Ortssuche fehlgeschlagen – bitte Internet-Verbindung prüfen.');
    } finally {
      setIsSearching(false);
    }
  };

  /** Aktuellen GPS-Standort als Custom-Standort übernehmen. */
  const useGps = async () => {
    if (gpsLoading) return;
    setGpsLoading(true);
    setGpsError(null);
    // getPositionWithTimeout löst IMMER auf (niemals reject): undefined bei
    // Ablehnung/Timeout/Fehler -> hier als Fehlermeldung anzeigen.
    const gps = await getPositionWithTimeout(GPS_TIMEOUT_MS);
    if (gps === undefined) {
      setGpsError('Standort konnte nicht ermittelt werden (GPS deaktiviert oder kein Signal).');
    } else {
      select({
        name: 'Gerätestandort (aktuell)',
        latitude: gps.latitude,
        longitude: gps.longitude,
      });
    }
    setGpsLoading(false);
  };

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium text-slate-700">Standort</h2>

      {value ? (
        // --- Custom-Standort gesetzt -------------------------------------
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <PinIcon className="h-5 w-5 shrink-0 text-indigo-600" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{value.name}</p>
                <p className="text-xs text-slate-500">
                  {value.latitude.toFixed(4)}, {value.longitude.toFixed(4)}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-100"
              >
                {expanded ? 'Ausblenden' : 'Ändern'}
              </button>
              <button
                type="button"
                onClick={() => onChange(null)}
                className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-rose-600 active:bg-rose-50"
              >
                Entfernen
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            Wetterdaten werden für diesen Ort abgerufen.
          </p>
        </div>
      ) : (
        // --- Automatisch (Default) ---------------------------------------
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
          <p className="text-sm text-slate-500">Automatisch (GPS / Einstellungen)</p>
          <button
            type="button"
            onClick={() => {
              setExpanded((v) => !v);
              setSearchError(null);
              setGpsError(null);
            }}
            className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm font-medium text-indigo-600 active:bg-indigo-50"
          >
            {expanded ? 'Ausblenden' : 'Festlegen'}
          </button>
        </div>
      )}

      {expanded && (
        // --- Editor: Suche + GPS ------------------------------------------
        <div className="space-y-2.5 border-t border-slate-100 pt-2.5">
          <form onSubmit={runSearch} className="flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Ort oder Stadt suchen…"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
            />
            <button
              type="submit"
              disabled={isSearching || query.trim().length === 0}
              className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white active:bg-indigo-700 disabled:opacity-50"
            >
              {isSearching ? 'Suche…' : 'Suchen'}
            </button>
          </form>

          {searchError && <p className="text-xs text-rose-600">{searchError}</p>}

          {results.length > 0 && (
            <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {results.map((r) => (
                <li key={`${r.name}|${r.latitude}|${r.longitude}`}>
                  <button
                    type="button"
                    onClick={() =>
                      select({ name: r.name, latitude: r.latitude, longitude: r.longitude })
                    }
                    className="w-full px-3 py-2.5 text-left active:bg-indigo-50"
                  >
                    <span className="block truncate text-sm font-medium text-slate-700">
                      {r.displayName}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {r.latitude.toFixed(4)}, {r.longitude.toFixed(4)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button
            type="button"
            onClick={useGps}
            disabled={gpsLoading}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 active:bg-slate-50 disabled:opacity-50"
          >
            {gpsLoading ? 'Standort wird ermittelt…' : 'Gerätestandort übernehmen (GPS)'}
          </button>

          {gpsError && <p className="text-xs text-rose-600">{gpsError}</p>}
        </div>
      )}
    </section>
  );
}
