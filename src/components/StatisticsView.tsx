import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  ChartDataPoint,
  CycleCorrelationResult,
  FoodAnalysisResult,
  PressureCorrelationResult,
} from '../services/statisticsService';
import { FOOD_CATEGORY_LABELS } from '../services/statisticsService';

/**
 * StatisticsView – Statistiken-Ansicht (Schritt 5).
 *
 * Reiner Presentation Layer: Die Komponente berechnet NICHTS selbst,
 * sondern rendert die vorab berechneten Ergebnisse des
 * statisticsService (getChartData, analyzePressureCorrelation,
 * analyzeCycleCorrelation).
 *
 * Layout:
 *  - Zwei Infokarten (Summary-Texte: Druck-Korrelation, Zyklus/PMS).
 *  - ComposedChart (Recharts):
 *      linke Y-Achse  -> Schmerz 1–10 als Balken,
 *                        PMS-/Regel-Tage farblich hervorgehoben (Cell)
 *      rechte Y-Achse -> Luftdruck (hPa) als durchgehende Linie
 *                        (Lücken bei noch fehlenden Wetterdaten)
 *
 * Hinweis: Die Komponente nutzt absichtlich weder `pValue` noch andere
 * Statistik-Details – sie bleibt damit stabil, wenn sich die
 * statisticsService-Interfaces weiterentwickeln.
 */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StatisticsViewProps {
  /** Ergebnis von getChartData() – flach, aufsteigend nach Startzeit. */
  chartData: ChartDataPoint[];
  /** Ergebnis von analyzePressureCorrelation(). */
  pressureCorrelation: PressureCorrelationResult;
  /** Ergebnis von analyzeCycleCorrelation(). */
  cycleCorrelation: CycleCorrelationResult;
  /** Ergebnis von analyzeFoodCorrelation(). */
  foodAnalysis: FoodAnalysisResult;
}

// ---------------------------------------------------------------------------
// Farben (Tailwind-Palette; als Konstanten, da Recharts keine
// Tailwind-Klassen für Striche/Füllungen versteht)
// ---------------------------------------------------------------------------

const PAIN_COLOR = '#f43f5e'; // rose-500
const PMS_COLOR = '#a855f7'; // purple-500
const PRESSURE_COLOR = '#0ea5e9'; // sky-500
const FOOD_COLOR = '#f59e0b'; // amber-500

// ---------------------------------------------------------------------------
// Hauptkomponente
// ---------------------------------------------------------------------------

export function StatisticsView({
  chartData,
  pressureCorrelation,
  cycleCorrelation,
  foodAnalysis,
}: StatisticsViewProps) {
  return (
    <section aria-label="Statistiken" className="flex flex-col gap-4">
      {/* Infokarten mit den Summary-Texten des statisticsService */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <InfoCard
          title="Luftdruck & Schmerz"
          accent={PRESSURE_COLOR}
          summary={pressureCorrelation.summary}
          meta={correlationMeta(pressureCorrelation.r, pressureCorrelation.n, 'ρ')}
        />
        <InfoCard
          title="Zyklus & PMS"
          accent={PMS_COLOR}
          summary={cycleCorrelation.summary}
          meta={correlationMeta(cycleCorrelation.r, cycleCorrelation.n, 'r')}
        />
      </div>

      {/* Food-Karte: volle Breite (enthält die Pro-Kategorie-Liste) */}
      <FoodCard analysis={foodAnalysis} />

      {/* Chart */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700">
          Attacken im Zeitverlauf
        </h3>

        {chartData.length === 0 ? (
          <p className="mt-6 pb-8 text-center text-sm text-slate-400">
            Noch keine Daten – tracke deine erste Attacke, um den Verlauf zu sehen.
          </p>
        ) : (
          <>
            <div className="mt-3 h-[360px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />

                  <XAxis
                    dataKey="formattedDate"
                    tickFormatter={onlyDate}
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    minTickGap={24}
                    interval="preserveStartEnd"
                  />

                  {/* Linke Achse: Schmerz 1–10 */}
                  <YAxis
                    yAxisId="pain"
                    domain={[0, 10]}
                    ticks={[0, 2, 4, 6, 8, 10]}
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    label={{
                      value: 'Schmerz (1–10)',
                      angle: -90,
                      position: 'insideLeft',
                      fontSize: 12,
                      fill: '#64748b',
                    }}
                  />

                  {/* Rechte Achse: Luftdruck in hPa */}
                  <YAxis
                    yAxisId="pressure"
                    orientation="right"
                    domain={['auto', 'auto']}
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    label={{
                      value: 'hPa',
                      angle: 90,
                      position: 'insideRight',
                      fontSize: 12,
                      fill: '#64748b',
                    }}
                  />

                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />

                  {/* Schmerz als Balken; PMS-Tage in Violett */}
                  <Bar
                    yAxisId="pain"
                    dataKey="painLevel"
                    name="Schmerz"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={24}
                  >
                    {chartData.map((point, index) => (
                      <Cell
                        key={`${point.timestamp}-${index}`}
                        fill={point.hasPMS ? PMS_COLOR : PAIN_COLOR}
                      />
                    ))}
                  </Bar>

                  {/* Luftdruck als Linie; null-Werte bleiben Lücken */}
                  <Line
                    yAxisId="pressure"
                    type="monotone"
                    dataKey="pressure"
                    name="Luftdruck (hPa)"
                    stroke={PRESSURE_COLOR}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Legende-Ergänzung: PMS-Färbung */}
            <p className="mt-2 flex items-center gap-2 text-xs text-slate-400">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: PMS_COLOR }}
              />
              Violette Balken = PMS-/Regel-Tag
            </p>
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Teilkomponenten / Helfer
// ---------------------------------------------------------------------------

interface InfoCardProps {
  title: string;
  /** Hex-Farbe für den Akzent-Punkt. */
  accent: string;
  /** Summary-Text aus dem statisticsService (wird 1:1 ausgegeben). */
  summary: string;
  /** Kleine Meta-Zeile, z. B. „ρ = 0.42 · n = 12“. */
  meta: string;
}

/** Kompakte Infokarte: Titel + Summary-Text + Meta-Zeile. */
function InfoCard({ title, accent, summary, meta }: InfoCardProps) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{summary}</p>
      <p className="mt-2 text-xs text-slate-400">{meta}</p>
    </article>
  );
}

interface FoodCardProps {
  analysis: FoodAnalysisResult;
}

/** Karte „Ernährung & Migräne“: Summary + Pro-Kategorie-Liste. */
function FoodCard({ analysis }: FoodCardProps) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: FOOD_COLOR }}
        />
        <h3 className="text-sm font-semibold text-slate-700">
          Ernährung &amp; Migräne
        </h3>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        {analysis.summary}
      </p>
      {analysis.results.length === 0 ? (
        <p className="mt-2 text-xs text-slate-400">
          Noch keine Einträge – erfasse Lebensmittel im Tab „Ernährung“,
          um eine Auswertung zu sehen.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {analysis.results.map((r) => (
            <li
              key={r.category}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="shrink-0 text-slate-700">
                {FOOD_CATEGORY_LABELS[r.category]}
              </span>
              <span
                className={`text-right text-xs font-medium ${foodRateClass(r.rateDifference)}`}
              >
                {r.nAttacksExposed}/{r.nAttacks} Attacken vs.{' '}
                {r.nOtherDaysExposed}/{r.nOtherDays} andere Tage
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-400">
        24-h-Fenster vor Attackenbeginn – Basis: {analysis.totalDays} erfasste
        Tage, {analysis.totalEntries} Einträge
      </p>
    </article>
  );
}

/** Farbe der Listen-Zeile: Exzess vor Attacken = rot, Defizit = grün. */
function foodRateClass(diff: number | null): string {
  if (diff === null) return 'text-slate-400';
  if (diff > 0.05) return 'text-rose-600';
  if (diff < -0.05) return 'text-emerald-600';
  return 'text-slate-500';
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ChartDataPoint }>;
}

/**
 * Eigener Tooltip: volle Zeitangabe, Schmerz mit PMS-Kennzeichnung und
 * Luftdruck (bzw. Hinweis, wenn er noch nicht abgerufen wurde).
 */
function ChartTooltip({ active, payload }: ChartTooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || point === undefined) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-700">{point.formattedDate}</p>
      <p className="mt-1" style={{ color: point.hasPMS ? PMS_COLOR : PAIN_COLOR }}>
        Schmerz: {point.painLevel}/10{point.hasPMS ? ' · PMS/Regel-Tag' : ''}
      </p>
      <p style={{ color: PRESSURE_COLOR }}>
        Luftdruck:{' '}
        {point.pressure === null
          ? '– (noch nicht abgerufen)'
          : `${point.pressure} hPa`}
      </p>
    </div>
  );
}

/** Meta-Zeile für die Infokarten (r-Wert + Stichprobe, ohne p-Wert). */
function correlationMeta(r: number | null, n: number, symbol: 'ρ' | 'r'): string {
  if (r === null) return `nicht auswertbar (n = ${n})`;
  return `${symbol} = ${r.toFixed(2)} · n = ${n}`;
}

/** '19.07.2026, 14:00' -> '19.07.2026' (kompakte X-Achsen-Beschriftung). */
function onlyDate(formattedDate: string): string {
  return formattedDate.split(',')[0];
}
