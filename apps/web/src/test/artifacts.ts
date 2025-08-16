// Build artifacts the integration tests use: the Node build of circuit-core (pkg-node), the
// registry bundle and the demo circuit. Tests skip without them, unless REQUIRE_NGSPICE is set (CI),
// where a missing artifact is an error. Build them with tools/parity/run.sh.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Circuit, Registry } from "../gen/contract.ts";
import type { CoreModule } from "../core/types.ts";

export const repo = join(import.meta.dirname, "../../../..");
const manifest = readFileSync(join(repo, "registry/manifest.yaml"), "utf8");
export const registryVersion = /^version:\s*"?([^"\s]+)"?/m.exec(manifest)![1]!;
export const bundlePath = join(repo, `target/registry/registry-${registryVersion}.json`);
export const spritePath = join(repo, `target/registry/registry-${registryVersion}/symbols.svg`);
export const corePkg = join(repo, "crates/circuit-core-wasm/pkg-node/core.js");
export const demoPath = join(repo, "crates/circuit-core/tests/fixtures/demo_sallen_key.json");

export function missingArtifacts(...extra: string[]): string[] {
  const missing = [bundlePath, spritePath, corePkg, ...extra].filter((p) => !existsSync(p));
  if (missing.length && process.env.REQUIRE_NGSPICE) throw new Error(`missing build artifacts: ${missing.join(", ")}`);
  return missing;
}

export const bundleJson = (): string => readFileSync(bundlePath, "utf8");
export const bundle = (): Registry => JSON.parse(bundleJson()) as Registry;
export const demoJson = (): string => readFileSync(demoPath, "utf8");
export const demo = (): Circuit => JSON.parse(demoJson()) as Circuit;
export const loadCore = (): CoreModule => createRequire(import.meta.url)(corePkg) as CoreModule;
