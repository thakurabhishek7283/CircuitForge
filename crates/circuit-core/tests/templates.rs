//! Block templates (LLD §12): every template instantiates at its 5 verification points into a
//! clean, compilable circuit; insertion is one undoable batch; bad requests are refused. The
//! simulation half of verification runs on ngspice in tools/sim/test_templates.py.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;

use circuit_core::erc::{ErcContext, Severity};
use circuit_core::error::ErrorCode;
use circuit_core::ir::{Analysis, BlockRole, NetKind, PortDirection};
use circuit_core::ops::{Author, Op};
use circuit_core::spice::CompileOpts;
use circuit_core::template::{InsertBlock, PortBinding, TemplateDef, verify_points};
use circuit_core::{Registry, Session};
use common::*;
use serde_json::json;

fn reg() -> Arc<Registry> {
    Arc::new(registry())
}

fn insert(s: &mut Session, req: InsertBlock) -> circuit_core::template::Inserted {
    let ins = s.insert_block(&req).unwrap_or_else(|e| panic!("{}: {e}", req.template));
    s.apply_ops(&ins.ops, Author::Template).unwrap_or_else(|e| panic!("{}: {e}", req.template));
    ins
}

fn req(template: &str) -> InsertBlock {
    InsertBlock { template: template.into(), targets: Default::default(), ports: Default::default(), id: None }
}

/// The CI test bench around a template block: its `verify` sources and loads.
fn bench(s: &mut Session, t: &TemplateDef, block: &str) {
    let v = t.verify.clone().unwrap_or_default();
    let port_net =
        |s: &Session, port: &str| s.circuit().blocks[block].ports.iter().find(|p| p.name == port).unwrap().net.clone();
    let mut ops = Vec::new();
    for (port, d) in &v.drive {
        let r = s.next_refdes("vsource_sine").unwrap();
        let net = port_net(s, port);
        ops.push(json!({"op": "part.add", "body": {"refdes": r, "part": "vsource_sine", "params": {
            "offset": d.offset.to_string(), "amplitude": d.amplitude.to_string(), "frequency": d.frequency.to_string()}}}));
        ops.push(json!({"op": "net.connect", "body": {"net": net, "pins": [format!("{r}.P")]}}));
        ops.push(json!({"op": "net.connect", "body": {"net": "GND", "pins": [format!("{r}.N")], "kind": {"kind": "ground"}}}));
        let ops_now: Vec<Op> = ops.drain(..).map(|o| serde_json::from_value(o).unwrap()).collect();
        s.apply_ops(&ops_now, Author::User).unwrap();
    }
    for (port, ohms) in &v.load {
        let r = s.next_refdes("resistor_th").unwrap();
        let net = port_net(s, port);
        let ops: Vec<Op> = [
            json!({"op": "part.add", "body": {"refdes": r, "part": "resistor_th", "params": {"resistance": ohms.to_string()}}}),
            json!({"op": "net.connect", "body": {"net": net, "pins": [format!("{r}.1")]}}),
            json!({"op": "net.connect", "body": {"net": "GND", "pins": [format!("{r}.2")], "kind": {"kind": "ground"}}}),
        ]
        .into_iter()
        .map(|o| serde_json::from_value(o).unwrap())
        .collect();
        s.apply_ops(&ops, Author::User).unwrap();
    }
}

#[test]
fn twenty_templates_cover_every_role() {
    let reg = reg();
    assert_eq!(reg.templates.len(), 20);
    let roles: BTreeSet<String> = reg.templates.values().map(|t| format!("{:?}", t.role)).collect();
    for role in [
        BlockRole::Amplifier,
        BlockRole::Filter,
        BlockRole::Buffer,
        BlockRole::Oscillator,
        BlockRole::Supply,
        BlockRole::Comparator,
        BlockRole::Bias,
        BlockRole::Source,
    ] {
        assert!(roles.contains(&format!("{role:?}")), "no {role:?} template");
    }
}

/// LLD §12 step 2, structural half: each template at each of its 5 points, with its test bench,
/// is clean under the LLM-block ERC, compiles with every check, and undoes in one step.
#[test]
fn every_template_instantiates_at_its_verify_points() {
    let reg = reg();
    for t in reg.templates.values() {
        let points = verify_points(t);
        assert_eq!(points.len(), 5, "{}", t.id);
        for (k, p) in points.iter().enumerate() {
            let what = format!("{} point {k} {:?} {:?}", t.id, p.targets, p.rails);
            let mut s = Session::new(reg.clone(), None).unwrap();
            let ports = p
                .rails
                .iter()
                .map(|(port, v)| (port.clone(), PortBinding::Rail { net: t.rails[port].net.clone(), volts: *v }))
                .collect();
            let r = InsertBlock { template: t.id.clone(), targets: p.targets.clone(), ports, id: None };
            let ins = insert(&mut s, r);
            assert_eq!(ins.block, "b1");
            assert_eq!(s.circuit().blocks["b1"].template.as_deref(), Some(t.id.as_str()));
            for (port, dir) in &t.ports {
                if *dir == PortDirection::Input {
                    assert!(
                        t.verify.as_ref().is_some_and(|v| v.drive.contains_key(port)),
                        "{what}: {port} is not driven"
                    );
                }
            }
            bench(&mut s, t, "b1");

            let errors: Vec<_> =
                s.erc(ErcContext::LlmBlock, None).into_iter().filter(|i| i.severity == Severity::Error).collect();
            assert!(errors.is_empty(), "{what}: {errors:#?}");

            let n = s.compile(&CompileOpts { interactive: true, ..Default::default() }).unwrap();
            assert_eq!(n.checks.len(), t.checks.len(), "{what}");
            for ch in &n.checks {
                assert!(ch.missing.is_none(), "{what}: {} {:?}", ch.name, ch.missing);
            }
            for (port, rail) in &t.rails {
                let driven_by_block = t.nets[port].iter().any(|p| {
                    let def = &reg.parts[&t.parts[&p.refdes].part];
                    def.pin(&p.pin).unwrap().kind == circuit_core::registry::PinType::Output
                });
                let line = format!("Vrail_{} ", rail.net.to_ascii_lowercase());
                assert_eq!(n.text.contains(&line), !driven_by_block, "{what}: {port} rail source\n{}", n.text);
            }
        }
    }
}

#[test]
fn insertion_is_one_undo_step() {
    let reg = reg();
    let mut s = Session::new(reg.clone(), None).unwrap();
    let ins = s.insert_block(&req("sallen_key_lp")).unwrap();
    let ok = s.apply_ops(&ins.ops, Author::Template).unwrap();
    let c = s.circuit();
    assert_eq!(c.parts.len(), 5);
    assert!(c.parts.values().all(|p| p.block.as_deref() == Some("b1")));
    assert!(matches!(&c.parts["U1"].origin, circuit_core::ir::Origin::Template { id } if id == "sallen_key_lp"));
    assert_eq!(c.nets["VCC"].kind, NetKind::Power { volts: 12.0 });
    assert_eq!(c.nets["VEE"].kind, NetKind::Power { volts: -12.0 });
    assert!(c.nets.contains_key("B1_IN") && c.nets.contains_key("B1_OUT") && c.nets.contains_key("B1_N_A"));
    assert_eq!(c.blocks["b1"].spec["fc_hz"].target, 1000.0);
    assert_eq!(c.analyses, [Analysis::Ac { points_per_decade: 50, f_start: 10.0, f_stop: 1e5 }]);
    assert_eq!(format!("{:?}", c.blocks["b1"].status), "Committed");

    s.apply_ops(&ok.inverse, Author::User).unwrap();
    let empty = Session::new(reg, None).unwrap();
    assert!(same_ir(s.circuit(), empty.circuit()));
}

#[test]
fn second_block_reuses_rails_and_binds_ports() {
    let reg = reg();
    let mut s = Session::new(reg, None).unwrap();
    insert(&mut s, req("sine_source"));
    let mut r = req("noninverting_amp");
    r.targets.insert("gain".into(), "4.7".into());
    r.ports.insert("in".into(), PortBinding::Net("B1_OUT".into()));
    let ins = insert(&mut s, r);
    assert_eq!(ins.block, "b2");
    let c = s.circuit();
    assert!(c.nets["B1_OUT"].pins.iter().any(|p| p.refdes == "U1"), "the amplifier input joined the source's net");
    assert_eq!(c.blocks["b2"].ports.iter().find(|p| p.name == "in").unwrap().net, "B1_OUT");
    assert_eq!(ins.refdes["R1"], "R1");
    // A third block numbers its parts after the ones present.
    let ins = insert(&mut s, req("inverting_amp"));
    assert_eq!((ins.refdes["R1"].as_str(), ins.refdes["U1"].as_str()), ("R3", "U2"));
    assert!(s.circuit().nets.contains_key("B3_IN"));
}

#[test]
fn bad_requests_are_refused() {
    let reg = reg();
    let s = Session::new(reg.clone(), None).unwrap();
    let code = |r: InsertBlock| s.insert_block(&r).unwrap_err().code;

    assert_eq!(code(req("flux_capacitor")), ErrorCode::TemplateNotFound);
    let mut r = req("rc_lowpass");
    r.targets.insert("fc_hz".into(), "1meg".into());
    let e = s.insert_block(&r).unwrap_err();
    assert_eq!(e.code, ErrorCode::TargetOutOfRange);
    assert!(e.message.contains("Cutoff frequency must be 10Hz to 100kHz"), "{}", e.message);
    r.targets.insert("fc_hz".into(), "1kΩ".into());
    assert_eq!(code(r.clone()), ErrorCode::TargetOutOfRange);
    let mut r = req("rc_lowpass");
    r.targets.insert("q".into(), "1".into());
    assert_eq!(code(r), ErrorCode::TargetOutOfRange);

    let mut r = req("rc_lowpass");
    r.ports.insert("in".into(), PortBinding::Rail { net: "VCC".into(), volts: 5.0 });
    assert_eq!(code(r), ErrorCode::PortInvalid);
    let mut r = req("rc_lowpass");
    r.ports.insert("out".into(), PortBinding::Net("NOPE".into()));
    assert_eq!(code(r), ErrorCode::PortInvalid);
    let mut r = req("sallen_key_lp");
    r.ports.insert("vcc".into(), PortBinding::Rail { net: "VCC".into(), volts: 5.0 });
    let e = s.insert_block(&r).unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (ErrorCode::TargetOutOfRange, "vcc must be 9 to 15 V, not 5 V"));

    // An existing rail at another voltage cannot be reused as this block's VCC.
    let mut s2 = Session::new(reg.clone(), None).unwrap();
    let mut r = req("divider_bias");
    r.ports.insert("vcc".into(), PortBinding::Rail { net: "VCC".into(), volts: 5.0 });
    r.targets.insert("vout_v".into(), "2".into());
    insert(&mut s2, r);
    let e = s2.insert_block(&req("sallen_key_lp")).unwrap_err();
    assert_eq!(e.code, ErrorCode::PortInvalid, "{e}");
    let mut r = req("sallen_key_lp");
    r.ports.insert("vcc".into(), PortBinding::Net("VCC".into()));
    assert_eq!(s2.insert_block(&r).unwrap_err().code, ErrorCode::TargetOutOfRange);
}

#[test]
fn checks_widen_the_circuits_analyses() {
    let reg = reg();
    let demo =
        std::fs::read_to_string(registry_root().join("../crates/circuit-core/tests/fixtures/demo_sallen_key.json"))
            .unwrap();
    let mut s = Session::new(reg, Some(serde_json::from_str(&demo).unwrap())).unwrap();
    let mut r = req("mfb_bandpass");
    r.targets.insert("f0_hz".into(), "20".into());
    insert(&mut s, r);
    let ac: Vec<_> = s.circuit().analyses.iter().filter(|a| matches!(a, Analysis::Ac { .. })).collect();
    assert_eq!(ac, [&Analysis::Ac { points_per_decade: 50, f_start: 0.1, f_stop: 1e5 }], "one AC sweep, widened");
    let mut r = req("astable_555");
    r.targets.insert("freq_hz".into(), "100".into());
    insert(&mut s, r);
    assert!(
        s.circuit().analyses.contains(&Analysis::Tran { t_step: 5e-5, t_stop: 0.16 }),
        "{:?}",
        s.circuit().analyses
    );
}

#[test]
fn an_undriven_rail_is_an_ideal_supply() {
    let reg = registry();
    let c = run(
        &circuit_core::Circuit::new(reg.version.clone()),
        &reg,
        "user",
        &[
            op("part.add", json!({"refdes": "R1", "part": "resistor_th"})),
            op("net.connect", json!({"net": "VCC", "pins": ["R1.1"], "kind": {"kind": "power", "volts": 5.0}})),
            op("net.connect", json!({"net": "GND", "pins": ["R1.2"], "kind": {"kind": "ground"}})),
        ],
    );
    assert!(circuit_core::erc(&c, &reg, ErcContext::UserEdit, None).is_empty());
    let n = circuit_core::compile(&c, &reg, &CompileOpts { shunt_floating: true, ..Default::default() }).unwrap();
    assert!(n.text.contains("Vrail_vcc vcc 0 DC 5e0\n"), "{}", n.text);
    assert!(!n.text.contains("Rshunt"));
}
