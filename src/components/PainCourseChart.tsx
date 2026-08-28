/**
 * PainCourseChart – reiner Anzeigegraph des Schmerzverlaufs (NUR Anzeige,
 * keine Eingabe). Zeigt den Hauptwert (Attacken-Start) plus alle
 * Verlaufseinträge als Liniendiagramm.
 *
 * Eingabe bleibt die Liste im PainCourseEditor – der Graph ist bewusst
 * nicht interaktiv (kein Zeichnen per Drag).
 */

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';

interface PainCourseChartProps {
  mainLevel: number;
  entries: Array<{ time: string; level: number }>;
}

export function PainCourseChart({ mainLevel, entries }: PainCourseChartProps) {
  const data = [
    { time: 'Start', level: mainLevel },
    ...entries
      .filter((e) => e.level > 0)
      .map((e) => ({
        time: new Date(e.time).toLocaleTimeString('de-DE', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        level: e.level,
      })),
  ];

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="time" tick={{ fontSize: 11 }} />
          <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(value) => [`${value}/10`, 'Schmerz']}
            labelFormatter={(label) => `Zeitpunkt: ${label}`}
          />
          <Line
            type="monotone"
            dataKey="level"
            stroke="#0284c7"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
