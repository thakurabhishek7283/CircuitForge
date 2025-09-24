// Binding-level tests for the Node build of @tutor/core. Core semantics are covered by the Rust
// tests and the parity gate; these cover the JS surface (constructors, throws, getters, fork).
// usage: node --test crates/circuit-core-wasm/tests/core.test.mjs   (after wasm-pack build --target nodejs --out-dir pkg-node --out-name core)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const core = require("../pkg-node/core.js");
const manifest = readFileSync(new URL("../../../registry/manifest.yaml", import.meta.url), "utf8");
const version = manifest.match(/^version:\s*"?([^"\s]+)"?/m)[1];
const bundle = readFileSync(new URL(`../../../target/registry/registry-${version}.json`, import.meta.url), "utf8");
const registry = core.CoreRegistry.fromJson(bundle);
const env = (s, op, body, author = "user") =>
  JSON.stringify({ v: 1, seq: s.rev + 1, op, author, base_rev: s.rev, body });

test("registry loads; bad input throws", () => {
  assert.equal(registry.version, version);
  assert.ok(JSON.parse(bundle).symbols.opamp.pins.OUT);
  assert.throws(() => core.CoreRegistry.fromJson("{}"));
  assert.throws(() => new core.CoreSession(registry, '{"schema_version":1}'));
});

test("apply returns ok/err outcomes and undo restores", () => {
  const s = new core.CoreSession(registry);
  const ok = JSON.parse(s.apply(env(s, "part.add", { refdes: "R1", part: "resistor_th" }))).ok;
  assert.deepEqual(ok.patch.parts_upserted, ["R1"]);
  const data = JSON.parse(s.changes(JSON.stringify(ok.patch))).ok;
  assert.equal(data.parts.R1.params.resistance.display, "10kΩ");
  assert.equal(s.rev, 1);
  const err = JSON.parse(s.apply(env(s, "part.add", { refdes: "R1", part: "resistor_th" }))).err;
  assert.equal(err.code, "refdes_conflict");
  const undo = JSON.parse(s.applyOps(JSON.stringify(ok.inverse), "user")).ok;
  assert.deepEqual(undo.patch.parts_removed, ["R1"]);
});

test("fork is independent and snapshots restore", () => {
  const s = new core.CoreSession(registry);
  JSON.parse(s.apply(env(s, "part.add", { refdes: "C1", part: "cap_film", params: { capacitance: "4u7" } }))).ok;
  const f = s.fork();
  f.apply(env(f, "part.remove", { refdes: "C1" }));
  assert.equal(s.rev, 1);
  assert.equal(f.rev, 2);
  const r = new core.CoreSession(registry, s.snapshot());
  assert.equal(r.snapshot(), s.snapshot());
  assert.match(r.circuitText(), /C1 cap_film capacitance=4\.7µF/);
});

test("parseQuantity and coreVersion", () => {
  assert.equal(JSON.parse(core.parseQuantity("4k7", "ohm")).ok.display, "4.7kΩ");
  assert.ok(JSON.parse(core.parseQuantity("4k7", "parsec")).err);
  assert.match(core.coreVersion(), /^\d+\.\d+\.\d+$/);
});

test("edit helpers: nextRefdes and connect", () => {
  const s = new core.CoreSession(registry);
  assert.equal(JSON.parse(s.nextRefdes("cap_film")).ok, "C1");
  for (const refdes of ["C1", "C2"]) s.apply(env(s, "part.add", { refdes, part: "cap_film" }));
  const ops = JSON.parse(s.connect("C1.1", JSON.stringify({ pin: "C2.2" }))).ok;
  assert.deepEqual(ops, [{ op: "net.connect", body: { net: "N1", pins: ["C1.1", "C2.2"] } }]);
  JSON.parse(s.applyOps(JSON.stringify(ops), "user")).ok;
  assert.equal(JSON.parse(s.connect("C2.2", JSON.stringify({ net: "N1" }))).err.code, "pin_already_connected");
  assert.equal(JSON.parse(s.connect("C2", "{}")).err.code, "schema_error");
});

test("block templates: preview, insert, verify points, spec checks", () => {
  const s = new core.CoreSession(registry);
  const req = JSON.stringify({ template: "sallen_key_lp", targets: { fc_hz: "2k" } });
  const preview = JSON.parse(s.previewBlock(req)).ok;
  assert.equal(preview.targets.fc_hz.display, "2kHz");
  assert.deepEqual(Object.keys(preview.values).sort(), ["C1", "C2", "R1", "R2", "U1"]);
  const ins = JSON.parse(s.insertBlock(req)).ok;
  assert.equal(ins.block, "b1");
  assert.equal(ins.ops[0].op, "block.begin");
  assert.equal(ins.ops.at(-1).op, "block.commit");
  JSON.parse(s.applyOps(JSON.stringify(ins.ops), "template")).ok;
  assert.equal(JSON.parse(s.snapshot()).parts.U1.origin.kind, "template");
  assert.equal(JSON.parse(s.insertBlock(JSON.stringify({ template: "nope" }))).err.code, "template_not_found");

  let netlist = JSON.parse(s.compile('{"interactive": true}')).ok;
  assert.match(netlist.checks[0].missing, /needs a signal/);
  const src = JSON.parse(s.insertBlock(JSON.stringify({ template: "sine_source", ports: { out: { net: "B1_IN" } } }))).ok;
  JSON.parse(s.applyOps(JSON.stringify(src.ops), "template")).ok;
  netlist = JSON.parse(s.compile('{"interactive": true}')).ok;
  assert.deepEqual(netlist.checks.map((c) => c.name), ["fc_hz", "q", "amplitude_v"]);
  const meas = { b1_fc_hz_ref: 0, b1_fc_hz_x: 2050 };
  const results = JSON.parse(core.evaluateChecks(JSON.stringify(netlist.checks), JSON.stringify(meas))).ok;
  assert.equal(results[0].pass, true);
  assert.equal(results[0].measured_display, "2.05kHz");
  assert.equal(results[1].pass, false);
  assert.equal(JSON.parse(registry.verifyPoints("sallen_key_lp")).ok.length, 5);
});

test("a template block's verification bench", () => {
  const s = new core.CoreSession(registry);
  const ins = JSON.parse(s.insertBlock(JSON.stringify({ template: "rc_lowpass" }))).ok;
  JSON.parse(s.applyOps(JSON.stringify(ins.ops), "template")).ok;
  const bench = JSON.parse(s.benchOps("b1")).ok;
  assert.equal(bench.length, 6);
  JSON.parse(s.applyOps(JSON.stringify(bench), "user")).ok;
  assert.equal(JSON.parse(s.benchOps("b9")).err.code, "block_not_found");
  s.free();
});
