import { useCallback, useEffect, useState } from 'react';
import { db } from './db/database';
import type { MigraineAttack } from './db/types';
import { AddAttackWizard } from './components/AddAttackWizard';
import { ConfirmDialog } from './components/ConfirmDialog';
import { StatisticsView } from './components/StatisticsView';
import { exportMonthlyReport } from './components/ReportView';
import {
  analyzeCycleCorrelation,
  analyzePressureCorrelation,
  getChartData,
} from './services/statisticsService';
import { seedMockData } from './utils/generateMockData';
import { attackRepository } from './repositories/attackRepository';
import { settingsRepository } from './repositories/settingsRepository';
import { SettingsView } from './components/SettingsView';
import type {
  ChartDataPoint,
  CycleCorrelationResult,
  PressureCorrelationResult,
} from './services/statisticsService';

type Tab = 'journal' | 'stats' | 'report' | 'settings';

const TYPE_LABELS: Record<MigraineAttack['type'], string> = {
  migraine: 'Migräne',
  tension: 'Spannungskopfschmerz',
  other: 'Sonstiger Kopfschmerz',
};

function painBadgeClass(level: number): string {
  if (level <= 3) return 'bg-emerald-100 text-emerald-800';
  if (level <= 6) return 'bg-amber-100 text-amber-800';
  return 'bg-rose-100 text-rose-800';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function App() {
  const [tab, setTab] = useState<Tab>('journal');
  const [attacks, setAttacks] = useState<MigraineAttack[]>([]);
  const [showWizard, setShowWizard] = useState(false);
  const [editTarget, setEditTarget] = useState<MigraineAttack | null>(null);

  // Lösch-Bestätigung: Attacke, deren Löschung gerade bestätigt wird (null = kein Dialog).
  const [deleteTarget, setDeleteTarget] = useState<MigraineAttack | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Statistik-Daten
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [pressureCorrelation, setPressureCorrelation] =
    useState<PressureCorrelationResult | null>(null);
  const [cycleCorrelation, setCycleCorrelation] =
    useState<CycleCorrelationResult | null>(null);

  // Bericht
  const [reportMonth, setReportMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [reportStatus, setReportStatus] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Temporärer Test-Bereich
  const [isSeeding, setIsSeeding] = useState(false);

  const loadAttacks = useCallback(async () => {
    const rows = await db.attacks.orderBy('startTime').reverse().toArray();
    setAttacks(rows);
  }, []);

  const loadStats = useCallback(async () => {
    const [allAttacks, weather, cycles] = await Promise.all([
      db.attacks.toArray(),
      db.weatherData.toArray(),
      db.cycleEvents.toArray(),
    ]);
    setChartData(getChartData(allAttacks, weather, cycles));
    setPressureCorrelation(analyzePressureCorrelation(allAttacks, weather));
    setCycleCorrelation(analyzeCycleCorrelation(allAttacks, cycles));
  }, []);

  useEffect(() => {
    void loadAttacks();
  }, [loadAttacks]);

  // Beim App-Start: ausstehende/fehlschlagende Wetterdaten erneut abrufen
  // (Status 'pending'/'error' in weatherData) + Attacken OHNE Wetterzeile
  // backfillen, sobald ein Standort auflösbar ist (Settings -> GPS ->
  // letzter bekannter Standort; blockiert nie).
  useEffect(() => {
    void (async () => {
      const loc = await settingsRepository.resolveLocation();
      const coords = loc
        ? { latitude: loc.latitude, longitude: loc.longitude }
        : undefined;
      await attackRepository.retryMissingWeather(coords);
    })().catch((err) => {
      console.warn('[App] Wetter-Retry beim Start fehlgeschlagen:', err);
    });
  }, []);

  useEffect(() => {
    if (tab === 'stats') void loadStats();
  }, [tab, loadStats]);

  /** Bestätigtes Löschen (nach ConfirmDialog): DB-Löschung + Liste neu laden. */
  async function handleConfirmDelete(): Promise<void> {
    if (deleteTarget === null || isDeleting) return;
    const id = deleteTarget.id;
    if (id === undefined) return;
    setIsDeleting(true);
    try {
      // Kaskade: Wetter-Zeile + Medikamenten-Einnahmen + Attacke (atomar).
      await attackRepository.deleteAttack(id);
      await loadAttacks();
      setDeleteTarget(null);
    } catch (err) {
      console.error('[App] Attacke löschen fehlgeschlagen:', err);
      alert(
        `Löschen fehlgeschlagen:\n${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsDeleting(false);
    }
  }

  function openCreateWizard(): void {
    setEditTarget(null);
    setShowWizard(true);
  }

  function openEditWizard(attack: MigraineAttack): void {
    setEditTarget(attack);
    setShowWizard(true);
  }

  async function handleSeed(): Promise<void> {
    if (isSeeding) return;
    setIsSeeding(true);
    try {
      await seedMockData();
    } catch (err) {
      console.error('[App] seedMockData fehlgeschlagen:', err);
      alert(`Beispieldaten konnten nicht erzeugt werden:\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Neu laden, damit alle Komponenten (Liste, Statistik, Bericht)
      // die frischen Daten aus der Dexie-DB lesen.
      window.location.reload();
    }
  }

  async function handleExportReport(): Promise<void> {
    const [year, month] = reportMonth.split('-').map(Number);
    if (!year || !month) return;
    setIsExporting(true);
    setReportStatus(null);
    try {
      const monthAttacks = attacks.filter((a) => {
        const d = new Date(a.startTime);
        return d.getFullYear() === year && d.getMonth() === month - 1;
      });
      await exportMonthlyReport(monthAttacks, new Date(year, month - 1, 1));
      setReportStatus('PDF-Export erstellt und heruntergeladen.');
    } catch (err) {
      setReportStatus(`Export fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-indigo-600 px-4 pb-3 pt-4 text-white shadow-md [padding-top:max(1rem,env(safe-area-inset-top))]">
        <h1 className="text-lg font-semibold">Migräne Tagebuch</h1>
      </header>

      {/* Inhalt */}
      <main className="flex-1 px-4 pb-24 pt-4">
        {tab === 'journal' && (
          <div className="flex flex-col gap-3">
            {attacks.length === 0 && (
              <p className="mt-10 text-center text-sm text-gray-500">
                Noch keine Attacken erfasst.
                <br />
                Tippe auf „Neue Attacke“, um zu starten.
              </p>
            )}
            {attacks.map((attack) => (
              <article
                key={attack.id}
                role="button"
                tabIndex={0}
                onClick={() => openEditWizard(attack)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEditWizard(attack);
                  }
                }}
                aria-label={`Attacke vom ${formatDate(attack.startTime)} bearbeiten`}
                className="flex cursor-pointer items-start justify-between gap-3 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm
                           transition-colors hover:border-indigo-300
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {formatDate(attack.startTime)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${painBadgeClass(attack.painLevel)}`}
                    >
                      Schmerz {attack.painLevel}/10
                    </span>
                    <span className="text-xs text-gray-500">
                      {TYPE_LABELS[attack.type]}
                    </span>
                    {attack.endTime === null && (
                      <span className="rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-800">
                        läuft noch
                      </span>
                    )}
                  </div>
                  {attack.notes && (
                    <p className="mt-2 line-clamp-2 text-xs text-gray-600">
                      {attack.notes}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditWizard(attack);
                    }}
                    className="min-h-9 rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50"
                  >
                    Bearbeiten
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(attack);
                    }}
                    className="min-h-9 rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-rose-600"
                    aria-label="Attacke löschen"
                  >
                    Löschen
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {tab === 'stats' &&
          (pressureCorrelation && cycleCorrelation ? (
            <StatisticsView
              chartData={chartData}
              pressureCorrelation={pressureCorrelation}
              cycleCorrelation={cycleCorrelation}
            />
          ) : (
            <p className="mt-10 text-center text-sm text-gray-500">
              Statistik wird geladen …
            </p>
          ))}

        {tab === 'settings' && <SettingsView />}

        {tab === 'report' && (
          <div className="flex flex-col gap-4">
            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="text-base font-semibold text-gray-900">
                Arztbericht (PDF)
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                Erzeugt einen Kopfschmerzkalender für den ausgewählten Monat
                inklusive Medikation, Zyklus-Notizen und Luftdruck.
              </p>
              <label className="mt-4 flex flex-col gap-1.5 text-sm font-medium text-gray-700">
                Monat
                <input
                  type="month"
                  value={reportMonth}
                  onChange={(e) => setReportMonth(e.target.value)}
                  className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-base"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleExportReport()}
                disabled={isExporting}
                className="mt-4 min-h-11 w-full rounded-xl bg-indigo-600 px-4 text-base font-semibold text-white disabled:opacity-60"
              >
                {isExporting ? 'Wird erstellt …' : 'PDF-Export erstellen'}
              </button>
              {reportStatus && (
                <p className="mt-3 text-sm text-gray-600">{reportStatus}</p>
              )}
            </div>
          </div>
        )}

        {/* Temporärer Test-Bereich (nach dem Testing wieder entfernen) */}
        <section className="mt-8 rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">
            Testbereich (temporär)
          </h2>
          <p className="mt-1 text-xs text-amber-800">
            Erzeugt realistische Beispieldaten für die letzten 3 Monate
            (Attacken, Medikation, Zyklus, Wetter) in der lokalen Datenbank.
            Nur bei leerer Datenbank – vorhandene Daten bleiben unverändert.
          </p>
          <button
            type="button"
            onClick={() => void handleSeed()}
            disabled={isSeeding}
            className="mt-3 min-h-11 w-full rounded-xl bg-amber-500 px-4 text-base font-semibold text-white disabled:opacity-60"
          >
            {isSeeding
              ? 'Wird generiert … (Wetterabruf kann ~1 Min. dauern)'
              : 'Beispieldaten generieren'}
          </button>
        </section>
      </main>

      {/* Bottom Navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white [padding-bottom:env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-md">
          {(
            [
              ['journal', 'Journal'],
              ['stats', 'Statistik'],
              ['report', 'Bericht'],
              ['settings', 'Einstellungen'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`min-h-14 flex-1 text-sm font-medium ${
                tab === key ? 'text-indigo-600' : 'text-gray-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* FAB: Neue Attacke */}
      {tab === 'journal' && !showWizard && (
        <button
          type="button"
          onClick={openCreateWizard}
          className="fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg [bottom:calc(5.5rem+env(safe-area-inset-bottom))]"
          aria-label="Neue Attacke erfassen"
        >
          {/* SVG statt Text-„+": Textzeichen sitzen optisch nie exakt
              zentriert (Schrift-Metrics); ein Icon ist geometrisch mittig. */}
          <svg
            viewBox="0 0 24 24"
            className="h-7 w-7"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {/* Lösch-Bestätigung */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Attacke löschen?"
        message={
          deleteTarget !== null ? (
            <>
              Die Attacke vom <strong>{formatDate(deleteTarget.startTime)}</strong>{' '}
              (Schmerz {deleteTarget.painLevel}/10, {TYPE_LABELS[deleteTarget.type]}){' '}
              wird endgültig gelöscht. Das kann nicht rückgängig gemacht werden.
            </>
          ) : null
        }
        confirmLabel="Löschen"
        cancelLabel="Abbrechen"
        isPending={isDeleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Wizard als Vollbild-Overlay */}
      {showWizard && (
        <div className="fixed inset-0 z-50 flex flex-col bg-gray-50">
          <div className="flex items-center justify-between bg-indigo-600 px-4 py-3 text-white [padding-top:max(0.75rem,env(safe-area-inset-top))]">
            <h2 className="text-base font-semibold">
              {editTarget ? 'Attacke bearbeiten' : 'Neue Attacke'}
            </h2>
            <button
              type="button"
              onClick={() => {
                setShowWizard(false);
                void loadAttacks();
              }}
              className="min-h-11 rounded-lg px-3 text-sm font-medium"
            >
              Schließen
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <AddAttackWizard
              initialAttack={editTarget}
              onSuccess={() => {
                setShowWizard(false);
                void loadAttacks();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
