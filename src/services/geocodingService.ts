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

async function fetchJson(url: string): Promise<GeocodingResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new GeocodingApiError(`Geocoding-API antwortete mit HTTP ${res.status}`);
    }
    return (await res.json()) as GeocodingResponse;
  } catch (err) {
    if (err instanceof GeocodingApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new GeocodingApiError(`Geocoding-Request timeout nach ${TIMEOUT_MS} ms`);
    }
    throw new GeocodingApiError(`Geocoding-Request fehlgeschlagen: ${String(err)}`);
  } finally {
    clearTimeout(timer);
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
