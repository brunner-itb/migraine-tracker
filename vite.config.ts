import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Service Worker wird bei jedem Build automatisch neu registriert –
      // auf dem iPhone landen Updates ohne manuellen "Reload"-Tanz.
      registerType: 'autoUpdate',

      // Zusätzliche statische Assets, die in den Service Worker aufgenommen
      // werden (außerhalb des normalen Build-Outputs).
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'mask-icon.svg'],

      manifest: {
        name: 'Migräne Tagebuch',
        short_name: 'Migräne',
        description:
          'Offline-fähiges Tagebuch für Migräne- und Kopfschmerzattacken – mit Wetter-Korrelation, Zyklus-Tracking und Arztbericht.',
        theme_color: '#4f46e5',
        background_color: '#f9fafb',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'de',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },

      workbox: {
        // Alle Build-Artefakte precachen -> App startet offline.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
      },
    }),
  ],
});
