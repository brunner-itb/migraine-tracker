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

/** Max. Wartezeit für den GPS-Abruf – danach geht es ohne Koordinaten weiter. */
export const GPS_TIMEOUT_MS = 5_000;

/**
 * Ruft die aktuelle Position ab – löst IMMER auf (niemals reject):
 *  - Erfolg                          -> { latitude, longitude }
 *  - Fehler (Ablehnung, Offline, …)  -> undefined
 *  - Timeout                         -> undefined
 *
 * Doppelte Absicherung gegen "hängende" Promises:
 *  1) `timeout` in den Geolocation-Optionsen (Browser ruft dann die
 *     Error-Callback auf, errorCode 3),
 *  2) eigener `setTimeout` – da manche Browser/Contexts die Option nicht
 *     zuverlässig honorieren (z. B. bestimmte iOS-Safari-Versionen).
 * `settled` verhindert einen Doppel-Resolve beider Pfade.
 */
export function getPositionWithTimeout(timeoutMs: number): Promise<Coordinates | undefined> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      resolve(undefined); // z. B. kein sicherer Kontext (http) -> kein Geolocation-API
      return;
    }

    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined); // Timeout -> ohne Koordinaten weiter
      }
    }, timeoutMs);

    const finish = (coords: Coordinates | undefined): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(coords);
    };

    navigator.geolocation.getCurrentPosition(
      (position) =>
        finish({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        }),
      () => finish(undefined), // Permission denied / Position unavailable / …
      {
        // Genauigkeit ist für Luftdruck-Daten egal -> spart Akku.
        // maximumAge: 1 min alter Cache-Wert ist akzeptabel.
        enableHighAccuracy: false,
        timeout: timeoutMs,
        maximumAge: 60_000,
      },
    );
  });
}
