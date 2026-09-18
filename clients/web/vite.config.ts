import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Capacitor's default webDir. Changing this means changing capacitor.config.ts too.
    outDir: 'dist',
    // Source maps only in dev: a packaged app ships neither the maps nor the download cost.
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Needed for `cap run` live-reload against a device on the LAN.
    host: true,
  },
});
