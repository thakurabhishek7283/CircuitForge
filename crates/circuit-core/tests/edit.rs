mod common;

use circuit_core::edit::{WireEnd, connect, next_refdes};
use circuit_core::ir::{NetKind, PinRef};
use circuit_core::ops::{Author, Op};
use circuit_core::{Circuit, ErrorCode, apply_ops};
use common::*;
use serde_json::json;

fn pin(s: &str) -> PinRef {
    s.parse().unwrap()
}

/// Wire `from` to `to` through `connect` + `apply_ops`, checking that undo restores the circuit.
fn wire(c: &Circuit, reg: &circuit_core::Registry, from: &str, to: WireEnd) -> (Circuit, Vec<Op>) {
    let ops = connect(c, reg, &pin(from), &to).unwrap_or_else(|e| panic!("{from}: {e}"));
    let (next, inverse) = apply_ops(c, reg, &ops, Author::User, None).unwrap();
    let (back, _) = apply_ops(&next, reg, &inverse, Author::User, None).unwrap();
    assert!(same_ir(&back, c), "undo of {ops:?} did not restore the circuit");
    (next, ops)
}

fn parts(reg: &circuit_core::Registry, list: &[(&str, &str)]) -> Circuit {
    let ops: Vec<_> = list.iter().map(|(r, p)| op("part.add", json!({"refdes": r, "part": p}))).collect();
    run(&Circuit::new(reg.version.clone()), reg, "user", &ops)
}

#[test]
fn next_refdes_takes_the_lowest_free_number() {
    let reg = registry();
    let c = parts(&reg, &[("R1", "resistor_th"), ("R3", "resistor_th"), ("C1", "cap_film")]);
    assert_eq!(next_refdes(&c, &reg, "resistor_th").unwrap(), "R2");
    assert_eq!(next_refdes(&c, &reg, "cap_elec").unwrap(), "C2");
    assert_eq!(next_refdes(&c, &reg, "opamp_tl072").unwrap(), "U1");
    assert_eq!(next_refdes(&c, &reg, "nope").unwrap_err().code, ErrorCode::PartNotInRegistry);
}

#[test]
fn two_free_pins_make_a_new_net() {
    let reg = registry();
    let c = parts(&reg, &[("R1", "resistor_th"), ("R2", "resistor_th")]);
    let (c, _) = wire(&c, &reg, "R1.2", WireEnd::Pin(pin("R2.1")));
    let n1 = &c.nets["N1"];
    assert_eq!(n1.kind, NetKind::Signal);
    assert!(n1.pins.contains(&pin("R1.2")) && n1.pins.contains(&pin("R2.1")));

    // The next one does not clash with N1, case-insensitively either.
    let (c, _) = wire(&c, &reg, "R1.1", WireEnd::Pin(pin("R2.2")));
    assert!(c.nets.contains_key("N2"));
}

#[test]
fn a_free_pin_joins_the_other_end_net() {
    let reg = registry();
    let c = run(
        &parts(&reg, &[("R1", "resistor_th"), ("R2", "resistor_th")]),
        &reg,
        "user",
        &[op("net.connect", json!({"net": "N_A", "pins": ["R1.2"]}))],
    );
    let (a, ops) = wire(&c, &reg, "R2.1", WireEnd::Pin(pin("R1.2")));
    assert_eq!(ops.len(), 1);
    assert!(a.nets["N_A"].pins.contains(&pin("R2.1")));
    let (b, _) = wire(&c, &reg, "R1.2", WireEnd::Pin(pin("R2.1")));
    assert_eq!(a.nets, b.nets, "direction does not matter");
    let (g, _) = wire(&c, &reg, "R2.2", WireEnd::Net("N_A".into()));
    assert!(g.nets["N_A"].pins.contains(&pin("R2.2")));
}

#[test]
fn merging_nets_keeps_ground_then_power_then_ports() {
    let reg = registry();
    let demo = demo_circuit(&reg);

    // A signal net wired to ground folds into GND.
    let (c, ops) = wire(&demo, &reg, "R1.1", WireEnd::Net("GND".into()));
    assert!(matches!(&ops[..], [Op::NetDisconnect(d), Op::NetConnect(k)] if d.net == "N_IN" && k.net == "GND"));
    assert!(!c.nets.contains_key("N_IN"));
    assert!(c.nets["GND"].pins.contains(&pin("V3.P")));

    // Power beats signal, whichever end the wire starts from.
    let (c, _) = wire(&demo, &reg, "U1.VCC", WireEnd::Pin(pin("R2.2")));
    assert!(c.nets.contains_key("VCC") && c.nets["VCC"].pins.contains(&pin("C2.1")));

    // Between two signal nets, a block's port net survives.
    let (c, _) = wire(&demo, &reg, "R1.2", WireEnd::Pin(pin("R1.1")));
    assert!(c.nets.contains_key("N_IN"), "N_IN is a port of the source and filter blocks");
}

#[test]
fn wiring_within_one_net_or_to_itself_is_refused() {
    let reg = registry();
    let demo = demo_circuit(&reg);
    let same = connect(&demo, &reg, &pin("V1.N"), &WireEnd::Pin(pin("V2.P"))).unwrap_err();
    assert_eq!(same.code, ErrorCode::PinAlreadyConnected);
    assert!(same.message.contains("already connected"), "{}", same.message);
    let own = connect(&demo, &reg, &pin("R1.1"), &WireEnd::Pin(pin("R1.1"))).unwrap_err();
    assert_eq!(own.code, ErrorCode::PinAlreadyConnected);
    assert_eq!(
        connect(&demo, &reg, &pin("R1.9"), &WireEnd::Net("GND".into())).unwrap_err().code,
        ErrorCode::PinNotFound
    );
    assert_eq!(
        connect(&demo, &reg, &pin("R1.1"), &WireEnd::Net("N_NOPE".into())).unwrap_err().code,
        ErrorCode::NetNotFound
    );
}

#[test]
fn wire_end_json() {
    assert_eq!(serde_json::to_value(WireEnd::Pin(pin("R1.2"))).unwrap(), json!({"pin": "R1.2"}));
    assert_eq!(serde_json::from_value::<WireEnd>(json!({"net": "GND"})).unwrap(), WireEnd::Net("GND".into()));
}

#[test]
fn rails_are_created_on_first_use_and_must_keep_their_kind() {
    let reg = registry();
    let c = parts(&reg, &[("V1", "vsource_dc"), ("U1", "opamp_tl072"), ("R1", "resistor_th")]);
    let vcc = || WireEnd::Rail { net: "VCC".into(), kind: NetKind::Power { volts: 5.0 } };
    let gnd = || WireEnd::Rail { net: "GND".into(), kind: NetKind::Ground };

    let (c, _) = wire(&c, &reg, "V1.P", vcc());
    assert_eq!(c.nets["VCC"].kind, NetKind::Power { volts: 5.0 });
    let (c, ops) = wire(&c, &reg, "U1.VCC", vcc());
    assert_eq!(ops.len(), 1, "an existing rail is just joined");
    let (c, _) = wire(&c, &reg, "V1.N", gnd());
    assert_eq!(c.nets["GND"].kind, NetKind::Ground);

    let other = WireEnd::Rail { net: "VCC".into(), kind: NetKind::Power { volts: 12.0 } };
    let e = connect(&c, &reg, &pin("R1.1"), &other).unwrap_err();
    assert_eq!(e.code, ErrorCode::NetInvalid);
    assert!(e.message.contains("5 V rail"), "{}", e.message);

    // A signal net becomes the new rail as a whole; a supply pin is not shorted to it.
    let (c, _) = wire(&c, &reg, "R1.2", WireEnd::Pin(pin("U1.OUT_A")));
    let (c2, _) = wire(&c, &reg, "R1.2", WireEnd::Rail { net: "VEE".into(), kind: NetKind::Power { volts: -5.0 } });
    assert!(!c2.nets.contains_key("N1"));
    assert_eq!(c2.nets["VEE"].pins.len(), 2);
    let e = connect(&c, &reg, &pin("V1.P"), &WireEnd::Rail { net: "VEE".into(), kind: NetKind::Power { volts: -5.0 } });
    assert_eq!(e.unwrap_err().code, ErrorCode::PinAlreadyConnected);
}
