import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { db } from '../db/database';
import type { LocationMode, UserSettings } from '../db/types';
import {
  settingsRepository,
  type SavedLocation,
} from '../repositories/settingsRepository';
import { attackRepository } from '../repositories/attackRepository';
import { getPositionWithTimeout, GPS_TIMEOUT_MS } from '../services/locationService';
import { searchLocations, type GeocodingResult } from '../services/geocodingService';
import {
  createDataExport,
  downloadDataExport,
  importDataExport,
  parseDataExport,
  type DataExport,
} from '../services/dataTransferService';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * SettingsView – Einstellungen-Tab (Standort-Card).
 *
 * Presentation + eigene DB-Zugriffe über settingsRepository/attackRepository
 * (wie die anderen Views).
 *
 * Standort-Card:
 *  - Status: fester Standort oder GPS-Hinweis
 *  - Fallback-Anzeige: zuletzt bekannter Standort (read-only)
 *  - Onboarding-Hinweis, wenn noch KEIN Standort bekannt ist
 *  - Modus-Auswahl (gps-first (Default) | fixed-first), sofort gespeichert
 *  - Stadtsuche (Open-Meteo Geocoding) + „Gerätestandort übernehmen“
 *  - Nach Standortwechsel: optionales Bulk-Re-Fetch aller Wetterdaten
 *    (explizite Bestätigung via ConfirmDialog)
 *
 * Daten-Card (Export/Import, bewusst einfach gehalten):
 *  - Export: ALLE Tabellen als eine JSON-Datei (Download).
 *  - Import: JSON-Datei -> Validierung -> Bestätigung (ConfirmDialog) ->
 *    ALLE Daten werden ersetzt (Backup-/Restore-Semantik, z. B. neues Gerät).
 */

/** 'YYYY-MM-DDTHH:mm…' (ISO) -> 'TT.MM.JJ, HH:mm' (de-DE). */
function formatLastKnown(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function SettingsView() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeocodingResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [refetchProgress, setRefetchProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /** Für den ConfirmDialog: Standort, mit dem neu gefetcht werden soll. */
  const [refetchTarget, setRefetchTarget] = useState<SavedLocation | null>(null);
  /** Ergebniszeile nach abgeschlossenem Re-Fetch. */
  const [refetchResult, setRefetchResult] = useState<string | null>(null);
  /** Fehlermeldung für GPS-Übernahme/Speichern (bleibt bedienbar). */
  const [gpsError, setGpsError] = useState<string | null>(null);

  // --- Daten-Export/-Import -------------------------------------------------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  /** Statuszeile (Erfolg/Fehler) nach Export oder Import. */
  const [transferStatus, setTransferStatus] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);
  /** Validierte Export-Datei, deren Import gerade bestätigt wird (null = kein Dialog). */
  const [importCandidate, setImportCandidate] = useState<DataExport | null>(null);

  // Beim Mount: Settings-Zeile laden (wird bei Bedarf angelegt).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await settingsRepository.getSettings();
      if (!cancelled) setSettings(s);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hasFixed = settings !== null && settings.latitude !== null;
  const hasLastKnown = settings !== null && settings.lastKnownLatitude !== null;
  /** Buttons gesperrt, solange ein Speichern oder Re-Fetch läuft. */
  const isBusy = isSaving || refetchProgress !== null;

  /** Frische Settings-Zeile nach einem Write laden (updatedAt, …). */
  async function reloadSettings(): Promise<void> {
    setSettings(await settingsRepository.getSettings());
  }

  // --- Stadtsuche ----------------------------------------------------------

  async function handleSearch(): Promise<void> {
    if (isBusy || isSearching) return;
    setIsSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const found = await searchLocations(query);
      setResults(found);
      if (found.length === 0) {
        setSearchError(`Keine Treffer für „${query.trim()}“.`);
      }
    } catch (err) {
      console.error('[SettingsView] Stadtsuche fehlgeschlagen:', err);
      setSearchError('Stadtsuche fehlgeschlagen (offline?). Bitte versuche es erneut.');
    } finally {
      setIsSearching(false);
    }
  }

  // --- Standort setzen / entfernen ------------------------------------------

  /**
   * Speichert einen festen Standort (Suchtreffer oder GPS) und bietet danach
   * das optionale Bulk-Re-Fetch an (ConfirmDialog).
   */
  async function saveLocation(loc: SavedLocation): Promise<void> {
    if (refetchProgress !== null) return;
    setIsSaving(true);
    setGpsError(null);
    try {
      await settingsRepository.setLocation(loc);
      await reloadSettings();
      setRefetchResult(null);
      setRefetchTarget(loc); // -> ConfirmDialog „Wetterdaten neu laden?“
    } catch (err) {
      console.error('[SettingsView] Standort speichern fehlgeschlagen:', err);
      setGpsError('Der Standort konnte nicht gespeichert werden. Bitte versuche es erneut.');
    } finally {
      setIsSaving(false);
    }
  }

  /** „Gerätestandort übernehmen“ (GPS, 5 s, blockiert nie). */
  async function handleUseGps(): Promise<void> {
    if (isBusy) return;
    setIsSaving(true);
    setGpsError(null);
    const gps = await getPositionWithTimeout(GPS_TIMEOUT_MS);
    if (gps === undefined) {
      setGpsError('Gerätestandort konnte nicht ermittelt werden (Permission/Offline?).');
      setIsSaving(false);
      return;
    }
    await saveLocation({ name: 'Gerätestandort (aktuell)', ...gps });
  }

  /**
   * Festen Standort entfernen (zurück zu GPS). Kein Re-Fetch-Dialog:
   * alte Wetterzeilen behalten bewusst ihre Koordinaten.
   */
  async function handleClearLocation(): Promise<void> {
    if (isBusy) return;
    setIsSaving(true);
    setGpsError(null);
    try {
      await settingsRepository.clearLocation();
      await reloadSettings();
      setRefetchResult(null);
      setRefetchTarget(null);
    } catch (err) {
      console.error('[SettingsView] Standort entfernen fehlgeschlagen:', err);
      setGpsError('Der Standort konnte nicht entfernt werden. Bitte versuche es erneut.');
    } finally {
      setIsSaving(false);
    }
  }

  // --- Modus-Auswahl ----------------------------------------------------------

  /** Moduswechsel sofort persistieren (invalidiert keine Wetterdaten). */
  async function handleModeChange(mode: LocationMode): Promise<void> {
    if (settings === null || settings.locationMode === mode) return;
    try {
      await settingsRepository.setLocationMode(mode);
      setSettings({ ...settings, locationMode: mode, updatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[SettingsView] Modus ändern fehlgeschlagen:', err);
      setGpsError('Der Modus konnte nicht geändert werden. Bitte versuche es erneut.');
    }
  }

  // --- Bulk-Re-Fetch ----------------------------------------------------------

  async function runRefetch(loc: SavedLocation): Promise<void> {
    setRefetchProgress({ done: 0, total: 0 });
    const attacks = await db.attacks.count();
    setRefetchProgress({ done: 0, total: attacks });
    const res = await attackRepository.refetchAllWeather(
      { latitude: loc.latitude, longitude: loc.longitude },
      (done, total) => setRefetchProgress({ done, total }),
    );
    setRefetchProgress(null);
    setRefetchResult(`${res.succeeded} von ${res.attempted} Wetterdaten neu geladen.`);
  }

  // --- Daten-Export/-Import -------------------------------------------------

  /** Alle Tabellen als JSON-Datei herunterladen (iOS-Safari: <a download>). */
  async function handleExport(): Promise<void> {
    if (isExporting || isImporting) return;
    setIsExporting(true);
    setTransferStatus(null);
    try {
      const exp = await createDataExport();
      downloadDataExport(exp);
      setTransferStatus({
        kind: 'success',
        text: 'JSON-Datei wurde zum Download gestartet.',
      });
    } catch (err) {
      console.error('[SettingsView] Daten-Export fehlgeschlagen:', err);
      setTransferStatus({
        kind: 'error',
        text: 'Export fehlgeschlagen. Bitte versuche es erneut.',
      });
    } finally {
      setIsExporting(false);
    }
  }

  /** Datei-Selection: lesen + validieren -> Bestätigungs-Dialog. */
  async function handleImportFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // gleiche Datei erneut wählbar machen
    if (file === undefined) return;
    setTransferStatus(null);
    try {
      const exp = parseDataExport(await file.text());
      setImportCandidate(exp);
    } catch (err) {
      console.error('[SettingsView] Import-Datei ungültig:', err);
      setTransferStatus({
        kind: 'error',
        text:
          err instanceof Error
            ? `Import-Datei abgelehnt: ${err.message}`
            : 'Import-Datei konnte nicht gelesen werden.',
      });
    }
  }

  /** Bestätigter Import: ALLE Daten ersetzen (atomar, Rollback bei Fehler). */
  async function handleConfirmImport(): Promise<void> {
    if (importCandidate === null || isImporting) return;
    const exp = importCandidate;
    setImportCandidate(null);
    setIsImporting(true);
    setTransferStatus(null);
    try {
      const res = await importDataExport(exp);
      setTransferStatus({
        kind: 'success',
        text:
          `Import abgeschlossen: ${res.attacks} Attacken, ` +
          `${res.cycleEvents} Zyklus-Events, ${res.medications} Medikamente, ` +
          `${res.weatherData} Wetterdaten übernommen.`,
      });
    } catch (err) {
      console.error('[SettingsView] Daten-Import fehlgeschlagen:', err);
      setTransferStatus({
        kind: 'error',
        text: 'Import fehlgeschlagen. Die vorhandenen Daten wurden nicht verändert.',
      });
    } finally {
      setIsImporting(false);
    }
  }

  // --- Rendern ----------------------------------------------------------

  return (
    <div className="flex flex-col gap-4">
      {/* Standort-Card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">Standort</h2>
        <p className="mt-1 text-sm text-gray-600">
          Für den Luftdruck-Abruf jeder Attacke.
        </p>

        {settings === null ? (
          <p className="mt-4 text-sm text-gray-500">Einstellungen werden geladen …</p>
        ) : (
          <>
            {/* Status */}
            <div className="mt-4">
              {hasFixed ? (
                <>
                  <p className="text-sm text-gray-800">
                    Fester Standort: <strong>{settings.locationName}</strong> –
                    alle neuen Attacken nutzen diesen Standort.
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleClearLocation()}
                    disabled={isBusy}
                    className="mt-3 min-h-11 w-full rounded-xl border border-rose-200 bg-rose-50 px-4 text-base font-semibold text-rose-700 disabled:opacity-60"
                  >
                    Festen Standort entfernen
                  </button>
                </>
              ) : (
                <p className="text-sm text-gray-800">
                  Kein fester Standort – beim Erfassen wird der Gerätestandort
                  (GPS) verwendet.
                </p>
              )}
            </div>

            {/* Onboarding-Hinweis: noch kein Standort bekannt */}
            {!hasFixed && !hasLastKnown && (
              <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Noch ist kein Standort bekannt. Ohne Standort bekommt eine
                Attacke keine Wetterdaten. Tippe auf „Gerätestandort
                übernehmen“ oder suche deine Stadt, damit JEDER Attacke ein
                Standort zugeordnet wird.
              </div>
            )}

            {/* Fallback-Standort (read-only) */}
            {hasLastKnown && (
              <p className="mt-3 text-xs text-gray-500">
                Fallback-Standort (zuletzt ermittelt): {settings.lastKnownLatitude},{' '}
                {settings.lastKnownLongitude}
                {settings.lastKnownAt !== null && (
                  <> am {formatLastKnown(settings.lastKnownAt)}</>
                )}
              </p>
            )}

            {/* Standort-Quelle (Modus-Auswahl) */}
            <fieldset className="mt-5">
              <legend className="text-sm font-medium text-gray-700">
                Standort-Quelle
              </legend>
              <div className="mt-2 flex flex-col gap-2">
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-gray-200 px-3 py-2.5 hover:bg-gray-50">
                  <input
                    type="radio"
                    name="locationMode"
                    value="gps-first"
                    checked={settings.locationMode === 'gps-first'}
                    onChange={() => void handleModeChange('gps-first')}
                    disabled={isBusy}
                    className="mt-0.5 h-5 w-5 accent-indigo-600"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">
                      Live-GPS bevorzugt (Standard)
                    </span>
                    <span className="block text-xs text-gray-500">
                      GPS wird zuerst abgefragt (Prompt + max. 5 s); der feste
                      Standort dient als Fallback.
                    </span>
                  </span>
                </label>
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-gray-200 px-3 py-2.5 hover:bg-gray-50">
                  <input
                    type="radio"
                    name="locationMode"
                    value="fixed-first"
                    checked={settings.locationMode === 'fixed-first'}
                    onChange={() => void handleModeChange('fixed-first')}
                    disabled={isBusy}
                    className="mt-0.5 h-5 w-5 accent-indigo-600"
                  />
                  <span>
                    <span className="block text-sm font-medium text-gray-900">
                      Fester Standort bevorzugt
                    </span>
                    <span className="block text-xs text-gray-500">
                      Ein gesetzter fester Standort wird ohne GPS-Prompt
                      verwendet.
                    </span>
                  </span>
                </label>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                Ohne fester Standort gilt GPS zuerst in beiden Modi.
              </p>
            </fieldset>

            {/* Stadtsuche */}
            <div className="mt-5">
              <label
                htmlFor="location-search"
                className="block text-sm font-medium text-gray-700"
              >
                Stadt suchen
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="location-search"
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSearch();
                    }
                  }}
                  placeholder="z. B. Hamburg"
                  disabled={isBusy}
                  className="min-h-11 w-full flex-1 rounded-lg border border-gray-300 px-3 py-2 text-base"
                />
                <button
                  type="button"
                  onClick={() => void handleSearch()}
                  disabled={isBusy || isSearching || query.trim().length < 2}
                  className="min-h-11 shrink-0 rounded-lg bg-indigo-600 px-4 text-base font-semibold text-white disabled:opacity-60"
                >
                  {isSearching ? 'Suche …' : 'Suchen'}
                </button>
              </div>

              {searchError && (
                <p className="mt-2 text-sm text-rose-600">{searchError}</p>
              )}

              {results.length > 0 && (
                <ul className="mt-2 divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200">
                  {results.map((r) => (
                    <li
                      key={`${r.displayName}-${r.latitude.toFixed(4)}-${r.longitude.toFixed(4)}`}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          void saveLocation({
                            name: r.displayName,
                            latitude: r.latitude,
                            longitude: r.longitude,
                          })
                        }
                        disabled={isBusy}
                        className="flex min-h-11 w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-indigo-50 disabled:opacity-60"
                      >
                        <span className="text-sm font-medium text-gray-900">
                          {r.displayName}
                        </span>
                        <span className="text-xs text-gray-500">
                          {r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Gerätestandort übernehmen */}
            <button
              type="button"
              onClick={() => void handleUseGps()}
              disabled={isBusy}
              className="mt-4 min-h-11 w-full rounded-xl border border-indigo-200 bg-indigo-50 px-4 text-base font-semibold text-indigo-700 disabled:opacity-60"
            >
              {isSaving ? 'Wird gespeichert …' : 'Gerätestandort übernehmen'}
            </button>

            {gpsError && (
              <p role="alert" className="mt-2 text-sm text-rose-600">
                {gpsError}
              </p>
            )}

            {/* Re-Fetch-Fortschritt + Ergebnis */}
            {refetchProgress !== null && (
              <p className="mt-3 text-sm text-indigo-700">
                Wetterdaten werden neu geladen … {refetchProgress.done}/
                {refetchProgress.total}
              </p>
            )}
            {refetchResult !== null && refetchProgress === null && (
              <p className="mt-3 text-sm text-emerald-700">{refetchResult}</p>
            )}
          </>
        )}
      </div>

      {/* Daten-Card (Export/Import) */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">Daten</h2>
        <p className="mt-1 text-sm text-gray-600">
          Backup als JSON-Datei: exportieren zum Sichern oder Übertragen auf
          ein anderes Gerät, importieren zum Wiederherstellen.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={isExporting || isImporting}
            className="min-h-11 w-full rounded-xl bg-indigo-600 px-4 text-base font-semibold text-white disabled:opacity-60"
          >
            {isExporting ? 'Wird exportiert …' : 'Daten exportieren (JSON)'}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isExporting || isImporting}
            className="min-h-11 w-full rounded-xl border border-indigo-200 bg-indigo-50 px-4 text-base font-semibold text-indigo-700 disabled:opacity-60"
          >
            Daten importieren (JSON)
          </button>
          {/* Versteckter Datei-Picker (iOS-Safari: nur über Button-Click öffnen). */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Import-Datei auswählen (JSON)"
            onChange={(e) => void handleImportFile(e)}
          />
        </div>

        {transferStatus !== null && (
          <p
            role={transferStatus.kind === 'error' ? 'alert' : 'status'}
            className={`mt-3 text-sm ${
              transferStatus.kind === 'error'
                ? 'text-rose-600'
                : 'text-emerald-700'
            }`}
          >
            {transferStatus.text}
          </p>
        )}
      </div>

      {/* Re-Fetch-Bestätigung */}
      <ConfirmDialog
        open={refetchTarget !== null}
        title="Wetterdaten neu laden?"
        message="Der Standort wurde geändert. Soll der Luftdruck für alle Attacken mit dem neuen Standort neu abgerufen werden? Das kann einige Minuten dauern und läuft im Hintergrund weiter."
        confirmLabel="Neu laden"
        cancelLabel="Später"
        onConfirm={() => {
          if (refetchTarget === null) return;
          const target = refetchTarget;
          setRefetchTarget(null);
          void runRefetch(target);
        }}
        onCancel={() => setRefetchTarget(null)}
      />

      {/* Import-Bestätigung */}
      <ConfirmDialog
        open={importCandidate !== null}
        title="Daten importieren?"
        message={
          importCandidate !== null ? (
            <>
              Die Datei enthält{' '}
              <strong>{importCandidate.data.attacks.length} Attacken</strong>,{' '}
              {importCandidate.data.cycleEvents.length} Zyklus-Events,{' '}
              {importCandidate.data.medications.length} Medikamente und{' '}
              {importCandidate.data.weatherData.length} Wetterdaten
              {` (exportiert am ${formatLastKnown(importCandidate.exportedAt)})`}.
              <br />
              <br />
              <strong>
                Alle vorhandenen Daten in dieser App (inkl. Standort-Einstellungen)
                werden ersetzt.
              </strong>{' '}
              Ein vorheriger Export schützt vor Datenverlust.
            </>
          ) : null
        }
        confirmLabel="Importieren"
        cancelLabel="Abbrechen"
        isPending={isImporting}
        onConfirm={() => void handleConfirmImport()}
        onCancel={() => setImportCandidate(null)}
      />
    </div>
  );
}
