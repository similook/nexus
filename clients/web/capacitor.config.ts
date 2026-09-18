import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.nexus.app',
  appName: 'Nexus',
  webDir: 'dist',
  android: {
    // The WebView is not the tunnel. Cleartext stays off — anything the UI talks to is either
    // the local plugin bridge or nothing at all.
    allowMixedContent: false,
  },
};

export default config;
