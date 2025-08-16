// Where the static assets live. Defaults are served by the app itself (vite.config.ts copies them
// into the build); a CDN deployment points them elsewhere at build time.
//   ngspice.mjs/.wasm + COPYING: third_party/ngspice/build-wasm.sh
//   registry-<ver>.json, registry-<ver>/{symbols.svg, models/*}: cargo run -p circuit-core --example bundle_registry
export const NGSPICE_URL = import.meta.env.VITE_NGSPICE_URL ?? "/ngspice/ngspice.mjs";
export const REGISTRY_URL = (import.meta.env.VITE_REGISTRY_URL ?? "/registry").replace(/\/$/, "");

export const registryBundleUrl = (version: string): string => `${REGISTRY_URL}/registry-${version}.json`;
export const registryAssetUrl = (version: string, path: string): string => `${REGISTRY_URL}/registry-${version}/${path}`;
