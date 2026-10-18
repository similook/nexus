/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `test` or `live` turns AdMob on; unset or anything else leaves it off. See core/admob.ts. */
  readonly VITE_NEXUS_ADS?: string;
  /** The live interstitial unit id. Read only with VITE_NEXUS_ADS=live. */
  readonly VITE_NEXUS_ADMOB_INTERSTITIAL?: string;
}
