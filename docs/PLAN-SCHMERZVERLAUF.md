# Plan: Schmerzverlauf pro Attacke (variable Schmerzstärke über die Zeit)

> **Status: NICHT UMGESETZT.**
> Für ein lokales LLM mit kleinem Kontextfenster: Die Schritte sind
> **strikt sequenziell** und **jeder für sich compilierbar**. Pro Schritt:
> „Zuerst lesen“ (nur diese Dateien), „Änderung“ (konkret), „Checkpoint“.
> Nicht mehr Kontext laden als angegeben.
>
> Projekt: `C:\Users\IsleO\Desktop\MigräneTracker`
> Checkpoint-Befehl (immer aus Projekt-Root): `npx tsc --noEmit`

## Ziel

1. Die Schmerzstärke einer Attacke kann **zeitlich variieren**: Neben dem
   Hauptwert (Schmerz bei Beginn, Schritt 1) können **optional mehrere
   zusätzliche Schmerzpunkte** erfasst werden, z. B. 08:30 → 8, 13:00 → 5,
   21:00 → 2.
2. Erfassung im **Wizard, Schritt 2** (Details) – optional, progressive
   Disclosure. Der Wizard dient zugleich als Detail-/Edit-Ansicht
   (Tap auf Attacke = Wizard im Edit-Modus) → dort können Einträge
   **nachträglich ergänzt/geändert/gelöscht** werden.
3. **Kein Graph als Eingabe.** Eingabe = Liste + Zeitpicker + 1–10-Auswahl.
   Der Graph (Recharts) ist **nur zur Anzeige**.
4. `MigraineAttack.painLevel` bleibt das **repräsentative Feld** und wird
   definiert als **Peak (Maximum)** aus Hauptwert und allen Verlaufseinträgen.
   → Alle bestehenden Konsumenten (Journal-Liste, Statistik, Korrelationen,
   Chart, PDF) laufen **unverändert** weiter.
5. Einfache Attacken mit nur einem Wert funktionieren exakt wie heute
   (keine Pflicht, keine zusätzliche Komplexität).

## Architektur-Entscheidungen (fix, nicht verhandeln)

| Entscheidung | Begründung |
|---|---|
| Neue Dexie-Tabelle `painEntries` (Schema-Version 3), **kein** JSON-Array in der Attacke | Passt zum bestehenden relationalen Muster (`medicationIntakes` mit `attackId` + Zeitstempel), indexierbar, kaskadierend löschbar. |
| `painEntries: '++id, attackId, time'` | Query: `where('attackId').equals(id).sortBy('time')`. Kein Composite-Index nötig (wenige Einträge pro Attacke). |
| `painLevel` = `max(Hauptwert, alle Einträge)`, berechnet **im Wizard** (in `toNewAttack`/`toUpdatedAttack`) | Repository kennt den „Hauptwert“ nach dem ersten Save nicht mehr getrennt (nur der Peak ist gespeichert) → Peak muss in der UI-Schicht berechnet werden, die beide Werte kennt. |
| Create-Flow: Einträge im Wizard per **direktem db-Zugriff** in `persistAttackDetails` (bestehendes Muster, „Übergangslösung“) – **keine** neue Repository-Methode | `persistAttackDetails` persistiert Zyklus + Medikamente bereits so; Konsistenz schlägt Abstraktion. |
| Edit-Flow: `UpdatedAttack.painEntries` (optional) + delete-all/bulkAdd in `attackRepository.updateAttack` (bestehendes Medikamenten-Muster) | Edit-Modus läuft über `updateAttack`. |
| Einträge gehören **pro Attacke** (nicht pro Tag) | Anforderung. |
| Validierung der Einträge: `level` 1–10, Zeit innerhalb `[startTime, endTime ?? jetzt]` | Sinnvolle physikalische Grenze; Prüfung im Wizard (UX), Repository vertraut der UI (wie beim Rest der App). |
| Eingabe-UI: `input type="datetime-local"` + 1–10-Chips, **Sky-Farbschema** wie der Rest der App | iOS-Safari: natives Picker-UI, Touch-Targets ≥ 44 px, passt zu `AttackForm`/`AttackDetailsForm`. |
| Report/PDF: Schmerz-Spalte zeigt `Peak (Verlauf)`, z. B. `8 (8→5→2)` | Kompakt, druckt gut, keine neue Spalte nötig. |
| Export/Import: `EXPORT_FORMAT_VERSION` → 2, `painEntries` beim Import **optional** (alte v1-Dateien bleiben importierbar) | Kein Datenverlust, Abwärtskompatibilität. |
| **Nicht ändern:** `AttackForm.tsx`, `App.tsx`, `StatisticsView.tsx`, `statisticsService.ts`, `src/services/pdfExportService.ts` (Duplikat von `ReportView.tsx`, wird von der App nicht verwendet) | Bestehende Funktionen bleiben stabil; `painLevel`-Semantik (Peak) reicht ihnen. |

## Bestehender Code (wichtige Fakten)

- `src/db/types.ts`: Interfaces wie `MigraineAttack`, `MedicationIntake`
  (`id?: number`, logische FK `attackId: number`).
- `src/db/database.ts`: `MigraineDB extends Dexie` mit 6 Tabellen;
  `version(1)` und `version(2)` (settings) existieren → nächste Version ist **3**.
- `src/repositories/attackRepository.ts`:
  - `NewAttack = Omit<MigraineAttack, 'id'|'weatherId'|'createdAt'|'updatedAt'>`.
  - **`UpdatedAttack` ist ein TYPE-ALIAS**: `Omit<NewAttack, 'type'> & { isPMS, isMenstruation, spotBleeding, cramps, missedPill, medications: UpdatedMedication[], locationCoords?: Coordinates }`.
  - `updateAttack(attackId, data: UpdatedAttack)`: eine rw-Transaction über
    `[attacks, medications, medicationIntakes, cycleEvents, weatherData]`;
    Medikation wird per **delete + add** ersetzt; interne Nummerierung
    `1) Attacken-Zeile … 4) Wetter-Zeile`.
  - `deleteAttack(attackId)`: rw-Transaction `[weatherData, medicationIntakes, attacks]`,
    Kaskade-Delete.
  - Es gibt **keinen** Getter für `medicationIntakes` – der Wizard liest
    Intakes direkt via `db`.
- `src/components/AddAttackWizard.tsx`:
  - `step: WizardStep = 1 | 2`; `baseData: BaseAttackFormData | null`
    (Schritt 1 wird zwischengespeichert, bevor Schritt 2 rendert).
  - Modulebene: `toNewAttack(base, details, locationName)` und
    `toUpdatedAttack(base, details, initialLoc)` (Mapper),
    `persistAttackDetails(attackId, details, attackStart)` (direkter
    `db.transaction('rw', [db.cycleEvents, db.medications, db.medicationIntakes], …)`).
  - `handleDetailsSubmit(details)`: Guard
    `if (baseData === null || submittingRef.current) return;` (Ref gegen
    Doppel-Submit), dann Edit-Branch (`updateAttack`) oder Create-Branch
    (`addAttack` → `persistAttackDetails`).
  - Edit-Mode: `useEffect` lädt `intakes, cycleEvents, weatherRow` per
    `Promise.all` direkt aus `db` → `setDetailsInitial({ isPMS, …, medications, notes })`.
- `src/components/AttackForm.tsx` (Schritt 1, **nicht ändern**):
  `BaseAttackFormData = { startTime: string; endTime: string | undefined; painLevel: number; location: AttackLocation | null }`;
  `PAIN_LEVELS = [1..10] as const`, Auswahl als `grid grid-cols-5 gap-2`.
- `src/components/AttackDetailsForm.tsx` (Schritt 2):
  - Props: `onSubmit, onBack, submitLabel?, isSubmitting?, initialData?`.
  - Form-State als **einzelne `useState`-Hooks** pro Feld (kein
    `formData`-Objekt): `isPMS`, `isMenstruation`, `spotBleeding`, `cramps`,
    `missedPill`, `medications: MedicationEntry[]`, `notes`.
  - `AttackDetailsFormData` = diese Felder; `InitialDetailsData` = gleiche
    Felder (medications ohne `id`).
  - Sektionen in dieser Reihenfolge: `h1` → „Zyklus & Begleitumstände“ →
    „Eingenommene Medikamente“ → „Notizen & Auslöser“ → Navigation.
  - UI-Stil: **Sky** (`bg-sky-600`, `focus:ring-sky-200`, …),
    Touch-Targets `min-h-11`/`h-11`, Karten `rounded-xl border border-gray-200 bg-gray-50 p-3`.
- `src/components/ReportView.tsx`: `exportMonthlyReport(attacks, month)` –
  Joins per `Promise.all` (Zeile 18: `intakes, meds, cycleEvents, weatherRows`),
  `tableRows` (Zeile 73: `attack.painLevel.toString()`), `columnStyles`
  (Zeilen 101–108: Spalte 3 = Schmerz `cellWidth: 13`, Spalte 4 = Medikation
  `cellWidth: 52`).
- `src/services/dataTransferService.ts`: `EXPORT_FORMAT_VERSION = 1` (Zeile 26),
  `TABLE_KEYS` (Zeile 32), `parseDataExport` prüft pro Key
  `Array.isArray` (Zeile 164), `importDataExport` = clear + bulkPut in einer
  rw-Transaction (Zeilen ~197–219).
- `src/components/SettingsView.tsx`: Import-Erfolgs-Text Zeilen 269–271
  (`res.attacks`, `res.cycleEvents`, `res.medications`, `res.weatherData`).
- `src/utils/generateMockData.ts`: `seedMockData()`; pro Monat 5–8 Attacken
  (`start`/`end`/`attackId` als lokale Variablen, `painLevel: randInt(3, 9)`);
  Helfer `randInt`, `chance`, `pick`, `toLocalISO`; Block „4) ~60% der
  Attacken mit Medikamenteneinnahme“ nach dem atomaren Attacken-Create.
- Zeitformat der App: `'YYYY-MM-DDTHH:mm'` (Ortszeit, ohne Sekunden/Zone) –
  exakt das Format von `datetime-local`-Inputs.

---

## Schritt 1: Datenmodell + DB-Migration

**Zuerst lesen:** `src/db/types.ts`, `src/db/database.ts`

### 1.1 `src/db/types.ts` – Interface `PainEntry`

Neue Sektion **nach** dem `MedicationIntake`-Interface einfügen:

```ts
// ---------------------------------------------------------------------------
// Schmerzverlauf
// ---------------------------------------------------------------------------

/**
 * Ein einzelner Schmerzzeitpunkt während einer Attacke (Schmerzverlauf).
 * attackId = logische Referenz auf attacks (kein FK-Constraint in Dexie).
 * time im selben Format wie startTime/endTime ('YYYY-MM-DDTHH:mm', Ortszeit).
 */
export interface PainEntry {
  id?: number;
  attackId: number;
  /** Messzeitpunkt (Ortszeit, 'YYYY-MM-DDTHH:mm'). */
  time: string;
  /** Schmerzlevel auf der 1–10-Skala. */
  level: number;
}
```

### 1.2 `src/db/database.ts` – Tabelle `painEntries` (Version 3)

1. `PainEntry` zu den `./types`-Imports ergänzen.
2. In `interface MigraineDB` (nach `medicationIntakes`) ergänzen:

```ts
  painEntries: Table<PainEntry, number>;
```

3. In der Klasse `MigraineDBClass` (nach der `settings`-Deklaration) ergänzen:

```ts
  painEntries!: Table<PainEntry, number>;
```

4. **Neue Schema-Version** hinter `version(2)` hinzufügen. Wichtig: In
   `version(3).stores()` nur die NEUE Tabelle nennen – Dexie übernimmt die
   bestehenden Tabellen implizit:

```ts
    // Version 3: Schmerzverlauf (Schmerzzeitpunkte pro Attacke).
    this.version(3).stores({
      painEntries: '++id, attackId, time',
    });
```

5. Den Klassen-Kommentar (Relationen-Liste) um eine Zeile ergänzen:
   `painEntries.attackId -> attacks.id (logisch, Kaskade in attackRepository.deleteAttack)`.

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

---

## Schritt 2: Repository – Update + Kaskade

**Zuerst lesen:** `src/repositories/attackRepository.ts` (komplett)

Alle Änderungen in dieser einen Datei. **Keine neuen Methoden** (der
Create-Flow nutzt den Wizard, s. Schritt 3; der Edit-Flow läuft über
`updateAttack`).

### 2.1 `UpdatedAttack` um `painEntries` ergänzen (optional!)

`UpdatedAttack` ist ein **Type-Alias** (`Omit<NewAttack, 'type'> & { … }`).
Im Objekt-Literal des `& { … }`-Teils, nach `locationCoords?: Coordinates;`,
ergänzen:

```ts
  /**
   * Schmerzverlauf: VOLLER Ersatz (alle vorhandenen Einträge werden gelöscht
   * und diese neu angelegt). Leeres Array = keine Einträge.
   * Optional (`?? []` im Repository), damit Schritt 2 eigenständig
   * compilierbar bleibt – der Wizard setzt es ab Schritt 3 immer.
   */
  painEntries?: Array<{ time: string; level: number }>;
```

### 2.2 `updateAttack` – Verlauf in derselben Transaktion ersetzen

1. `this.database.painEntries` in den Tabellen-Array der Transaction
   einfügen (nach `this.database.cycleEvents,`).
2. **Neuen Block nach dem Zyklus-Events-Block** (nach
   `await this.database.cycleEvents.bulkAdd(cycleEvents);` + Closing-Brace,
   vor `// 4) Wetter-Zeile`) einfügen:

```ts
        // 3b) Schmerzverlauf: voller Ersatz (delete + bulkAdd,
        //     gleiches Muster wie die Medikamenten-Einnahmen oben).
        await this.database.painEntries
          .where('attackId')
          .equals(attackId)
          .delete();
        const painEntries = data.painEntries ?? [];
        if (painEntries.length > 0) {
          await this.database.painEntries.bulkAdd(
            painEntries.map((e) => ({ attackId, time: e.time, level: e.level })),
          );
        }
```

### 2.3 `deleteAttack` – Kaskade ergänzen

1. `this.database.painEntries` in den Tabellen-Array einfügen.
2. Neben den bestehenden Delete-Zeilen ergänzen:

```ts
        await this.database.painEntries
          .where('attackId')
          .equals(attackId)
          .delete();
```

3. Den Funktions-JSDoc um „Schmerzverlauf (n:1)“ in der Kaskaden-Liste
   ergänzen.

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

---

## Schritt 3: Wizard – Datenfluss (Create + Edit)

**Zuerst lesen:** `src/components/AddAttackWizard.tsx` (komplett)

Alle Änderungen in dieser einen Datei.

### 3.1 Validierungshelfer (Modul-Ebene, über `AddAttackWizard`)

```ts
/**
 * Validiert Schmerzverlauf-Einträge.
 * @returns deutsche Fehlermeldung oder null (alles ok).
 */
function validatePainEntries(
  entries: Array<{ time: string; level: number }>,
  startTime: string,
  endTime: string | null,
): string | null {
  for (const e of entries) {
    if (e.level < 1 || e.level > 10) {
      return 'Schmerzverlauf: Jeder Eintrag braucht ein Schmerzlevel 1–10.';
    }
    const t = new Date(e.time).getTime();
    if (Number.isNaN(t)) {
      return 'Schmerzverlauf: Ein Eintrag hat eine ungültige Zeit.';
    }
    if (t < new Date(startTime).getTime()) {
      return 'Schmerzverlauf: Ein Eintrag liegt vor dem Attacken-Start.';
    }
    if (endTime !== null && t > new Date(endTime).getTime()) {
      return 'Schmerzverlauf: Ein Eintrag liegt nach dem Attacken-Ende.';
    }
  }
  return null;
}
```

### 3.2 `handleDetailsSubmit` – Validierung nach der Guard

Direkt nach `if (baseData === null || submittingRef.current) return;`
(d. h. `baseData` ist hier nicht null):

```ts
    const painError = validatePainEntries(
      details.painEntries,
      baseData.startTime,
      baseData.endTime ?? null,
    );
    if (painError !== null) {
      alert(painError);
      return;
    }
```

### 3.3 `toNewAttack` – Peak als `painLevel`

`painLevel: base.painLevel,` ersetzen durch:

```ts
    painLevel: Math.max(
      base.painLevel,
      ...details.painEntries.map((e) => e.level),
    ),
```

(Leer-Array → `Math.max(base.painLevel)` = Hauptwert, korrekt.)
Den Funktions-JSDoc um eine Zeile ergänzen:
`- painLevel = Peak aus Hauptwert + Verlaufseinträgen.`

### 3.4 `persistAttackDetails` – Einträge im Create-Flow speichern

1. `db.painEntries` in den Tabellen-Array der Transaction einfügen
   (nach `db.medicationIntakes,`).
2. **Neuen Block am Ende der Transaktion** (nach dem Medikamenten-`for`-Loop,
   vor dem Closing der Transaktions-Callback) einfügen:

```ts
      // 3) Schmerzverlauf
      if (details.painEntries.length > 0) {
        await db.painEntries.bulkAdd(
          details.painEntries.map((e) => ({
            attackId,
            time: e.time,
            level: e.level,
          })),
        );
      }
```

3. Den Funktions-JSDoc um eine Zeile ergänzen:
   `* - Schmerzverlauf: painEntries-Zeilen (leere Liste = keine Einträge).`

### 3.5 `toUpdatedAttack` – Peak + Verlauf

Im zurückgegebenen Objekt: `painLevel: base.painLevel,` ersetzen durch

```ts
      painLevel: Math.max(
        base.painLevel,
        ...details.painEntries.map((e) => e.level),
      ),
```

und direkt darunter ergänzen:

```ts
      painEntries: details.painEntries,
```

### 3.6 Edit-Mode – Verlauf initial laden

Im `useEffect` (Edit-Initialisierung): `Promise.all` um vierten Eintrag
erweitern:

```ts
      const [intakes, cycleEvents, weatherRow, painEntries] = await Promise.all([
        db.medicationIntakes.where('attackId').equals(attackId).toArray(),
        db.cycleEvents.where('date').equals(day).toArray(),
        db.weatherData.where('attackId').equals(attackId).first(),
        db.painEntries.where('attackId').equals(attackId).sortBy('time'),
      ]);
```

und in `setDetailsInitial({ … })` ergänzen:

```ts
        painEntries: painEntries.map((e) => ({ time: e.time, level: e.level })),
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.
(Hier bricht der Build, bis Schritt 5 `details.painEntries` in
`AttackDetailsFormData` definiert – das ist gewollt: Schritt 5 folgt
unmittelbar. Danach beide zusammen prüfen.)

---

## Schritt 4: NEUE Datei `src/components/PainCourseEditor.tsx`

**Zuerst lesen:** `src/components/AttackDetailsForm.tsx` (nur für den
bestehenden UI-Stil: Sky-Farben, Karten, Buttons, `min-h-11`)

Neue Datei, **reine Präsentations-Komponente** (controlled, kein Dexie):

```tsx
/**
 * PainCourseEditor – optionaler Schmerzverlauf einer Attacke.
 *
 * Reine Präsentations-Komponente (controlled): Die Einträge leben im
 * Parent (AttackDetailsForm). Eingabe = Liste + Zeitpicker + 1–10-Auswahl
 * (bewusst KEIN Graph als Eingabe). Der Graph ist nur Anzeige
 * (PainCourseChart, Schritt 6).
 */

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
  const maxTime = endTime ?? toLocalInputValue(new Date());
  const peak = Math.max(mainLevel, ...entries.map((e) => e.level));

  function addEntry(): void {
    const now = toLocalInputValue(new Date());
    // Zeit auf das Attacken-Fenster einschränken.
    const time = now < startTime ? startTime : now > maxTime ? maxTime : now;
    onChange([...entries, { uiId: `pe-${Date.now()}`, time, level: 0 }]);
  }

  function updateEntry(
    uiId: string,
    patch: Partial<Pick<PainEntryFormData, 'time' | 'level'>>,
  ): void {
    onChange(entries.map((e) => (e.uiId === uiId ? { ...e, ...patch } : e)));
  }

  function removeEntry(uiId: string): void {
    onChange(entries.filter((e) => e.uiId !== uiId));
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium text-gray-700">
          Schmerzverlauf (optional)
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          Zusätzliche Schmerzpunkte während der Attacke, z. B. morgens 8,
          mittags 5, abends 2.
        </p>
      </div>

      {entries.length === 0 ? (
        <button
          type="button"
          onClick={addEntry}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed
                     border-gray-300 text-sm font-medium text-gray-500
                     transition-colors hover:border-sky-400 hover:text-sky-600
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          + Schmerzwert hinzufügen
        </button>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {entries.map((entry) => (
              <div
                key={entry.uiId}
                className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3"
              >
                <div className="flex items-start gap-2">
                  <label className="flex-1 text-xs font-medium text-gray-600">
                    Zeitpunkt
                    <input
                      type="datetime-local"
                      value={entry.time}
                      min={startTime}
                      max={maxTime}
                      onChange={(e) =>
                        updateEntry(entry.uiId, { time: e.target.value })
                      }
                      className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base
                                 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => removeEntry(entry.uiId)}
                    className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-red-600
                               hover:bg-red-50 focus:outline-none focus-visible:ring-2
                               focus-visible:ring-red-400"
                    aria-label="Schmerzwert entfernen"
                  >
                    Entfernen
                  </button>
                </div>
                <div
                  className="grid grid-cols-5 gap-1.5"
                  role="radiogroup"
                  aria-label="Schmerzlevel"
                >
                  {LEVELS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="radio"
                      aria-checked={entry.level === l}
                      onClick={() => updateEntry(entry.uiId, { level: l })}
                      className={`min-h-10 rounded-lg border text-sm font-semibold
                                  focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400
                                  ${
                                    entry.level === l
                                      ? 'border-sky-600 bg-sky-600 text-white'
                                      : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100'
                                  }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addEntry}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed
                       border-gray-300 text-sm font-medium text-gray-500
                       transition-colors hover:border-sky-400 hover:text-sky-600
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            + Schmerzwert hinzufügen
          </button>
        </>
      )}

      {entries.length > 0 && (
        <p className="text-xs text-gray-500">
          Gespeicherter Schmerzlevel (Peak): <strong>{peak}</strong> – der
          höchste Wert aus Hauptfeld und Verlauf.
        </p>
      )}
    </section>
  );
}
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler (Datei wird noch nicht
verwendet – tsc prüft trotzdem alle Dateien in `src/`).

---

## Schritt 5: `AttackDetailsForm.tsx` – Editor einbetten

**Zuerst lesen:** `src/components/AttackDetailsForm.tsx` (komplett),
`src/components/AddAttackWizard.tsx` (nur die `<AttackDetailsForm …>`-Aufrufstelle)

### 5.1 `src/components/AttackDetailsForm.tsx`

1. Import ergänzen:

```ts
import { PainCourseEditor, type PainEntryFormData } from './PainCourseEditor';
```

2. `AttackDetailsFormProps` um drei **Pflicht-Props** ergänzen:

```ts
  /** Attacken-Start (Minimum für den Zeitpicker des Schmerzverlaufs). */
  startTime: string;

  /** Attacken-Ende (Maximum für den Zeitpicker); null = läuft noch. */
  endTime: string | null;

  /** Schmerzlevel aus Schritt 1 (Hauptwert, für Peak-Hinweis im Editor). */
  mainPainLevel: number;
```

3. `InitialDetailsData` ergänzen:

```ts
  /** Vorhandene Schmerzverlauf-Einträge (Edit-Mode). */
  painEntries?: Array<{ time: string; level: number }>;
```

4. `AttackDetailsFormData` ergänzen:

```ts
  /** Schmerzverlauf (optional; leeres Array = wie bisher, nur Hauptwert). */
  painEntries: PainEntryFormData[];
```

5. Destructuring der Props um `startTime, endTime, mainPainLevel` ergänzen.
   Form-State (im Stil der bestehenden Einzel-Hooks, nach `notes`):

```ts
  const [painEntries, setPainEntries] = useState<PainEntryFormData[]>(() =>
    (initialData?.painEntries ?? []).map((e, i) => ({
      uiId: `pe-${i}`,
      time: e.time,
      level: e.level,
    })),
  );
```

6. `handleSubmit`: `painEntries` in das übergebene Objekt einfügen:

```ts
    onSubmit({
      isPMS,
      isMenstruation,
      spotBleeding,
      cramps,
      missedPill,
      medications,
      notes,
      painEntries,
    });
```

7. **Editor als erste Sektion** einbetten – direkt nach dem `<h1>`-Block,
   **vor** der Sektion „Zyklus & Begleitumstände“:

```tsx
      {/* ------------------------------------------------------------------ */}
      {/* Schmerzverlauf (optional)                                          */}
      {/* ------------------------------------------------------------------ */}
      <PainCourseEditor
        entries={painEntries}
        onChange={setPainEntries}
        startTime={startTime}
        endTime={endTime}
        mainLevel={mainPainLevel}
      />
```

### 5.2 `src/components/AddAttackWizard.tsx` – Aufrufstelle

Am `<AttackDetailsForm …>` (Rendern, Schritt 2) die drei Props ergänzen:

```tsx
        <AttackDetailsForm
          onSubmit={handleDetailsSubmit}
          onBack={handleDetailsBack}
          submitLabel="Speichern"
          isSubmitting={isSubmitting}
          initialData={detailsInitial ?? undefined}
          startTime={baseData?.startTime ?? ''}
          endTime={baseData?.endTime ?? null}
          mainPainLevel={baseData?.painLevel ?? 0}
        />
```

(Hinweis: `baseData` ist zu diesem Zeitpunkt immer gesetzt – Schritt 2 wird
erst nach `handleBaseNext` gerendert; die `??`-Defaults dienen nur dem
TypeScript-Narrowing.)

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler (Schritt 3 + 5 zusammen).

---

## Schritt 6: NEUE Datei `src/components/PainCourseChart.tsx` (Anzeige)

**Zuerst lesen:** `src/components/PainCourseEditor.tsx`,
`src/components/StatisticsView.tsx` (nur für Recharts-Stil/Importe)

### 6.1 Neue Datei (reine Anzeige, kein Input, kein Dexie)

```tsx
/**
 * PainCourseChart – rein ANZEIGENDER Liniengraph für den Schmerzverlauf.
 * Kein Input (Eingabe erfolgt in PainCourseEditor), kein Dexie.
 * Erster Punkt = Hauptwert zum Attacken-Start, danach die Einträge.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface PainCourseChartProps {
  /** Hauptwert (Schmerz bei Beginn). */
  mainLevel: number;
  /** Verlaufseinträge (werden intern nach time sortiert). */
  entries: Array<{ time: string; level: number }>;
}

export function PainCourseChart({ mainLevel, entries }: PainCourseChartProps) {
  const data = [
    { label: 'Start', level: mainLevel },
    ...[...entries]
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((e) => ({ label: e.time.slice(11, 16), level: e.level })),
  ];

  return (
    <div className="h-32 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -24 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} />
          <YAxis domain={[1, 10]} ticks={[1, 3, 5, 7, 10]} tick={{ fontSize: 10 }} />
          <Tooltip />
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
```

### 6.2 In `src/components/PainCourseEditor.tsx` einbetten

1. Import ergänzen: `import { PainCourseChart } from './PainCourseChart';`
2. Im Return, **direkt nach dem Header-`<div>`** (Titel + Beschreibung) und
   vor dem Einträge-Block, einfügen:

```tsx
      {entries.length > 0 && (
        <PainCourseChart mainLevel={mainLevel} entries={entries} />
      )}
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler. `npm run build` → erfolgreich.

---

## Schritt 7: Arztbericht/PDF – Verlauf in der Schmerz-Spalte

**Zuerst lesen:** `src/components/ReportView.tsx`

> Hinweis: `src/services/pdfExportService.ts` ist ein älteres Duplikat dieser
> Datei und wird von der App NICHT verwendet → **nicht anfassen**.

### 7.1 Verlauf laden

Im `Promise.all`-Block (Zeile 18) fünften Eintrag ergänzen:

```ts
  const [intakes, meds, cycleEvents, weatherRows, painEntries] = await Promise.all([
    // …bestehende vier Einträge unverändert…
    db.painEntries.where('attackId').anyOf(attackIds).toArray(),
  ]);
```

### 7.2 Zeile aufbauen

Im `tableRows`-Map (Zeile 34), vor dem `return [ … ]` (z. B. nach
`eventsStrings` bzw. dem letzten vorbereiteten String):

```ts
    // Schmerzverlauf: Peak + Kurzzusammenfassung, z. B. "8 (8→5→2)".
    const course = painEntries
      .filter((p) => p.attackId === attack.id)
      .sort((a, b) => a.time.localeCompare(b.time));
    const painStr =
      course.length > 0
        ? `${attack.painLevel} (${course.map((c) => c.level).join('→')})`
        : attack.painLevel.toString();
```

Im `return [ … ]`-Array (Zeile 73): `attack.painLevel.toString(),` durch
`painStr,` ersetzen.

### 7.3 Spaltenbreiten anpassen

In `columnStyles` (Zeilen 101–108): Spalte 3 (Schmerz) von `13` auf `22`,
Spalte 4 (Medikation) von `52` auf `43` (Summe bleibt 182 mm).

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

---

## Schritt 8: Export/Import (Backup/Restore)

**Zuerst lesen:** `src/services/dataTransferService.ts`,
`src/components/SettingsView.tsx` (nur `handleConfirmImport`)

### 8.1 `src/services/dataTransferService.ts`

1. `PainEntry` zu den `../db/types`-Imports ergänzen.
2. `EXPORT_FORMAT_VERSION = 2;` (Kommentar: „Version 2: Tabelle painEntries
   (Schmerzverlauf)“).
3. `TABLE_KEYS`: `'painEntries'` **nach** `'medicationIntakes'` einfügen.
4. `ExportData`: `painEntries: PainEntry[];` ergänzen.
5. `ImportResult`: `painEntries: number;` ergänzen.
6. `createDataExport`: `database.painEntries.toArray()` in `Promise.all` +
   in das Result-Objekt einfügen.
7. `parseDataExport` – `painEntries` ist **optional** (alte v1-Exports):
   den bestehenden `for`-Loop (Zeile 164) ersetzen durch:

```ts
  for (const key of TABLE_KEYS) {
    if (key === 'painEntries') {
      // Optional: Exports vor Version 2 kennen die Tabelle noch nicht.
      if (dataObj[key] !== undefined && !Array.isArray(dataObj[key])) {
        throw new Error(`Ungültige Export-Datei: Tabelle „${key}“ ungültig.`);
      }
    } else if (!Array.isArray(dataObj[key])) {
      throw new Error(`Ungültige Export-Datei: Tabelle „${key}“ fehlt.`);
    }
  }
```

8. `importDataExport`:
   - Nach dem Destructuring von `exp.data`:
     `const painEntries = Array.isArray(exp.data.painEntries) ? exp.data.painEntries : [];`
   - `database.painEntries` in den Tabellen-Array der Transaction einfügen.
   - `database.painEntries.clear(),` in den `Promise.all`-Clear-Block.
   - Nach dem medicationIntakes-`bulkPut`:
     `if (painEntries.length > 0) await database.painEntries.bulkPut(painEntries);`
   - Return-Objekt: `painEntries: painEntries.length,` ergänzen.

### 8.2 `src/components/SettingsView.tsx`

Erfolgs-Text von `handleConfirmImport` (Zeilen 269–271) um den Zähler
ergänzen:

```ts
          `Import abgeschlossen: ${res.attacks} Attacken, ` +
          `${res.painEntries} Schmerzverlauf-Einträge, ` +
          `${res.cycleEvents} Zyklus-Events, ${res.medications} Medikamente, ` +
          `${res.weatherData} Wetterdaten übernommen.`,
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

---

## Schritt 9: Beispieldaten (Mock-Seed)

**Zuerst lesen:** `src/utils/generateMockData.ts` (nur `SeedResult` + der
monatliche Attacken-Loop, Abschnitte „3)“/„4)“)

1. `SeedResult` um `painEntriesAdded: number;` ergänzen (Initialisierung in
   `seedMockData` mit `painEntriesAdded: 0,`).
2. Im Attacken-Loop, **nach dem kompletten Medikamenten-Block** (dem
   `if (acuteMeds.length > 0 && chance(0.6)) { … }`), neuen Block einfügen
   (`start`, `end`, `attackId`, `attack` sind im Scope):

```ts
      // ----------------------------------------------------------------
      // 4b) ~50% der Attacken mit Schmerzverlauf (1–3 Einträge, abfallend)
      // ----------------------------------------------------------------
      if (chance(0.5)) {
        const peak = attack.painLevel;
        const entryCount = randInt(1, 3);
        let t = start.getTime() + randInt(30, 120) * 60_000;
        let level = peak;
        for (let k = 0; k < entryCount; k++) {
          if (t >= end.getTime()) break;
          if (k > 0) level = Math.max(1, level - randInt(1, 3));
          await db.painEntries.add({
            attackId,
            time: toLocalISO(new Date(t)),
            level,
          });
          result.painEntriesAdded += 1;
          t += randInt(180, 480) * 60_000;
        }
      }
```

3. Dateikopf-Kommentar um eine Zeile ergänzen:
   „~50% der Attacken mit 1–3 Schmerzverlauf-Einträgen (abfallend)“.

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler. `npm run build` → erfolgreich.

---

## Schritt 10: Abschluss-Validierung (manuell)

**Zuerst lesen:** nichts (nur testen).

1. `npm run build` → erfolgreich (tsc + Vite + PWA-SW).
2. `npm run dev` und durchklicken:
   - **Einfacher Pfad:** Neue Attacke OHNE Verlauf → exakt wie vorher
     (Schritt 2 zeigt nur den „+ Schmerzwert hinzufügen“-Button,
     Badge in der Liste = Hauptwert).
   - **Erweiterter Pfad:** Neue Attacke mit Hauptwert 8 + zwei Einträgen
     (z. B. +2 h → 5, +8 h → 2) → speichern. Liste zeigt „Schmerz 8/10“.
   - **Peak-Regel:** Hauptwert 5 + Eintrag 9 → Badge „Schmerz 9/10“.
   - **Edit:** Attacke öffnen → Einträge + Graph sichtbar; einen Eintrag
     löschen, einen ändern → speichern → erneut öffnen = konsistent.
   - **Validierung:** Eintrag mit Zeit vor dem Start → deutsche
     Fehlermeldung, wird NICHT gespeichert.
   - **Kaskade:** Attacke löschen → DevTools → Application → IndexedDB →
     `painEntries`: keine Waisen-Zeilen.
   - **Beispieldaten:** (leere DB) Settings → „Beispieldaten generieren“ →
     einige Attacken mit Verlauf; Statistik/Chart wie vorher.
   - **PDF:** Bericht → PDF-Export → Schmerz-Spalte zeigt bei Verläufen
     z. B. `8 (8→5→2)`, sonst nur die Zahl.
   - **Backup:** Settings → Daten exportieren → JSON enthält `painEntries`;
     importieren → Zähler im Erfolgs-Text, Daten intakt.
3. iOS-PWA-Check (am Gerät): Zeitpicker öffnet natives UI, alle
   Touch-Targets ≥ 44 px, Graph rendert (Recharts im Standalone-Modus).

## Definition of Done

- `npx tsc --noEmit` → 0 Fehler, `npm run build` → erfolgreich.
- Alle Punkte aus Schritt 10 bestanden.
- `painLevel` ist überall der Peak; Statistik/Korrelationen/Chart unverändert
  und korrekt.
- Alte Exports (v1) importierbar; neue Exports (v2) enthalten `painEntries`.

## Optionale Folge-Schritte (NICHT Teil dieses Plans)

- Statistik: Ø Verlaufswert, „Zeit bis Schmerz < 4“ pro Attacke.
- Graph: Medikamenten-Einnahmen als Marker auf der Linie.
- `pdfExportService.ts` (totes Duplikat) löschen.
