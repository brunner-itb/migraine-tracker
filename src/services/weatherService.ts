/**
 * weatherService – Abruf von Wetterdaten über die Open-Meteo API (ohne API-Key).
 *
 * Liefert den Luftdruck (surface_pressure, hPa) für die EXAKTE Startstunde
 * einer Attacke (stündliche Auflösung, Startzeit wird zur Stunde abgerundet).
 *
 * Historische vs. aktuelle Zeitstempel:
 *  - jung (≤ 5 Tage alt):  Forecast-API  (deckt die letzten 92 Tage ab + 16 Tage Prognose)
 *  - älter (> 5 Tage):     Archive-API   (ERA5, stündlich, bis zurück 1940; Datenverzug ~5 Tage)
 *  - Fallback: schlägt die Archive-API fehl und der Zeitpunkt liegt ≤ 92 Tage zurück,
 *               wird die Forecast-API als Ersatz verwendet.
 *
 * Zeitzone: Der Zeitstempel wird in der Zeitzone des Geräts interpretiert
 * (Standardfall: die Nutzerin trägt die Attacke am Ort des Geschehens ein).
 * Die Zone wird an die API übergeben, sodass die Hourly-Antwort 1:1 in
 * Ortsstunden (00:00–23:00) indizierbar ist – auch über DST-Grenzen korrekt,
 * da per Zeiten-String und nicht per Index abgeglichen wird.
 *
 * Der Service ist bewusst PURE: Er kennt weder Dexie noch die UI.
 * Das Mapping auf `WeatherData` (pending → fetched) passiert in einer
 * späteren Repository-Schicht.
 */

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export type WeatherSource = 'forecast' | 'archive';

/** Ergebnis eines Abrufs – 1:1 abspiegelbar auf die `WeatherData`-Tabelle. */
export interface WeatherSnapshot {
  /** Der angeforderte Zeitstempel (Attacken-Start), wie übergeben. */
  timestamp: string;

  /** Die tatsächlich verwendete Stunde, z. B. '2026-07-19T14:00' (Ortszeit). */
  hourUsed: string;

  /** Luftdruck an der Erdoberfläche in hPa (surface_pressure). */
  surfacePressure: number | null;

  /** Auf Meeresniveau reduzierter Luftdruck in hPa (surface_pressure_msl). */
  surfacePressureMsl: number | null;

  /** Temperatur in 2 m, °C – optional, für spätere Korrelations-Analysen. */
  temperature: number | null;

  /** Relative Luftfeuchte in 2 m, % – optional. */
  humidity: number | null;

  /** Genutzter Endpoint (für Debugging/Nachvollzug). */
  source: WeatherSource;
}

/** Domain-spezifischer Fehler (statt nacktem Fetch-Fehler) für sauberes Retry-Handling. */
export class WeatherApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeatherApiError';
  }
}

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Archive-API hat ~5 Tage Verzug -> jüngere Zeitstempel kommen von der Forecast-API. */
const ARCHIVE_DELAY_MS = 5 * 24 * 60 * 60 * 1000;
/** Forecast-API reicht ~92 Tage in die Vergangenheit. */
const FORECAST_LOOKBACK_MS = 92 * 24 * 60 * 60 * 1000;

/**
 * Stündliche Variablen (identisch für beide Endpoints):
 *  - surface_pressure: Druck auf Bodenhöhe (hPa)
 *  - pressure_msl:     auf Meeresniveau reduzierter Druck (hPa)
 *    Achtung: "surface_pressure_msl" existiert in KEINER der APIs -> HTTP 400.
 */
const HOURLY_VARS =
  'surface_pressure,pressure_msl,temperature_2m,relative_humidity_2m';

const TIMEOUT_MS = 20_000;

/** Erwartete Antwortstruktur (nur die Felder, die wir brauchen). */
interface OpenMeteoHourlyResponse {
  hourly: {
    time: string[]; // 'YYYY-MM-DDTHH:00' in der angeforderten Zeitzone
    surface_pressure: (number | null)[];
    /** Auf Meeresniveau reduzierter Druck (beide Endpoints). */
    pressure_msl?: (number | null)[];
    temperature_2m: (number | null)[];
    relative_humidity_2m: (number | null)[];
  };
}

// ---------------------------------------------------------------------------
// interne Helfer
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' in der Zeitzone des Geräts (en-CA liefert das ISO-Datum in Local Time). */
function localDateOf(ts: Date): string {
  return ts.toLocaleDateString('en-CA');
}

/** Zielstunde als API-String, z. B. '2026-07-19T14:00' – Startzeit zur Stunde abgerundet. */
function localHourLabelOf(ts: Date): string {
  const hour = String(ts.getHours()).padStart(2, '0');
  return `${localDateOf(ts)}T${hour}:00`;
}

/** Zeitzone des Geräts (IANA), Fallback 'auto' = Ortszeit der Koordinaten. */
function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'auto';
}

function buildUrl(source: WeatherSource, coords: Coordinates, localDate: string): string {
  const base = source === 'archive' ? ARCHIVE_URL : FORECAST_URL;
  const params = new URLSearchParams({
    latitude: coords.latitude.toFixed(4),
    longitude: coords.longitude.toFixed(4),
    hourly: HOURLY_VARS,
    start_date: localDate,
    end_date: localDate,
    timezone: deviceTimezone(),
  });
  return `${base}?${params.toString()}`;
}

async function fetchJson(url: string): Promise<OpenMeteoHourlyResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new WeatherApiError(`Open-Meteo antwortete mit HTTP ${res.status}`);
    }
    return (await res.json()) as OpenMeteoHourlyResponse;
  } catch (err) {
    if (err instanceof WeatherApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new WeatherApiError(`Open-Meteo-Request timeout nach ${TIMEOUT_MS} ms`);
    }
    throw new WeatherApiError(`Open-Meteo-Request fehlgeschlagen: ${String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

type HourValues = Omit<WeatherSnapshot, 'timestamp' | 'source'>;

/** Sucht die exakte Zielstunde in der Hourly-Antwort und extrahiert die Messwerte. */
function extractHour(
  json: OpenMeteoHourlyResponse,
  hourLabel: string,
): HourValues {
  const hourly = json.hourly;
  if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
    throw new WeatherApiError('Unerwartetes Open-Meteo-Antwortformat (hourly fehlt)');
  }

  const { time, surface_pressure, pressure_msl, temperature_2m, relative_humidity_2m } =
    hourly;
  const idx = time.indexOf(hourLabel);
  if (idx === -1) {
    throw new WeatherApiError(
      `Keine Daten für Stunde ${hourLabel} (verfügbare Spanne: ${time[0]} – ${time[time.length - 1]})`,
    );
  }

  const pick = (arr: (number | null)[] | undefined): number | null =>
    arr?.[idx] ?? null;

  return {
    hourUsed: time[idx] ?? hourLabel,
    surfacePressure: pick(surface_pressure),
    surfacePressureMsl: pick(pressure_msl),
    temperature: pick(temperature_2m),
    humidity: pick(relative_humidity_2m),
  };
}

// ---------------------------------------------------------------------------
// öffentliche API
// ---------------------------------------------------------------------------

/**
 * Ruft den Luftdruck für die exakte Startstunde einer Attacke ab.
 *
 * @param timestamp Startzeit der Attacke (ISO-String oder Date).
 *                  Wird zur beginnenden Stunde abgerundet (14:37 -> 14:00).
 *                  Vergangene Zeitstempel werden automatisch über die
 *                  Archive-API (ERA5) abgerufen.
 * @param coords    Geokoordinaten (GPS), für die die Daten gelten.
 * @throws {WeatherApiError} bei Netz-, Timeout- oder Datenfehlern.
 */
export async function fetchPressureForTimestamp(
  timestamp: string | Date,
  coords: Coordinates,
): Promise<WeatherSnapshot> {
  const ts = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  if (Number.isNaN(ts.getTime())) {
    throw new WeatherApiError(`Ungültiger Zeitstempel: ${String(timestamp)}`);
  }

  const ageMs = Date.now() - ts.getTime();
  const localDate = localDateOf(ts);
  const hourLabel = localHourLabelOf(ts);

  // Primärquelle: > 5 Tage alt -> Archive (ERA5), sonst Forecast (past_hours).
  const primary: WeatherSource = ageMs > ARCHIVE_DELAY_MS ? 'archive' : 'forecast';
  // Fallback: Archive schlägt fehl und Zeitpunkt ist noch im 92-Tage-Fenster.
  const fallback: WeatherSource | null =
    primary === 'archive' && ageMs <= FORECAST_LOOKBACK_MS ? 'forecast' : null;

  const sources: WeatherSource[] = fallback ? [primary, fallback] : [primary];

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const isLast = i === sources.length - 1;
    try {
      const json = await fetchJson(buildUrl(source, coords, localDate));
      return {
        timestamp: typeof timestamp === 'string' ? timestamp : ts.toISOString(),
        ...extractHour(json, hourLabel),
        source,
      };
    } catch (err) {
      if (isLast) {
        throw err instanceof WeatherApiError
          ? err
          : new WeatherApiError(String(err));
      }
      // sonst: Fallback-Quelle versuchen
    }
  }

  // Unreachable – für den Compiler da.
  throw new WeatherApiError('Intern: keine Wetterquelle mehr verfügbar');
}
