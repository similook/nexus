import { readFileSync } from 'node:fs';
import type { CapacitorConfig } from '@capacitor/cli';

/** The Google Mobile Ads plugin. See src/core/admob.ts. */
export const ADMOB_PLUGIN = '@capacitor-community/admob';

/**
 * The plugins `cap sync` links into the Android project.
 *
 * Capacitor's default is every dependency that is a plugin. An ads build (VITE_NEXUS_ADS=test or
 * live, set for the sync as well as for the web build) keeps that default; every other build
 * links all of them except AdMob, so its APK carries no ad SDK at all - no Google ad code, no
 * advertising-ID permission, nothing of it that runs at start-up. The plugin's manifest entries
 * follow it (android/app/build.gradle, adsIncluded).
 *
 * `undefined` means Capacitor's default list.
 */
export function androidPlugins(dependencies: string[], adsMode: string | undefined): string[] | undefined {
  if (adsMode === 'test' || adsMode === 'live') return undefined;
  return dependencies.filter((name) => name !== ADMOB_PLUGIN);
}

// Read from the working directory, as the Capacitor CLI resolves the project: this file is
// evaluated by `npx cap` run in clients/web.
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const config: CapacitorConfig = {
  appId: 'io.nexus.app',
  appName: 'Nexus VPN',
  webDir: 'dist',
  android: {
    // The WebView is not the tunnel. Cleartext stays off — anything the UI talks to is either
    // the local plugin bridge or nothing at all.
    allowMixedContent: false,
    includePlugins: androidPlugins(
      [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})],
      process.env.VITE_NEXUS_ADS,
    ),
  },
};

export default config;
