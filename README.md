# Migraine Tracker

Personal migraine journal as a web app (PWA). Runs entirely in the browser, works offline; all data stays on your device (IndexedDB, no server, no account). UI in German.

## Features

### Attack logging (two-step wizard)

- Type (migraine / tension-type / other), pain level 1-10, start & end time
- **Pain course**: several pain entries over the course of one attack, not just a single number
- Location: GPS position with place name (Open-Meteo geocoding), or a custom location
- Medication per attack: name, type, dose, how effective it was
- Cycle events: menstruation, PMS, spotting, cramps, other (e.g. missed pill)
- Free-text notes (triggers, aura, nausea, ...)

### Weather data & correlation

- For every attack, the **hourly surface pressure (hPa) at the exact start time** of the attack is fetched from the [Open-Meteo](https://open-meteo.com/) API (no API key) for the attack's location
- Recent attacks (< 5 days) come from the Forecast API, older ones from the ERA5 archive (hourly, back to 1940), with automatic fallback between the two
- Temperature and humidity are stored as well, for future analyses
- Statistics view:
  - Combined chart: pain over time (bars) with air pressure overlaid (line); attacks on PMS/period days are highlighted
  - **Pressure correlation**: Spearman rank correlation (pain level vs. air pressure, average ranks for ties). Reports the coefficient ρ, the number of evaluated pairs, how many attacks were excluded (missing weather data), and a plain-language assessment of strength and direction (none / weak / moderate / pronounced / strong, positive or negative)
  - **Cycle correlation**: point-biserial correlation (pain vs. PMS/period day) plus average pain on those days vs. all other days

### Doctor report (PDF)

- Monthly headache calendar ("Kopfschmerzkalender") for the doctor: date, start/end, pain as peak + course (e.g. `8 (8↘5↘2)`), medication, location, cycle events
- Includes average pain and a weather summary (how many attacks happened below 1013 hPa, mean pressure)

### Data

- JSON backup: export & import
- Sample-data generator to try the app with a fresh database

## Tech

React, TypeScript, Vite, Tailwind CSS, Dexie (IndexedDB), Recharts, jsPDF

## Development

```bash
npm install
npm run dev     # start dev server
npm run build   # typecheck + production build
```
