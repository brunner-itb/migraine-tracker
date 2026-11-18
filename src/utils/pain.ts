/**
 * Pain-Helfer – „Gesamtschmerz“ (Peak) einer Attacke.
 *
 * `MigraineAttack.painLevel` ist der Schmerz zum Startzeitpunkt (t_0) und
 * bleibt beim Speichern unverändert. Der repräsentative Gesamtschmerz für
 * Journal-Liste, Statistik und Arztbericht ist der PEAK (Maximum) aus
 * Startwert und allen Schmerzverlauf-Einträgen (`painEntries`). Da der Peak
 * in der DB nicht separat gespeichert ist, wird er auf der Leserseite mit
 * diesen Helfern abgeleitet.
 */

import type { PainEntry } from '../db/types';

/** attackId -> höchster Verlaufswert (für die Peak-Berechnung pro Attacke). */
export function entryPeakByAttack(
  entries: Array<Pick<PainEntry, 'attackId' | 'level'>>,
): Map<number, number> {
  const peaks = new Map<number, number>();
  for (const e of entries) {
    const current = peaks.get(e.attackId);
    if (current === undefined || e.level > current) {
      peaks.set(e.attackId, e.level);
    }
  }
  return peaks;
}

/**
 * Gesamtschmerz einer Attacke = höchster Wert aus Start-Schmerz und
 * (optional) höchstem Verlaufswert.
 */
export function attackPeakPain(
  mainLevel: number,
  entryPeak?: number,
): number {
  return entryPeak === undefined ? mainLevel : Math.max(mainLevel, entryPeak);
}
