import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * The desktop shell's build.
 *
 * WHY AN ALIAS AND NOT AN npm WORKSPACE
 *
 * A workspace root would hoist `node_modules` and change how `clients/web` resolves its own
 * dependencies. `clients/web` is the shipped Android app and is off limits for this phase, and
 * "it probably still resolves the same" is not a standard that survives a release. So the two
 * shells stay independent installs and this alias reaches into the shared sources directly.
 *
 * Vite compiles `../shared/src` as ordinary TypeScript in this project's graph, so React
 * resolves from THIS package's node_modules. One React instance, no duplicate-copy hooks
 * error — the failure that makes a linked package look haunted.
 *
 * Revisit if a third shell appears; two is not enough to justify a workspace migration that
 * touches the Android build.
 */
const shared = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Longest first: '@nexus/shared/index.css' must not be eaten by the bare specifier.
      { find: '@nexus/shared/index.css', replacement: `${shared}/index.css` },
      { find: '@nexus/shared', replacement: `${shared}/index.ts` },
    ],
  },
  server: {
    // Not 5173: that is clients/web's port, and running both at once during the port is
    // routine. A silent collision would have one shell serving the other's bundle.
    port: 5174,
    host: true,
    watch: {
      // src-tauri/target is Cargo's build output: thousands of files, and on Windows Cargo
      // holds build-script executables locked while it builds. Watching them crashed the dev
      // server outright with `EBUSY: resource busy or locked, watch '...\target\debug\build\
      // ...\build_script_build-*.exe'` mid-rebuild. Nothing under src-tauri is frontend
      // source, so the whole tree is excluded - as Tauri's own Vite template does.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
