// Build-time settings (Vite `import.meta.env`); unset in tests.
interface ImportMetaEnv {
  readonly VITE_NGSPICE_URL?: string;
  readonly VITE_REGISTRY_URL?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
