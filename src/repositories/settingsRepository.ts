/**
 * settingsRepository – Globale App-Einstellungen (Single-Row, id: 1).
 *
 * Kernfunktion: `resolveLocation()` – die EINSTELE für „woher kommen die
 * Koordinaten?" (Ziel: möglichst IMMER Koordinaten). Reihenfolge je nach
 * `locationMode` (nutzerwählbar, s. UserSettings):
 *  - 'gps-first' (Default):   Live-GPS -> fester Standort -> letzter bekannter
 *  - 'fixed-first':           fester Standort -> Live-GPS -> letzter bekannter
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

  /** Liest die Settings-Zeile; legt sie bei Bedarf an (Default: GPS zuerst). */
  async getSettings(): Promise<UserSettings> {
    const row = await this.database.settings.get(1);
    if (row === undefined) {
      const defaultRow: UserSettings = {
        id: 1,
        locationName: '',
        latitude: null,
        longitude: null,
        lastKnownLatitude: null,
        lastKnownLongitude: null,
        lastKnownAt: null,
        locationMode: 'gps-first',
        updatedAt: new Date().toISOString(),
      };
      await this.database.settings.put(defaultRow);
      return defaultRow;
    }
    // Einmal-Migration: Der alte Default war 'fixed-first'. Ohne gesetzten
    // festen Standort verhalten sich beide Modi identisch (GPS zuerst),
    // daher übernehmen solche Zeilen den neuen Default 'gps-first' – die UI
    // spiegelt so das tatsächliche Verhalten. Zeilen MIT festem Standort
    // bleiben unverändert (bewusste Nutzerwahl).
    if (
      row.locationMode === 'fixed-first' &&
      row.latitude === null &&
      row.longitude === null
    ) {
      const migrated: UserSettings = {
        ...row,
        locationMode: 'gps-first',
        updatedAt: new Date().toISOString(),
      };
      await this.database.settings.put(migrated);
      return migrated;
    }
    return row;
  }

  /** Fester Standort oder null (-> GPS-Fallback). */
  async getLocation(): Promise<SavedLocation | null> {
    const s = await this.getSettings();
    if (s.latitude === null || s.longitude === null) return null;
    return { name: s.locationName, latitude: s.latitude, longitude: s.longitude };
  }

  /** Setzt/ersetzt den festen Standort (Fallback + Modus bleiben erhalten). */
  async setLocation(location: SavedLocation): Promise<void> {
    const s = await this.getSettings();
    await this.database.settings.put({
      ...s,
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
    // 'fixed-first'
    return fixed ?? (await liveGps()) ?? lastKnown;
  }
}

/** Fertige Instanz (Default: globale Dexie-DB; in Tests injizierbar). */
export const settingsRepository = new SettingsRepository();
