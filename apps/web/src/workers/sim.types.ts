// Simulation worker contract (LLD §8). Hand-written: these types never cross the REST/SSE
// boundary, so they are not part of the generated contract.
import type { Analysis } from "../gen/contract.ts";

export type SimStatus =
  | "ok"
  | "no_convergence"
  | "singular_matrix"
  | "timeout"
  // Addition to LLD §8: the deck was rejected or ngspice failed for a reason the tutor must not
  // explain as a convergence problem (unknown model, missing include, ngspice fatal error).
  | "error";

export type SimUnit = "V" | "A" | "Hz" | "s";

export interface SimVector {
  /** Canonical name: `v(n_out)`, `i(v1)`, `@r1[i]`, `time`, `frequency`, `v-sweep`. */
  name: string;
  /** Addition to LLD §8: one run yields one plot per analysis, and `v(n_out)` exists in each. */
  analysis: Analysis["type"];
  unit: SimUnit;
  /** Real part. Transferred to the caller, not copied. */
  data: Float64Array;
  /** Addition to LLD §8: imaginary part of complex (AC) vectors. */
  imag?: Float64Array;
}

export interface SimResult {
  hash: string;
  vectors: SimVector[];
  /** `.meas` results by name; a measurement that fails is absent. */
  meas: Record<string, number>;
  status: SimStatus;
  log: string;
  ms: number;
}

export interface SimRequest {
  netlist: string;
  hash: string;
  analyses: Analysis[];
}

export interface SimApi {
  /** Loads ngspice.wasm and the registry's model files into MEMFS. */
  init(registryVersion: string): Promise<void>;
  run(req: SimRequest): Promise<SimResult>;
}
