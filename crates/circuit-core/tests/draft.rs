//! Generated blocks (LLD §6): `trial_block` turns a composer's draft into ops, reports every
//! problem at once in the draft's own names, checks the block in its verification bench and
//! returns the deck to simulate.

mod common;

use std::collections::BTreeMap;
use std::sync::Arc;

use circuit_core::erc::ErcCode;
use circuit_core::error::ErrorCode;
use circuit_core::ir::Origin;
use circuit_core::ops::{Author, Op};
use circuit_core::template::{
    BlockRequest, BlockTrial, DraftBlock, DraftNet, DraftPart, InsertBlock, IssueCode, PortBinding, Problem,
};
use circuit_core::{Registry, Session};
use common::*;

fn reg() -> Arc<Registry> {
    Arc::new(registry())
}

fn part(r: &str, part: &str, params: &[(&str, &str)]) -> DraftPart {
    DraftPart {
        local: r.into(),
        part: part.into(),
        params: params.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
}

fn net(name: &str, pins: &[&str]) -> DraftNet {
    DraftNet { name: name.into(), pins: pins.iter().map(|p| p.to_string()).collect() }
}

fn draft(template: &str, targets: &[(&str, &str)], parts: Vec<DraftPart>, nets: Vec<DraftNet>) -> DraftBlock {
    DraftBlock {
        template: template.into(),
        targets: targets.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        ports: BTreeMap::new(),
        id: None,
        title: None,
        parts,
        nets,
    }
}

/// A non-inverting amplifier of gain 11, wired as the template wires it.
fn amp(r1: &str, r2: &str) -> DraftBlock {
    draft(
        "noninverting_amp",
        &[("gain", "11")],
        vec![
            part("R1", "resistor_th", &[("resistance", r1)]),
            part("R2", "resistor_th", &[("resistance", r2)]),
            part("U1", "opamp_tl072", &[]),
        ],
        vec![
            net("in", &["U1.INP_A"]),
            net("n_m", &["R1.1", "R2.1", "U1.INM_A"]),
            net("out", &["R2.2", "U1.OUT_A"]),
            net("gnd", &["R1.2"]),
            net("vcc", &["U1.VCC"]),
            net("vee", &["U1.VEE"]),
        ],
    )
}

fn trial(s: &Session, d: DraftBlock) -> BlockTrial {
    s.trial_block(&BlockRequest::Draft(d), Some("j_test"))
}

fn codes(problems: &[Problem]) -> Vec<(String, Option<String>)> {
    problems
        .iter()
        .map(|p| {
            let code = serde_json::to_value(p.code).unwrap().as_str().unwrap().to_string();
            (code, p.at.clone())
        })
        .collect()
}

#[test]
fn a_clean_draft_gives_ops_and_a_bench_to_simulate() {
    let reg = reg();
    let mut s = Session::new(reg.clone(), None).unwrap();
    let t = s.trial_block(&BlockRequest::Draft(amp("1k", "10k")), Some("j_1"));
    assert!(t.problems.is_empty(), "{:#?}", t.problems);
    assert_eq!((t.block.as_str(), t.author), ("b1", Author::Llm));
    assert_eq!(t.spec["gain"].target, 11.0);
    let bench = t.bench.as_ref().expect("a bench deck");
    assert!(bench.text.contains(".meas ac b1_gain_"), "{}", bench.text);
    assert_eq!(bench.checks.len(), 1);
    assert!(matches!(t.ops.first(), Some(Op::BlockBegin(b)) if b.template.as_deref() == Some("noninverting_amp")));
    assert!(matches!(t.ops.last(), Some(Op::BlockCommit(_))));

    s.apply_ops(&t.ops, Author::Llm).unwrap();
    assert_eq!(s.circuit().parts["R1"].origin, Origin::Llm { job_id: String::new() });
    assert_eq!(s.circuit().blocks["b1"].ports.iter().find(|p| p.name == "vcc").unwrap().net, "VCC");
}

#[test]
fn a_draft_like_the_template_simulates_the_same_deck() {
    let reg = reg();
    let s = Session::new(reg.clone(), None).unwrap();
    let insert = InsertBlock {
        template: "noninverting_amp".into(),
        targets: [("gain".to_string(), "11".to_string())].into(),
        ports: BTreeMap::new(),
        id: None,
    };
    let pv = s.preview_block(&insert).unwrap();
    let (r1, r2) = (&pv.values["R1"]["resistance"].display, &pv.values["R2"]["resistance"].display);
    let from_template = s.trial_block(&BlockRequest::Template(insert), None);
    let from_draft = trial(&s, amp(r1, r2));
    assert_eq!(from_template.bench.unwrap().text, from_draft.bench.unwrap().text);
}

#[test]
fn every_draft_mistake_comes_back_in_one_round() {
    let reg = reg();
    let s = Session::new(reg.clone(), None).unwrap();
    let d = draft(
        "noninverting_amp",
        &[],
        vec![
            part("R1", "resistor_th", &[("resistance", "1k")]),
            part("X2", "resistor_th", &[]),
            part("R1", "resistor_th", &[]),
            part("U1", "opamp_ua741", &[]),
            part("U2", "opamp_tl072", &[]),
        ],
        vec![
            net("in", &["U2.INP_A"]),
            net("n_m", &["R1.1", "U2.INM", "R9.1", "X2.1", "U1.INM_A"]),
            net("out", &["U2.OUT_A", "R1.1", "bogus"]),
            net("OUT", &["R1.2"]),
            net("gnd", &[]),
            net("vcc", &["U2.VCC"]),
            net("n-x", &["R1.2"]),
        ],
    );
    let t = trial(&s, d);
    assert_eq!(
        codes(&t.problems),
        [
            ("refdes_invalid", Some("part X2")),
            ("refdes_conflict", Some("part R1")),
            ("part_not_in_registry", Some("part U1")),
            ("pin_not_found", Some("net n_m")),
            ("part_not_found", Some("net n_m")),
            ("pin_already_connected", Some("net out")),
            ("schema_error", Some("net out")),
            ("net_conflict", Some("net OUT")),
            ("schema_error", Some("net gnd")),
            ("net_invalid", Some("net n-x")),
            ("port_invalid", Some("block")),
            ("port_invalid", Some("block")),
        ]
        .map(|(c, at)| (c.to_string(), at.map(str::to_string)))
    );
    let pin = t.problems.iter().find(|p| p.code == IssueCode::Op(ErrorCode::PinNotFound)).unwrap();
    assert!(pin.message.contains("its pins are OUT_A INM_A INP_A VEE INP_B INM_B OUT_B VCC"), "{}", pin.message);
    let ports: Vec<&str> = t
        .problems
        .iter()
        .filter(|p| p.code == IssueCode::Op(ErrorCode::PortInvalid))
        .map(|p| &p.message[..8])
        .collect();
    assert_eq!(ports, ["port vee", "port gnd"], "in template port order");
    assert!(t.ops.is_empty() && t.bench.is_none());
}

#[test]
fn erc_runs_in_the_bench_and_names_the_drafts_parts() {
    let reg = reg();
    // Ten Sessions of renumbering later the problems still read R1/U1: the bench uses the
    // draft's own refs.
    let mut s = Session::new(reg.clone(), None).unwrap();
    let first = trial(&s, amp("1k", "10k"));
    s.apply_ops(&first.ops, Author::Llm).unwrap();

    let mut d = amp("1k", "10k");
    d.nets.retain(|n| n.name != "vee");
    d.nets.push(net("vee", &["R2.2"])); // out on the supply: R2.2 leaves `out`
    d.nets.iter_mut().find(|n| n.name == "out").unwrap().pins.retain(|p| p != "R2.2");
    let t = trial(&s, d);
    assert_eq!(t.block, "b2");
    let erc: Vec<(ErcCode, &str)> = t
        .problems
        .iter()
        .filter_map(|p| match p.code {
            IssueCode::Erc(c) => Some((c, p.message.as_str())),
            _ => None,
        })
        .collect();
    assert!(
        erc.iter().any(|(c, m)| *c == ErcCode::FloatingPin && m.contains("U1.VEE")),
        "the op-amp's VEE is floating, named as drafted: {erc:#?}"
    );
    assert!(t.ops.is_empty());
}

#[test]
fn values_out_of_range_point_at_their_part() {
    let reg = reg();
    let s = Session::new(reg.clone(), None).unwrap();
    let t = trial(&s, amp("1k", "10G"));
    assert_eq!(codes(&t.problems), [("param_out_of_range".to_string(), Some("part R2".to_string()))]);
}

#[test]
fn a_second_block_binds_to_the_first_and_is_renumbered() {
    let reg = reg();
    let mut s = Session::new(reg.clone(), None).unwrap();
    let first = trial(&s, amp("1k", "10k"));
    s.apply_ops(&first.ops, Author::Llm).unwrap();
    let out = s.circuit().blocks["b1"].ports.iter().find(|p| p.name == "out").unwrap().net.clone();

    let mut d = amp("1k", "10k");
    d.ports.insert("in".into(), PortBinding::Net(out.clone()));
    let t = trial(&s, d);
    assert!(t.problems.is_empty(), "{:#?}", t.problems);
    assert_eq!(
        t.refdes,
        [("R1", "R3"), ("R2", "R4"), ("U1", "U2")].map(|(a, b)| (a.to_string(), b.to_string())).into()
    );
    s.apply_ops(&t.ops, Author::Llm).unwrap();
    let c = s.circuit();
    assert!(c.nets[&out].pins.contains(&"U2.INP_A".parse().unwrap()));
    assert_eq!(c.nets["VCC"].pins.len(), 2, "both op-amps on the one rail");
    // The bench is the block alone: its input is a new net, driven by the bench source.
    assert!(!t.bench.unwrap().text.contains(&out.to_ascii_lowercase()));
}

#[test]
fn request_level_problems_are_problems_too() {
    let reg = reg();
    let s = Session::new(reg.clone(), None).unwrap();
    let mut d = amp("1k", "10k");
    d.targets.insert("gain".into(), "1000".into());
    assert_eq!(codes(&trial(&s, d).problems), [("target_out_of_range".to_string(), Some("block".to_string()))]);
    let unknown = InsertBlock { template: "flux".into(), targets: BTreeMap::new(), ports: BTreeMap::new(), id: None };
    let t = s.trial_block(&BlockRequest::Template(unknown), None);
    assert_eq!(codes(&t.problems), [("template_not_found".to_string(), Some("block".to_string()))]);
}

#[test]
fn bench_ops_need_a_template_block() {
    let reg = reg();
    let mut s = Session::new(reg.clone(), None).unwrap();
    assert_eq!(s.bench_ops("b1").unwrap_err().code, ErrorCode::BlockNotFound);
    let ok = trial(&s, amp("1k", "10k"));
    s.apply_ops(&ok.ops, Author::Llm).unwrap();
    let ops = s.bench_ops("b1").unwrap();
    // A sine on `in`, a load on `out`, each with its ground.
    assert_eq!(ops.len(), 6);
    s.apply_ops(&ops, Author::User).unwrap();
    assert_eq!(s.circuit().parts["V1"].params["amplitude"].si, 0.05);
}
