/// <reference types="vite/client" />

// Build-time settings: where the static assets and the API live (config.ts).
interface ImportMetaEnv {
  readonly VITE_NGSPICE_URL?: string;
  readonly VITE_REGISTRY_URL?: string;
  readonly VITE_API_URL?: string;
}
