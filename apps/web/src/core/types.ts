// The surface of @tutor/core (crates/circuit-core-wasm) the app uses. Both its builds (web and
// Node) satisfy it; the store depends on this, not on a build, so tests run the real core in Node.
// Results are JSON strings `{"ok": …} | {"err": …}` (contract/schema/apply_result.schema.json).

export interface CoreRegistryLike {
  readonly version: string;
}

export interface CoreSessionLike {
  readonly rev: number;
  apply(envelope: string): string;
  applyOps(ops: string, author: string): string;
  changes(patch: string): string;
  compile(opts: string): string;
  erc(ctx: string, scope?: string | null): string;
  snapshot(): string;
  /** Lowest free refdes for a new instance of a registry part. */
  nextRefdes(part: string): string;
  /** Ops for a wire from a pin to a `WireEnd`; apply them as one batch. */
  connect(from: string, to: string): string;
  /** Solved values and spec for an `InsertBlock` request: `Preview`. */
  previewBlock(req: string): string;
  /** Ops inserting a template block: `Inserted`; apply them as one batch, author "template". */
  insertBlock(req: string): string;
}

export interface CoreModule {
  CoreRegistry: { fromJson(bundle: string): CoreRegistryLike };
  CoreSession: new (registry: CoreRegistryLike, snapshot?: string | null) => CoreSessionLike;
  parseQuantity(text: string, unit: string): string;
  /** `Netlist.checks` + a result's `meas` → `CheckResult[]`. */
  evaluateChecks(checks: string, meas: string): string;
}

export type Outcome<T, E> = { ok: T; err?: undefined } | { ok?: undefined; err: E };

export function outcome<T, E>(json: string): Outcome<T, E> {
  return JSON.parse(json) as Outcome<T, E>;
}

/** For results that cannot fail unless core and app disagree (a version-skew bug). */
export function expectOk<T>(json: string, what: string): T {
  const r = outcome<T, unknown>(json);
  if (r.err !== undefined) throw new Error(`${what}: ${JSON.stringify(r.err)}`);
  return r.ok as T;
}
