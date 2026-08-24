# Plan: Standort manuell festlegen (mit GPS-Fallback)

> **Status: UMGESETZT** (Session 2026-07-24).
> Alle 10 Schritte umgesetzt; `npx tsc --noEmit` → 0 Fehler, `npm run build`
> erfolgreich (PWA-SW generiert). Manueller iOS-Test (Schritt 10.3) noch offen.
>
> Einzige Abweichung: `settingsRepository.setLocation()` setzt den festen
> Standort per Merge (`...s`) statt mit Partial-Row – Dexie `put` verlangt
> die volle Zeile; dadurch bleiben `lastKnown*` + `locationMode` erhalten
> (gewolltes Verhalten).

## Ziel

1. Die Nutzerin kann einen **festen Standort** festlegen (per Stadtsuche oder
   Übernahme des aktuellen GPS-Standorts).
2. Ist **kein** fester Standort gesetzt, wird wie bisher der
   **Gerätestandort (GPS)** verwendet (bestehendes Verhalten, 5-s-Timeout,
   blockiert nie).
3. Der Standort ist **nachträglich änderbar**:
   - festen Standort auf eine andere Stadt umstellen,
   - festen Standort entfernen (zurück zu GPS),
   - optional: **alle bestehenden Wetterdaten** mit dem neuen Standort
     neu abrufen (explizite Bestätigung der Nutzerin).
4. **Zielgarantie: Keine Attacke ohne Standort.** Fallback-Kette:
   fester Standort → Live-GPS → zuletzt bekannter GPS-Standort →
   (nur in diesem Fall) ohne Wetterzeile + Backfill beim nächsten Start.
5. Die **Reihenfolge** fester Standort vs. Live-GPS ist **nutzerwählbar**
   (`locationMode`: `'fixed-first'` (Default) | `'gps-first'`). Der zuletzt
   bekannte Standort bleibt in beiden Modi das letzte Netz.

## Architektur-Entscheidungen (fix, nicht verhandeln)

| Entscheidung | Begründung |
|---|---|
| Fester Standort als **globale Einstellung** (eine Zeile), nicht pro Attacke | Anforderung: „Standort festlegen, sonst GPS“ – das ist eine Nutzer-Einstellung, kein Attacken-Attribut. |
| Neue Dexie-Tabelle `settings` in **Schema-Version 2** | Neue Tabelle in höherer Version = automatische, verlustfreie Migration. |
| `getPositionWithTimeout` aus `AddAttackWizard.tsx` **nach `src/services/locationService.ts` auslagern** | Wird an 3 Orten gebraucht (Wizard, Settings-UI, App-Start-Retry). Service bleibt pure (kein Dexie). |
| Stadtsuche über **Open-Meteo Geocoding API** (keylos) | Passt zum bestehenden Open-Meteo-Setup (Forecast + Archive), kein neuer Provider. |
| `resolveLocation()` lebt im **settingsRepository** (nicht im Service) | Liest die DB (Settings) und fällt auf den puren GPS-Service zurück. Layering wie bisher: Services = pure, Repositories = DB + Orchestrierung. |
| **Zuletzt bekannter GPS-Standort** wird bei jedem erfolgreichen Live-GPS automatisch in `settings` gespeichert | Deckt „GPS gerade nicht verfügbar“ ab, ohne dass die Nutzerin etwas einstellen muss (Zielgarantie Punkt 4). Stale-Koordinaten sind für Luftdruck besser als keine. |
| **Modus-Auswahl statt freiem Reorder** (`locationMode`: `'fixed-first'` | `'gps-first'`) | Der sinnvolle Spielraum ist binär (Vorrang fester Standort vs. GPS); ein Drag-&-Drop-Reorder der 3 Quellen wäre Overengineering (4–5 von 6 Permutationen sind unsinnig). `'last-known'` ist Sicherheitsnetz, keine wählbare Quelle. |
| Bulk-Re-Fetch als **neue Repository-Methode** `refetchAllWeather(coords, onProgress?)` | Nutzt den bestehenden privaten `refreshWeather()`; Fortschritt per Callback (kein UI-Import ins Repository). |
| Bei Standortwechsel **ohne** Bestätigung: alte Wetterzeilen behalten ihre Koordinaten | Pro-Attacke-Historie bleibt erhalten; nur neue Attacken nutzen den neuen Standort. |

## Bestehender Code (wichtige Fakten für die Umsetzung)

- `src/repositories/attackRepository.ts` ist **klassenbasiert**:
  `export class AttackRepository { constructor(private readonly database: MigraineDB = db) {} }`,
  Instanz: `export const attackRepository = new AttackRepository();`
  → `settingsRepository` im selben Stil bauen.
- `retryMissingWeather(coords?: Coordinates): Promise<RetryResult>` existiert
  bereits und hat **zwei Gruppen**:
  1. vorhandene `weatherData`-Zeilen mit Status `pending`/`error`
     (Abruf mit den in der Zeile gespeicherten Koordinaten),
  2. Attacken **ohne** Wetterzeile – werden nur backgefillt, wenn `coords`
     übergeben werden.
  → Das reicht; es muss nur beim App-Start ein aufgelöster Standort
     übergeben werden (heute: `retryMissingWeather()` ohne Argument).
- `refreshWeather(weatherId, coords)` ist **private** und wirft nie
  (Fehler → Status `error`).
- `pendingWeatherRow(attackId, startTime, coords)` ist ein Modul-Helfer
  (Factory für `pending`-Zeilen) – wiederverwenden.
- `src/services/weatherService.ts` ist **pure** (keine Dexie-Imports) und
  exportiert `Coordinates` – Typ nicht duplizieren, importieren.
- `src/utils/generateMockData.ts` nutzt feste `BERLIN_COORDS` und ruft
  `attackRepository.retryMissingWeather(coords)` auf → **unverändert lassen**.
- `AddAttackWizard.tsx` enthält aktuell `getPositionWithTimeout()` und
  `GPS_TIMEOUT_MS` lokal (Create-Branch von `handleDetailsSubmit`).

---

## Schritt-für-Schritt-Umsetzung

### Schritt 1: `src/db/types.ts` – `UserSettings`-Interface

Am Ende der Datei (neue Sektion „Einstellungen“):

```ts
// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

/**
 * Bevorzugte Reihenfolge der Standortauflösung (nutzerwählbar in den
 * Einstellungen). 'last-known' ist in beiden Modi immer das letzte Netz.
 */
export type LocationMode = 'fixed-first' | 'gps-first';

/**
 * Globale App-Einstellungen – IMMER genau eine Zeile (id: 1).
 * Der feste Standort ist optional: latitude/longitude null = „GPS verwenden“.
 */
export interface UserSettings {
  /** Fixer Primärschlüssel: immer 1 (Single-Row-Tabelle). */
  id: number;

  /** Anzeigename des festen Standorts, z. B. 'Hamburg, Deutschland'. '' = kein fester Standort. */
  locationName: string;

  latitude: number | null;
  longitude: number | null;

  /** Zuletzt erfolgreich ermittelter GPS-Standort (automatisch gepflegt, Fallback). */
  lastKnownLatitude: number | null;
  lastKnownLongitude: number | null;
  lastKnownAt: string | null;

  /** Bevorzugte Reihenfolge: 'fixed-first' (Default) | 'gps-first'. */
  locationMode: LocationMode;

  updatedAt: string;
}
```

### Schritt 2: `src/db/database.ts` – Tabelle `settings` (Version 2)

1. Import um `UserSettings` ergänzen.
2. Tabellen-Deklaration ergänzen (neben `weatherData`):

```ts
settings!: Table<UserSettings, number>;
```

3. **Neue Schema-Version** hinter `version(1)` hinzufügen. Wichtig: In
   `version(2).stores()` nur die NEUE Tabelle nennen – Dexie übernimmt die
   bestehenden Tabellen implizit:

```ts
// Version 2: globale Einstellungen (Single-Row, id: 1).
this.version(2).stores({
  settings: 'id',
});
```

4. Den Klass-Kommentar um die neue Tabelle ergänzen (kein FK, eigenständig).

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 3: `src/services/locationService.ts` – NEUE Datei

`getPositionWithTimeout` aus `AddAttackWizard.tsx` **hierher verschieben**
(1:1, nur `export` ergänzen). Datei bleibt pure (kein Dexie):

```ts
/**
 * locationService – Gerätestandort (GPS) ohne Nebenwirkungen.
 *
 * `getPositionWithTimeout` löst IMMER auf (niemals reject):
 *  - Erfolg  -> { latitude, longitude }
 *  - Fehler (Ablehnung, Offline, …) -> undefined
 *  - Timeout -> undefined
 * Doppelte Timeout-Absicherung (Option + eigener setTimeout), s. Code.
 */
import type { Coordinates } from './weatherService';

export const GPS_TIMEOUT_MS = 5_000;

export function getPositionWithTimeout(timeoutMs: number): Promise<Coordinates | undefined> {
  // … (unverändert aus AddAttackWizard.tsx übernommen)
}
```

### Schritt 4: `src/services/geocodingService.ts` – NEUE Datei

Open-Meteo Geocoding API (keylos), Fetch-Muster (AbortController + 20 s
Timeout + Domain-Fehlerklasse) exakt wie `fetchJson` in `weatherService.ts`:

```ts
/**
 * geocodingService – Stadtsuche über die Open-Meteo Geocoding API (keylos).
 * Pure: kennt weder Dexie noch die UI.
 */

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 20_000;

export interface GeocodingResult {
  name: string;
  latitude: number;
  longitude: number;
  /** Z. B. 'Hamburg, Deutschland' (konsekutive Duplikate entfernt). */
  displayName: string;
}

/** Erwartete Antwortstruktur (nur benötigte Felder). */
interface GeocodingResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    admin1?: string; // Bundesland / Region
    country?: string;
  }>;
}

export class GeocodingApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeocodingApiError';
  }
}

/**
 * Sucht Orte nach Name (min. 2 Zeichen), Sprache Deutsch, max. 10 Treffer.
 * @throws {GeocodingApiError} bei Netz-/Timeout-/HTTP-Fehlern.
 */
export async function searchLocations(query: string): Promise<GeocodingResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const params = new URLSearchParams({
    name: q,
    count: '10',
    language: 'de',
    format: 'json',
  });
  // fetchJson analog zu weatherService (AbortController, 20 s, res.ok-Check)
  const json = await fetchJson(`${GEOCODING_URL}?${params.toString()}`);

  return (json.results ?? [])
    .filter((r) => typeof r.latitude === 'number' && typeof r.longitude === 'number')
    .map((r) => {
      const parts = [r.name, r.admin1, r.country].filter(Boolean) as string[];
      const unique = parts.filter((p, i) => i === 0 || p !== parts[i - 1]);
      return {
        name: r.name,
        latitude: r.latitude,
        longitude: r.longitude,
        displayName: unique.join(', '),
      };
    });
}
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 5: `src/repositories/settingsRepository.ts` – NEUE Datei

Im Stil von `attackRepository.ts` (Klasse + Export-Instanz):

```ts
/**
 * settingsRepository – Globale App-Einstellungen (Single-Row, id: 1).
 *
 * Kernfunktion: `resolveLocation()` – die EINSTELE für „woher kommen die
 * Koordinaten?" (Ziel: möglichst IMMER Koordinaten). Reihenfolge je nach
 * `locationMode` (nutzerwählbar, s. UserSettings):
 *  - 'fixed-first' (Default): fester Standort -> Live-GPS -> letzter bekannter
 *  - 'gps-first':             Live-GPS -> fester Standort -> letzter bekannter
 * Live-GPS (5 s, blockiert nie) speichert seinen Erfolg als „zuletzt
 * bekannter Standort"; der ist in beiden Modi das letzte Netz.
 * undefined -> keine Wetterzeile, Backfill beim nächsten App-Start.
 */
import { db, type MigraineDB } from '../db/database';
import type { LocationMode, UserSettings } from '../db/types';
import { getPositionWithTimeout, GPS_TIMEOUT_MS } from '../services/locationService';

export interface SavedLocation {
  name: string;
  latitude: number;
  longitude: number;
}

export interface ResolvedLocation extends SavedLocation {
  /** Herkunft, für Logging/Debugging. */
  source: 'settings' | 'gps' | 'last-known';
}

export class SettingsRepository {
  constructor(private readonly database: MigraineDB = db) {}

  /** Liest die Settings-Zeile; legt sie bei Bedarf an (Default: kein Standort). */
  async getSettings(): Promise<UserSettings> {
    const row = await this.database.settings.get(1);
    if (row) return row;
    const defaultRow: UserSettings = {
      id: 1,
      locationName: '',
      latitude: null,
      longitude: null,
      lastKnownLatitude: null,
      lastKnownLongitude: null,
      lastKnownAt: null,
      locationMode: 'fixed-first',
      updatedAt: new Date().toISOString(),
    };
    await this.database.settings.put(defaultRow);
    return defaultRow;
  }

  /** Fester Standort oder null (-> GPS-Fallback). */
  async getLocation(): Promise<SavedLocation | null> {
    const s = await this.getSettings();
    if (s.latitude === null || s.longitude === null) return null;
    return { name: s.locationName, latitude: s.latitude, longitude: s.longitude };
  }

  /** Setzt/ersetzt den festen Standort. */
  async setLocation(location: SavedLocation): Promise<void> {
    await this.database.settings.put({
      id: 1,
      locationName: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Entfernt den festen Standort (zurück zu GPS).
   *  Der zuletzt bekannte Standort bleibt bewusst erhalten (Fallback). */
  async clearLocation(): Promise<void> {
    const s = await this.getSettings();
    await this.database.settings.put({
      ...s,
      locationName: '',
      latitude: null,
      longitude: null,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Speichert den zuletzt ermittelten GPS-Standort (automatischer Fallback). */
  async saveLastKnownLocation(latitude: number, longitude: number): Promise<void> {
    const s = await this.getSettings();
    await this.database.settings.put({
      ...s,
      lastKnownLatitude: latitude,
      lastKnownLongitude: longitude,
      lastKnownAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Setzt die bevorzugte Reihenfolge der Standortauflösung. */
  async setLocationMode(mode: LocationMode): Promise<void> {
    const s = await this.getSettings();
    await this.database.settings.put({
      ...s,
      locationMode: mode,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Auflösung je nach `locationMode` (s. Modul-Kommentar). */
  async resolveLocation(): Promise<ResolvedLocation | undefined> {
    const s = await this.getSettings();

    const fixed: ResolvedLocation | undefined =
      s.latitude !== null && s.longitude !== null
        ? {
            name: s.locationName,
            latitude: s.latitude,
            longitude: s.longitude,
            source: 'settings',
          }
        : undefined;

    const lastKnown: ResolvedLocation | undefined =
      s.lastKnownLatitude !== null && s.lastKnownLongitude !== null
        ? {
            name: 'Zuletzt bekannter Standort',
            latitude: s.lastKnownLatitude,
            longitude: s.lastKnownLongitude,
            source: 'last-known',
          }
        : undefined;

    // Live-GPS (5 s, blockiert nie); Erfolg wird als Fallback persistiert.
    const liveGps = async (): Promise<ResolvedLocation | undefined> => {
      const gps = await getPositionWithTimeout(GPS_TIMEOUT_MS);
      if (!gps) return undefined;
      await this.saveLastKnownLocation(gps.latitude, gps.longitude);
      return { name: 'Gerätestandort', ...gps, source: 'gps' };
    };

    if (s.locationMode === 'gps-first') {
      return (await liveGps()) ?? fixed ?? lastKnown;
    }
    // Default: 'fixed-first'
    return fixed ?? (await liveGps()) ?? lastKnown;
  }
}

/** Fertige Instanz (Default: globale Dexie-DB; in Tests injizierbar). */
export const settingsRepository = new SettingsRepository();
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 6: `src/repositories/attackRepository.ts` – `refetchAllWeather`

Neue **öffentliche** Methode (z. B. nach `retryMissingWeather`), nutzt den
bestehenden privaten `refreshWeather()` und `pendingWeatherRow()`:

```ts
/**
 * Ruft die Wetterdaten für ALLE Attacken mit den übergebenen Koordinaten
 * neu ab (nach Standortwechsel, nur auf explizite Nutzer-Bestätigung).
 *
 * Pro Attacke:
 *  - vorhandene Wetter-Zeile: Koordinaten aktualisieren + Status 'pending'
 *    -> refreshWeather()
 *  - fehlende Wetter-Zeile:  Zeile anlegen (pending) + 1:1-Link + refresh
 *
 * Läufe sequenziell (fair zur API). Wirft nie – Fehler landen im Status.
 *
 * @param onProgress Optionales UI-Feedback (done, total).
 */
async refetchAllWeather(
  coords: Coordinates,
  onProgress?: (done: number, total: number) => void,
): Promise<RetryResult> {
  const attacks = await this.database.attacks.toArray();
  const result: RetryResult = { attempted: 0, succeeded: 0, failed: 0 };

  for (const attack of attacks) {
    if (attack.id === undefined) continue; // defensiv
    result.attempted += 1;

    const existing = await this.database.weatherData
      .where('attackId')
      .equals(attack.id)
      .first();

    let weatherId: number;
    if (existing?.id !== undefined) {
      await this.database.weatherData.update(existing.id, {
        latitude: coords.latitude,
        longitude: coords.longitude,
        status: 'pending',
        fetchedAt: null,
      });
      weatherId = existing.id;
    } else {
      weatherId = await this.database.transaction(
        'rw',
        [this.database.weatherData, this.database.attacks],
        async () => {
          const id = await this.database.weatherData.add(
            pendingWeatherRow(attack.id!, attack.startTime, coords),
          );
          await this.database.attacks.update(attack.id!, { weatherId: id });
          return id;
        },
      );
    }

    const ok = await this.refreshWeather(weatherId, coords);
    if (ok) result.succeeded += 1;
    else result.failed += 1;
    onProgress?.(result.attempted, attacks.length);
  }

  return result;
}
```

**Checkpoint:** `npx tsc --noEmit` → 0 Fehler.

### Schritt 7: `src/components/AddAttackWizard.tsx` – `resolveLocation` nutzen

1. **Entfernen:** lokaler `getPositionWithTimeout`-Block + `GPS_TIMEOUT_MS`
   (ist jetzt in `locationService.ts`), Import `Coordinates` aus
   `weatherService` entfällt.
2. **Import ergänzen:**
   `import { settingsRepository } from '../repositories/settingsRepository';`
3. **Create-Branch** in `handleDetailsSubmit` ersetzen:

```ts
// 1) Standort auflösen – Reihenfolge je nach locationMode
//    (s. settingsRepository). 'fixed-first' + fester Standort =
//    KEIN GPS-Prompt.
const loc = await settingsRepository.resolveLocation();
const coords = loc
  ? { latitude: loc.latitude, longitude: loc.longitude }
  : undefined;

// 2) Attacke (+ Wetter-Planung) offline-first persistieren.
const saved = await attackRepository.addAttack(toNewAttack(baseData, details), coords);
```

4. Modul-Kommentar oben anpassen (GPS-Punkt → „Standortauflösung
   (Settings -> GPS), blockiert nie“).
5. Edit-Branch bleibt unverändert (kein Standort-Abruf).

### Schritt 8: `src/components/SettingsView.tsx` – NEUE Komponente

Presentation + eigene DB-Zugriffe über `settingsRepository`/
`attackRepository` (wie die anderen Views). Ein Card „Standort“:

**State:**

```ts
const [settings, setSettings] = useState<UserSettings | null>(null);
const [query, setQuery] = useState('');
const [results, setResults] = useState<GeocodingResult[]>([]);
const [isSearching, setIsSearching] = useState(false);
const [searchError, setSearchError] = useState<string | null>(null);
const [isSaving, setIsSaving] = useState(false);
const [refetchProgress, setRefetchProgress] = useState<{ done: number; total: number } | null>(null);
const [refetchTarget, setRefetchTarget] = useState<SavedLocation | null>(null); // für ConfirmDialog
```

**Verhalten:**

- `useEffect` beim Mount: `settingsRepository.getSettings()` → `setSettings`.
- **Status-Anzeige:**
  - `settings.latitude !== null` →
    „Fester Standort: **{locationName}** – alle neuen Attacken nutzen diesen
    Standort.“ + Button „Festen Standort entfernen“
  - sonst → „Kein fester Standort – beim Erfassen wird der
    Gerätestandort (GPS) verwendet.“
- **Fallback-Anzeige** (immer, wenn `lastKnownLatitude !== null`): kleine
  Zeile „Fallback-Standort (zuletzt ermittelt): {lat}, {lng} am
  {Datum/Uhrzeit}“ (read-only, kein Button).
- **Onboarding-Hinweis** (nur wenn KEIN fester Standort UND kein
  `lastKnownLatitude`): hervorgehobene Hinweis-Box „Noch ist kein Standort
  bekannt. Ohne Standort bekommt eine Attacke keine Wetterdaten. Tippe auf
  „Gerätestandort übernehmen“ oder suche deine Stadt, damit JEDER Attacke
  ein Standort zugeordnet wird.“
- **Standort-Quelle (Modus-Auswahl):** Radio-Gruppe mit zwei Optionen,
  Wert aus `settings.locationMode`, Änderung sofort via
  `settingsRepository.setLocationMode(mode)` + `setSettings` (kein
  Re-Fetch-Dialog – die Modus-Wechselung invalidiert keine Daten):
  - `fixed-first`: „Fester Standort bevorzugt (Standard)“ –
    Beschreibung: „Ein gesetzter fester Standort wird ohne GPS-Prompt
    verwendet.“
  - `gps-first`: „Live-GPS bevorzugt“ – Beschreibung: „GPS wird zuerst
    abgefragt (Prompt + max. 5 s); der feste Standort dient als Fallback.“
  - Hinweiszeile unter der Gruppe: „Ohne fester Standort gilt GPS zuerst
    in beiden Modi.“
  - Umsetzung: `<label>` + `<input type="radio" name="locationMode">`
    (`min-h-11` für iOS), wie die anderen Formularelemente der App.
- **Stadtsuche:** Textfeld + Button „Suchen“ (Enter auch). Bei Abfrage:
  `searchLocations(query)` mit `isSearching`-State; Trefferliste (max. 10)
  als Buttons: `displayName` + Koordinaten (klein, 2 Dezimalen).
  Fehler (offline etc.) → `searchError`-Zeile, UI bleibt bedienbar.
- **Button „Gerätestandort übernehmen“:**
  `getPositionWithTimeout(GPS_TIMEOUT_MS)` → Erfolg: `setLocation({ name:
  'Gerätestandort (aktuell)', ...gps })`; Fehlschlag: Fehlermeldung
  „Gerätestandort konnte nicht ermittelt werden (Permission/Offline?).“
- **Nach JEDEM Standort-Wechsel** (set oder clear) mit `setLocation`/
  `clearLocation` speichern, `setSettings` aktualisieren UND – falls sich
  der Standort geändert hat (set oder clear) – `setRefetchTarget(...)`
  setzen (bei clear: `null` → kein Re-Fetch anbieten, alte Zeilen behalten
  ihre Koordinaten).
- **ConfirmDialog** (bestehende Komponente wiederverwenden):
  - Titel: „Wetterdaten neu laden?“
  - Nachricht: „Der Standort wurde geändert. Soll der Luftdruck für alle
    Attacken mit dem neuen Standort neu abgerufen werden? Das kann einige
    Minuten dauern und läuft im Hintergrund weiter.“
  - Bestätigen → `runRefetch(refetchTarget)`:

```ts
async function runRefetch(loc: SavedLocation): Promise<void> {
  setRefetchProgress({ done: 0, total: 0 });
  const attacks = await db.attacks.count();
  setRefetchProgress({ done: 0, total: attacks });
  const res = await attackRepository.refetchAllWeather(
    { latitude: loc.latitude, longitude: loc.longitude },
    (done, total) => setRefetchProgress({ done, total }),
  );
  setRefetchProgress(null);
  // Ergebniszeile: `${res.succeeded} von ${res.attempted} Wetterdaten neu geladen.`
}
```

  - Fortschrittszeile in der Card: „Wetterdaten werden neu geladen …
    {done}/{total}“ (Button-States disabled, während `refetchProgress` gesetzt).
- **Button „Festen Standort entfernen“:** `clearLocation()` → Status
  zurück auf GPS-Hinweis (kein Re-Fetch-Dialog).

Tailwind-Klassen wie im Rest der App (`rounded-2xl border border-gray-200
bg-white p-5 shadow-sm`, Buttons `min-h-11`, Eingaben `min-h-11 text-base`
für iOS-Zoom-Schutz).

### Schritt 9: `src/App.tsx` – Tab „Einstellungen“ + App-Start-Retry

1. `type Tab = 'journal' | 'stats' | 'report' | 'settings';`
2. Bottom-Navigation: Eintrag `['settings', 'Einstellungen']` ergänzen.
3. Render-Block:

```tsx
{tab === 'settings' && <SettingsView />}
```

4. **App-Start-Retry** – auflösenden Standort übergeben (schließt die
   bestehende Lücke: Attacken ohne Wetterzeile werden jetzt backgefillt,
   sobald ein Standort verfügbar ist):

```ts
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
```

   (Ersetzt den bestehenden `retryMissingWeather()`-Effekt.)

### Schritt 10: Verifikation

1. `npx tsc --noEmit` → **0 Fehler**.
2. `npm run build` → erfolgreich (PWA-SW wird generiert).
3. **Manueller Test (iOS Safari / PWA):**
   - [ ] Einstellungen: Stadtsuche „Hamburg“ → Trefferliste → antippen →
         Status zeigt „Fester Standort: Hamburg, …“.
   - [ ] ConfirmDialog erscheint → „Ja“ → Fortschritt läuft durch, am Ende
         Ergebniszeile. In DevTools (Application → IndexedDB →
         `migraine-tracker` → `weatherData`) prüfen: `latitude`/`longitude`
         = Hamburg, Status `fetched`.
   - [ ] Neue Attacke erfassen → **kein** GPS-Prompt, Wetterzeile mit
         Hamburg-Koordinaten.
   - [ ] „Festen Standort entfernen“ → neue Attacke nutzt wieder GPS
         (Prompt erscheint).
   - [ ] „Gerätestandort übernehmen“ (mit erteilter Permission) →
         Koordinaten gespeichert, Name „Gerätestandort (aktuell)“.
   - [ ] Modus „Live-GPS bevorzugt“ + fester Standort gesetzt + GPS
         erteilt: neue Attacke nutzt GPS-Koordinaten (nicht den festen
         Standort).
   - [ ] Modus „Live-GPS bevorzugt“ + GPS blockiert: neue Attacke nutzt
         den festen Standort (Fallback greift).
   - [ ] Modus zurück auf „Fester Standort bevorzugt“: wieder kein
         GPS-Prompt bei neuer Attacke.
   - [ ] Offline: Stadtsuche zeigt Fehlermeldung; Attacke ohne Standort
         wird gespeichert (keine Wetterzeile) → App neu starten (online,
         fester Standort gesetzt) → Wetterzeile wird beim Start
         backgefillt.
   - [ ] Fester Standort entfernen + GPS blockieren (Permission entziehen
         bzw. Flugmodus): neue Attacke bekommt den zuletzt bekannten
         Standort (Wetterzeile mit stale-Koordinaten, Status 'fetched').
   - [ ] Frische Installation (DB geleert) + GPS abgelehnt: Einstellungen
         zeigen den Onboarding-Hinweis; Attacke ohne Wetterzeile →
         Standort setzen → App-Start → Backfill greift.
   - [ ] Beispieldaten (Testbereich) funktionieren weiterhin
         (`generateMockData` nutzt feste BERLIN_COORDS, unverändert).
4. **Regressionstest Kaskaden-Löschung (vorheriger Task):**
   - [ ] Attacke mit Medikamenten + Wetter löschen → in IndexedDB:
         `medicationIntakes` und `weatherData` der Attacke sind weg,
         `cycleEvents` bleiben erhalten.

## Edge Cases & bekannte Limitierungen (bewusst so)

1. **GPS abgelehnt + kein fester Standort** → wird durch den zuletzt
   bekannten Standort abgefedert (`source: 'last-known'`). Nur wenn noch
   NIE ein Standort ermittelt werden konnte (frische Installation +
   GPS abgelehnt) entsteht eine Attacke ohne Wetterzeile – der
   App-Start-Retry (Schritt 9) füllt sie beim nächsten Start auf.
2. **Standortwechsel ohne Re-Fetch** → alte Zeilen behalten alte
   Koordinaten (Pro-Attacke-Historie), neue Attacken nutzen den neuen
   Standort.
3. **Re-Fetch wird unterbrochen** (App geschlossen) → Zeilen bleiben
   `pending`/`error` → bestehender Start-Retry holt sie nach.
4. **Zeitzone:** `weatherService` nutzt die **Gerätezeitzone**
   (`deviceTimezone()`). Bei einem festen Standort im Ausland (anderer
   Zeitgürtel) kann die abgerufene Stunde um einige Stunden abweichen.
   Für den Normalfall (DE) irrelevant.
5. **iOS:** Geocoding ist plain HTTPS (funktioniert in der PWA). GPS in der
   PWA nutzt dasselbe Permission-Modell wie im Browser.
6. **Modus 'gps-first':** Jede Attacke-Erfassung triggert einen GPS-Versuch
   (Prompt bei fehlender Permission + max. 5 s Wartezeit). Das ist die
   bewusste Gegenleistung für präzisere Koordinaten – die Nutzerin wählt
   diesen Modus explizit.

## Optionales Follow-up (NICHT in diesem Plan enthalten)

- **Zeitzone pro Standort speichern:** Die Geocoding-Antwort enthält
  `timezone` (IANA). Feld `timezone: string | null` in `UserSettings`
  speichern und `fetchPressureForTimestamp` um optionalen
  `timezone`-Parameter erweitern (`buildUrl` nutzt heute
  `deviceTimezone()`). Beseitigt Limitierung 4 für Auslands-Standorte.

## Betroffene Dateien (Übersicht)

| Datei | Änderung |
|---|---|
| `src/db/types.ts` | + `UserSettings` |
| `src/db/database.ts` | + `settings`-Tabelle, `version(2)` |
| `src/services/locationService.ts` | **neu** (GPS-Helper aus Wizard hierher) |
| `src/services/geocodingService.ts` | **neu** (Open-Meteo Geocoding) |
| `src/repositories/settingsRepository.ts` | **neu** (get/set/clear/setMode/saveLastKnown/resolveLocation) |
| `src/repositories/attackRepository.ts` | + `refetchAllWeather(coords, onProgress?)` |
| `src/components/AddAttackWizard.tsx` | Create-Branch: `resolveLocation()`; lokaler GPS-Helper raus |
| `src/components/SettingsView.tsx` | **neu** (Standort-Card, Suche, Re-Fetch) |
| `src/App.tsx` | + Tab „Einstellungen“; Start-Retry mit aufgelöstem Standort |
| `src/utils/generateMockData.ts` | unverändert |
