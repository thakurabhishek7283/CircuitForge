#![allow(dead_code)]

use std::path::PathBuf;

use circuit_core::apply::Applied;
use circuit_core::ops::envelope_from_value;
use circuit_core::{Circuit, OpEnvelope, OpError, Registry, apply};
use serde_json::{Value, json};

#[path = "../../examples/support/registry_dir.rs"]
mod registry_dir;

pub fn registry_root() -> PathBuf {
    registry_dir::repo_root().join("registry")
}

/// Load `registry/` from disk through the real YAML/SVG loader.
pub fn registry() -> Registry {
    registry_dir::load(&registry_root())
}

/// The registry plus its sprite sheet.
pub fn registry_sources() -> circuit_core::registry::Loaded {
    registry_dir::load_sources(&registry_root())
}

pub fn op(name: &str, body: Value) -> Value {
    json!({ "op": name, "body": body })
}

/// Wrap `{op, body}` in an envelope addressed to the circuit's current rev.
pub fn env(c: &Circuit, author: &str, op: &Value) -> OpEnvelope {
    let mut v = op.clone();
    v["v"] = json!(1);
    v["seq"] = json!(c.rev + 1);
    v["author"] = json!(author);
    v["base_rev"] = json!(c.rev);
    if author == "llm" {
        v["job"] = json!("j_test");
    }
    envelope_from_value(v).unwrap_or_else(|e| panic!("bad test op {op}: {e}"))
}

pub fn try_op(c: &Circuit, reg: &Registry, author: &str, op: &Value) -> Result<Applied, OpError> {
    apply(c, reg, &env(c, author, op))
}

pub fn run(c: &Circuit, reg: &Registry, author: &str, ops: &[Value]) -> Circuit {
    let mut cur = c.clone();
    for o in ops {
        cur = try_op(&cur, reg, author, o).unwrap_or_else(|e| panic!("{o} failed: {e}")).circuit;
    }
    cur
}

/// Equal apart from `rev` (undo moves rev forward, it never rewinds it).
pub fn same_ir(a: &Circuit, b: &Circuit) -> bool {
    let (mut a, mut b) = (a.clone(), b.clone());
    a.rev = 0;
    b.rev = 0;
    a == b
}

/// b1: ±12 V split supply.
pub fn supply_ops() -> Vec<Value> {
    vec![
        op(
            "block.begin",
            json!({"id": "b1", "role": "supply", "title": "±12 V supply", "ports": [
                {"name": "vcc", "direction": "power_pos", "net": "VCC"},
                {"name": "vee", "direction": "power_neg", "net": "VEE"},
                {"name": "gnd", "direction": "ground", "net": "GND"}]}),
        ),
        op("part.add", json!({"refdes": "V1", "part": "vsource_dc", "params": {"voltage": "12"}, "block": "b1"})),
        op("part.add", json!({"refdes": "V2", "part": "vsource_dc", "params": {"voltage": "12"}, "block": "b1"})),
        op("net.connect", json!({"net": "VCC", "pins": ["V1.P"], "kind": {"kind": "power", "volts": 12.0}})),
        op("net.connect", json!({"net": "GND", "pins": ["V1.N", "V2.P"]})),
        op("net.connect", json!({"net": "VEE", "pins": ["V2.N"], "kind": {"kind": "power", "volts": -12.0}})),
        op("block.commit", json!({"id": "b1"})),
    ]
}

/// b2: 1 V, 1 kHz sine source on N_IN.
pub fn source_ops() -> Vec<Value> {
    vec![
        op(
            "block.begin",
            json!({"id": "b2", "role": "source", "title": "Signal source", "ports": [
                {"name": "out", "direction": "output", "net": "N_IN"}]}),
        ),
        op(
            "part.add",
            json!({"refdes": "V3", "part": "vsource_sine", "params": {"amplitude": "1", "frequency": "1k"}, "block": "b2"}),
        ),
        op("net.connect", json!({"net": "N_IN", "pins": ["V3.P"]})),
        op("net.connect", json!({"net": "GND", "pins": ["V3.N"]})),
        op("block.commit", json!({"id": "b2"})),
    ]
}

/// b3: the LLD §12 Sallen-Key low-pass (fc ≈ 1 kHz, Q ≈ 0.707), unit B of U1 unused.
pub fn sallen_key_ops() -> Vec<Value> {
    vec![
        op(
            "block.begin",
            json!({"id": "b3", "role": "filter", "title": "Sallen-Key low-pass", "template": "sallen_key_lp",
                "spec": {"fc_hz": {"target": 1000.0, "tol_pct": 10.0}, "q": {"target": 0.707, "tol_pct": 15.0}},
                "ports": [
                    {"name": "in", "direction": "input", "net": "N_IN"},
                    {"name": "out", "direction": "output", "net": "N_OUT"},
                    {"name": "vcc", "direction": "power_pos", "net": "VCC"},
                    {"name": "vee", "direction": "power_neg", "net": "VEE"},
                    {"name": "gnd", "direction": "ground", "net": "GND"}]}),
        ),
        op("part.add", json!({"refdes": "R1", "part": "resistor_th", "params": {"resistance": "10k"}})),
        op("part.add", json!({"refdes": "R2", "part": "resistor_th", "params": {"resistance": "10k"}})),
        op("part.add", json!({"refdes": "C1", "part": "cap_film", "params": {"capacitance": "22n"}})),
        op("part.add", json!({"refdes": "C2", "part": "cap_film", "params": {"capacitance": "12n"}})),
        op("part.add", json!({"refdes": "U1", "part": "opamp_tl072"})),
        op("net.connect", json!({"net": "N_IN", "pins": ["R1.1"]})),
        op("net.connect", json!({"net": "N_A", "pins": ["R1.2", "R2.1", "C1.1"]})),
        op("net.connect", json!({"net": "N_B", "pins": ["R2.2", "C2.1", "U1.INP_A"]})),
        op("net.connect", json!({"net": "N_OUT", "pins": ["U1.OUT_A", "U1.INM_A", "C1.2"]})),
        op("net.connect", json!({"net": "GND", "pins": ["C2.2"]})),
        op("net.connect", json!({"net": "VCC", "pins": ["U1.VCC"]})),
        op("net.connect", json!({"net": "VEE", "pins": ["U1.VEE"]})),
        op("hint.add", json!({"hint": {"kind": "group", "block": "b3"}})),
        op("block.commit", json!({"id": "b3"})),
    ]
}

/// Stream LLM ops whose envelopes carry `block` (parts without a body block join it).
pub fn run_in_block(c: &Circuit, reg: &Registry, block: &str, ops: &[Value]) -> Circuit {
    let mut cur = c.clone();
    for o in ops {
        let mut e = env(&cur, "llm", o);
        e.block = Some(block.into());
        cur = apply(&cur, reg, &e).unwrap_or_else(|err| panic!("{o}: {err}")).circuit;
    }
    cur
}

/// The whole demo circuit, as the LLM would stream it. Filter ops carry block b3 in the envelope.
pub fn demo_circuit(reg: &Registry) -> Circuit {
    let mut c = Circuit::new(reg.version.clone());
    c = run(&c, reg, "llm", &supply_ops());
    c = run(&c, reg, "llm", &source_ops());
    c = run_in_block(&c, reg, "b3", &sallen_key_ops());
    run(
        &c,
        reg,
        "llm",
        &[op(
            "analysis.set",
            json!({"analyses": [{"type": "op"}, {"type": "ac", "points_per_decade": 20, "f_start": 10.0, "f_stop": 100000.0}]}),
        )],
    )
}
