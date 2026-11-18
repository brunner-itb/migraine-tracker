# Migraine Tracker

Personal migraine journal as a web app (PWA). Runs entirely in the browser; all data stays on your device (IndexedDB, no server, no account). UI in German.

## Features

- Log attacks in two steps: pain level + pain course over time, type, location, medication, cycle events, notes
- Automatic weather & air pressure data for the attack location (needs location access)
- Statistics: charts plus correlations with air pressure and cycle
- Monthly doctor report (headache calendar) as PDF
- JSON backup: export & import

## Tech

React, TypeScript, Vite, Tailwind CSS, Dexie (IndexedDB), Recharts, jsPDF

## Development

```bash
npm install
npm run dev     # start dev server
npm run build   # typecheck + production build
```
