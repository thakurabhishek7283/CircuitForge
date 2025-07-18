// End to end on the browser's path: IR snapshot -> circuit-core (WASM) compile -> ngspice (WASM).
// Needs the built artifacts; skipped without them unless REQUIRE_NGSPICE is set (CI).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Ngspice, loadModels, simulate, type NgspiceModule } from "./sim.engine.ts";

const repo = join(import.meta.dirname, "../../../..");
const ngspiceJs = join(repo, "third_party/ngspice/dist/wasm/ngspice.mjs");
const corePkg = join(repo, "crates/circuit-core-wasm/pkg-node/core.js");
const manifest = readFileSync(join(repo, "registry/manifest.yaml"), "utf8");
const version = /^version:\s*"?([^"\s]+)"?/m.exec(manifest)![1]!;
const bundle = join(repo, `target/registry/registry-${version}.json`);
const missing = [ngspiceJs, corePkg, bundle].filter((p) => !existsSync(p));
if (missing.length && process.env.REQUIRE_NGSPICE) throw new Error(`missing build artifacts: ${missing.join(", ")}`);

interface Netlist {
  text: string;
  hash: string;
  includes: string[];
}

async function setup() {
  const core = createRequire(import.meta.url)(corePkg);
  const reg = core.CoreRegistry.fromJson(readFileSync(bundle, "utf8"));
  const snapshot = readFileSync(join(repo, "crates/circuit-core/tests/fixtures/demo_sallen_key.json"), "utf8");
  const session = new core.CoreSession(reg, snapshot);
  const compile = (opts: object): Netlist => {
    const out = JSON.parse(session.compile(JSON.stringify(opts)));
    if (!out.ok) throw new Error(JSON.stringify(out.err));
    return out.ok;
  };
  const { default: createNgspice } = (await import(ngspiceJs)) as { default: () => Promise<NgspiceModule> };
  const ng = new Ngspice(await createNgspice());
  const n = compile({});
  loadModels(ng, "/registry", Object.fromEntries(n.includes.map((p) => [p, readFileSync(join(repo, "registry", p), "utf8")])));
  return { ng, compile };
}

describe.skipIf(missing.length > 0)("ngspice WASM", () => {
  it("simulates the demo Sallen-Key and meets its spec", async () => {
    const { ng, compile } = await setup();
    const n = compile({});
    const deck = n.text.replace(
      "\n.end\n",
      "\n.meas ac g_pass find vdb(n_out) at=10\n.meas ac fc when vdb(n_out)=g_pass-3\n.end\n",
    );
    const r = simulate(ng, { netlist: deck, hash: n.hash, analyses: [] });
    expect(r.status, r.log).toBe("ok");
    expect(r.hash).toBe(n.hash);
    expect(r.meas.fc).toBeGreaterThan(900);
    expect(r.meas.fc).toBeLessThan(1100);
    const out = r.vectors.find((v) => v.name === "v(n_out)" && v.analysis === "ac")!;
    expect(out.unit).toBe("V");
    expect(out.imag?.length).toBe(out.data.length);
    expect(r.vectors.some((v) => v.name.includes("."))).toBe(false);
  });

  it("runs repeatedly in one instance, fast, and keeps the analyses apart", async () => {
    const { ng, compile } = await setup();
    const n = compile({ analyses: [{ type: "op" }, { type: "tran", t_step: 1e-5, t_stop: 3e-3 }] });
    let last;
    for (let i = 0; i < 5; i++) last = simulate(ng, { netlist: n.text, hash: n.hash, analyses: [] });
    expect(last!.status).toBe("ok");
    expect(new Set(last!.vectors.map((v) => v.analysis))).toEqual(new Set(["op", "tran"]));
    expect(last!.ms).toBeLessThan(150); // LLD §1: re-simulation after an edit
  });

  it("reports a rejected deck as an error", async () => {
    const { ng, compile } = await setup();
    const n = compile({});
    const r = simulate(ng, { netlist: n.text.replace("C2 n_b 0", "XC2 n_b 0 NOSUCH"), hash: n.hash, analyses: [] });
    expect(r.status).toBe("error");
    // and the instance still works afterwards
    expect(simulate(ng, { netlist: n.text, hash: n.hash, analyses: [] }).status).toBe("ok");
  });
});
