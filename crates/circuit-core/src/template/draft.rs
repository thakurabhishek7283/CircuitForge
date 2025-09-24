//! Generated blocks (LLD §6). The composer either names a template and its targets, or drafts the
//! block part by part. Either way the block keeps a reference template: its ports, rails and spec
//! checks are what the block must meet, and it is the fallback when the drafts keep failing.
//!
//! [`trial_block`] turns a request into ops and gathers every problem in one pass, so one repair
//! round sees all of them:
//!
//! 1. The draft itself: unknown parts, malformed or misnamed refs and pins, a pin on two nets, a
//!    port with no net.
//! 2. The block alone in its verification bench (the template's `verify`: a sine on each input, a
//!    load on each output), built with the draft's own refs so every message names what the model
//!    wrote: every op `apply()` rejects, then `llm_block` ERC scoped to the block. An open input
//!    or output is not a fault there, as it would be in an empty circuit. Its compiled netlist,
//!    with the block's checks as `.meas` cards, is what the server simulates.
//! 3. The same ops, renumbered, against the job's circuit (bound ports, existing rails).

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{
    Frame, InsertBlock, PortBinding, Preview, TemplateDef, analysis_op, bench_ops, free_block_id, instantiate, preview,
    renumber, template,
};
use crate::Registry;
use crate::apply::{apply_all, apply_ops, refdes_category};
use crate::erc::{ErcCode, ErcContext, ErcIssue, Severity, erc};
use crate::error::{ErrorCode as E, OpError};
use crate::ir::*;
use crate::ops::{Author, BlockRef, NetConnect, Op, OpEnvelope, PROTOCOL_VERSION, PartAdd};
use crate::registry::PartDef;
use crate::spice::{CompileOpts, Netlist, compile};

/// A block drafted part by part, in the shape of a template's `parts` and `nets`. Refs are the
/// draft's own (`R1`, `U1`: category letter and number) and are renumbered on insertion. A net
/// named after a port of the reference template is that port, `gnd` is ground, and any other
/// name is internal to the block.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DraftBlock {
    /// The reference template: ports, rails, spec checks, fallback.
    pub template: String,
    /// Target values as typed; a missing target takes the template default.
    #[serde(default)]
    pub targets: BTreeMap<String, String>,
    #[serde(default)]
    pub ports: BTreeMap<String, PortBinding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<BlockId>,
    /// Default: the template's title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub parts: Vec<DraftPart>,
    pub nets: Vec<DraftNet>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DraftPart {
    #[serde(rename = "ref")]
    pub local: String,
    pub part: PartId,
    /// Values as written (`"10k"`); unspecified params take the registry default.
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DraftNet {
    pub name: String,
    /// `R1.2`, `U1.OUT_A`, in the draft's refs. Text, so a malformed pin is one problem, not a
    /// rejected draft.
    pub pins: Vec<String>,
}

/// What to trial: a template at targets (the composer's `use_template`, or the fallback), or a
/// draft.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlockRequest {
    Template(InsertBlock),
    Draft(DraftBlock),
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum IssueCode {
    Op(E),
    Erc(ErcCode),
}

/// One reason a block cannot commit, returned to the composer verbatim during repair.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Problem {
    pub code: IssueCode,
    pub message: String,
    /// The request line it comes from: `part R1`, `net n_a` or `block`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

impl Problem {
    fn op(e: OpError, at: Option<&str>) -> Problem {
        Problem { code: IssueCode::Op(e.code), message: e.message, at: at.map(str::to_string) }
    }

    fn new(code: E, message: String, at: &str) -> Problem {
        Problem { code: IssueCode::Op(code), message, at: Some(at.to_string()) }
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct BlockTrial {
    pub block: BlockId,
    pub template: String,
    /// Author of `ops`: `llm` for a draft, `template` for a template block.
    pub author: Author,
    /// Ops that add the block to the circuit, `block.begin` … `block.commit`, trial-applied.
    /// Empty when there are problems.
    pub ops: Vec<Op>,
    /// Request ref (template local or draft ref) -> refdes in the circuit.
    pub refdes: BTreeMap<String, RefDes>,
    pub spec: BTreeMap<String, SpecTarget>,
    pub spec_display: BTreeMap<String, String>,
    /// Everything that rejects the block. Empty means: simulate `bench`, then check its spec.
    pub problems: Vec<Problem>,
    /// ERC findings that do not reject a generated block (an unused op-amp unit).
    pub warnings: Vec<ErcIssue>,
    /// The block alone in its verification bench, compiled with the editor's analyses and the
    /// block's checks as `.meas` cards. Absent when there are problems.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bench: Option<Netlist>,
}

/// Trial a block for the circuit `c`. Never fails: every problem, including an unknown template
/// or a target out of range, is in `problems`.
pub fn trial_block(c: &Circuit, reg: &Registry, req: &BlockRequest, job: Option<&str>) -> BlockTrial {
    let (insert, draft, author) = match req {
        BlockRequest::Template(r) => (r.clone(), None, Author::Template),
        BlockRequest::Draft(d) => {
            let r = InsertBlock {
                template: d.template.clone(),
                targets: d.targets.clone(),
                ports: d.ports.clone(),
                id: d.id.clone(),
            };
            (r, Some(d), Author::Llm)
        }
    };
    let insert = InsertBlock { id: Some(insert.id.clone().unwrap_or_else(|| free_block_id(c))), ..insert };
    let block = insert.id.clone().expect("set above");
    let mut out = BlockTrial {
        block,
        template: insert.template.clone(),
        author,
        ops: Vec::new(),
        refdes: BTreeMap::new(),
        spec: BTreeMap::new(),
        spec_display: BTreeMap::new(),
        problems: Vec::new(),
        warnings: Vec::new(),
        bench: None,
    };
    let (t, pv) = match template(reg, &insert.template).and_then(|t| Ok((t, preview(c, reg, &insert)?))) {
        Ok(x) => x,
        Err(e) => {
            out.problems.push(Problem::op(e, Some("block")));
            return out;
        }
    };
    out.spec = pv.spec.clone();
    out.spec_display = pv.spec_display.clone();
    let checked = draft.map(|d| check_draft(reg, t, d));
    if let Some(ch) = &checked {
        out.problems.extend(ch.problems.iter().cloned());
    }

    // The block alone in its bench, in the request's own refs.
    let iso = Circuit::new(reg.version.clone());
    let iso_req = InsertBlock { ports: isolated_ports(t, &pv, &insert.ports), ..insert.clone() };
    match build(&iso, reg, t, &pv, &iso_req, checked.as_ref(), false) {
        Err(e) => out.problems.push(Problem::op(e, Some("block"))),
        Ok(mut b) => {
            let envs = |ops: &[Op]| -> Vec<OpEnvelope> {
                ops.iter()
                    .enumerate()
                    .map(|(i, op)| OpEnvelope {
                        v: PROTOCOL_VERSION,
                        seq: i as u64 + 1,
                        op: op.clone(),
                        author,
                        job: job.map(str::to_string),
                        block: Some(out.block.clone()),
                        base_rev: 0,
                    })
                    .collect()
            };
            let mut trial = apply_all(&iso, reg, &envs(&b.ops));
            // A part that was refused (a value out of range) would fail every net it is on as
            // well; take its pins out and try again, so only the cause is reported.
            let refused: BTreeSet<RefDes> = trial
                .errors
                .iter()
                .filter_map(|e| match b.ops.get(e.op_index?) {
                    Some(Op::PartAdd(p)) => Some(p.refdes.clone()),
                    _ => None,
                })
                .collect();
            if !refused.is_empty() {
                b.drop_pins_of(&refused);
                trial = apply_all(&iso, reg, &envs(&b.ops));
            }
            for e in trial.errors {
                let at = e.op_index.and_then(|i| b.sources.get(i)).cloned();
                out.problems.push(Problem { code: IssueCode::Op(e.code), message: e.message, at });
            }
            if out.problems.is_empty() {
                check_in_bench(reg, &trial.circuit, &mut out);
            }
        }
    }

    // The same block in the job's circuit.
    if out.problems.is_empty() {
        match build(c, reg, t, &pv, &insert, checked.as_ref(), true) {
            Err(e) => out.problems.push(Problem::op(e, Some("block"))),
            Ok(b) => match apply_ops(c, reg, &b.ops, author, job) {
                Err(e) => {
                    let at = e.op_index.and_then(|i| b.sources.get(i)).cloned();
                    out.problems.push(Problem { code: IssueCode::Op(e.code), message: e.message, at });
                }
                Ok(_) => {
                    out.ops = b.ops;
                    out.refdes = b.refdes;
                }
            },
        }
    }
    if !out.problems.is_empty() {
        out.bench = None;
    }
    out
}

/// Supplies keep their rail and voltage; signals get new nets; ground is GND.
fn isolated_ports(
    t: &TemplateDef,
    pv: &Preview,
    ports: &BTreeMap<String, PortBinding>,
) -> BTreeMap<String, PortBinding> {
    t.rails
        .iter()
        .map(|(name, rail)| {
            let net = match ports.get(name) {
                Some(PortBinding::Net(id)) | Some(PortBinding::Rail { net: id, .. }) => id.clone(),
                _ => rail.net.clone(),
            };
            (name.clone(), PortBinding::Rail { net, volts: pv.rails[name] })
        })
        .collect()
}

/// Add the verification bench, run ERC for the block, compile the deck.
fn check_in_bench(reg: &Registry, block_alone: &Circuit, out: &mut BlockTrial) {
    let bench = match bench_ops(block_alone, reg, &out.block)
        .and_then(|ops| apply_ops(block_alone, reg, &ops, Author::User, None))
    {
        Ok((c, _)) => c,
        Err(e) => return out.problems.push(Problem::op(e, Some("block"))),
    };
    for issue in erc(&bench, reg, ErcContext::LlmBlock, Some(&out.block)) {
        if issue.severity == Severity::Error {
            out.problems.push(Problem { code: IssueCode::Erc(issue.code), message: issue.message, at: None });
        } else {
            out.warnings.push(issue);
        }
    }
    if out.problems.is_empty() {
        match compile(&bench, reg, &CompileOpts { interactive: true, ..Default::default() }) {
            Ok(n) => out.bench = Some(n),
            Err(e) => out.problems.push(Problem {
                code: IssueCode::Op(E::CompileFailed),
                message: e.message,
                at: e.refdes.map(|r| format!("part {r}")),
            }),
        }
    }
}

struct Built {
    ops: Vec<Op>,
    /// The request line each op comes from.
    sources: Vec<String>,
    refdes: BTreeMap<String, RefDes>,
}

impl Built {
    /// Remove the pins of `parts` from every `net.connect`, and nets left with none.
    fn drop_pins_of(&mut self, parts: &BTreeSet<RefDes>) {
        let mut keep = Vec::with_capacity(self.ops.len());
        for op in &mut self.ops {
            if let Op::NetConnect(n) = op {
                n.pins.retain(|p| !parts.contains(&p.refdes));
                keep.push(!n.pins.is_empty());
            } else {
                keep.push(true);
            }
        }
        let mut k = keep.iter();
        self.ops.retain(|_| *k.next().expect("one flag per op"));
        let mut k = keep.iter();
        self.sources.retain(|_| *k.next().expect("one flag per source"));
    }
}

/// The request's ops in `c`: a template's parts with solved values, or the draft's parts with its
/// own values. `renumber_refs`: give draft parts the lowest free refdes instead of their own refs.
fn build(
    c: &Circuit,
    reg: &Registry,
    t: &TemplateDef,
    pv: &Preview,
    req: &InsertBlock,
    draft: Option<&Checked>,
    renumber_refs: bool,
) -> Result<Built, OpError> {
    let Some(d) = draft else {
        let ins = instantiate(c, reg, req)?;
        let sources = vec!["block".to_string(); ins.ops.len()];
        return Ok(Built { ops: ins.ops, sources, refdes: ins.refdes });
    };
    let mut frame = Frame::new(c, t, pv, &req.ports, req.id.as_ref())?;
    let refdes: BTreeMap<String, RefDes> = if renumber_refs {
        renumber(c, reg, d.parts.iter().map(|p| (p.local.as_str(), p.part.as_str())))?
    } else {
        d.parts.iter().map(|p| (p.local.clone(), p.local.clone())).collect()
    };
    let mut ops = vec![frame.begin_op(t, pv, d.title.as_deref())];
    let mut sources = vec!["block".to_string()];
    for p in &d.parts {
        ops.push(Op::PartAdd(PartAdd {
            refdes: refdes[&p.local].clone(),
            part: p.part.clone(),
            params: p.params.clone(),
            block: Some(frame.block.clone()),
            origin: None,
        }));
        sources.push(format!("part {}", p.local));
    }
    for n in &d.nets {
        let (net, kind) = frame.net(&n.key);
        ops.push(Op::NetConnect(NetConnect {
            net,
            pins: n.pins.iter().map(|p| PinRef::new(&refdes[&p.refdes], &p.pin)).collect(),
            kind,
            label: None,
        }));
        sources.push(format!("net {}", n.name));
    }
    if let Some(op) = analysis_op(c, t, pv) {
        ops.push(op);
        sources.push("block".to_string());
    }
    ops.push(Op::BlockCommit(BlockRef { id: frame.block.clone() }));
    sources.push("block".to_string());
    Ok(Built { ops, sources, refdes })
}

/// A draft with its mistakes taken out (and listed), so what remains still builds.
struct Checked {
    title: Option<String>,
    parts: Vec<DraftPart>,
    nets: Vec<CheckedNet>,
    problems: Vec<Problem>,
}

struct CheckedNet {
    /// Lowercase: matches port names; `n_a` and `N_A` are one net.
    key: String,
    name: String,
    pins: Vec<PinRef>,
}

fn net_name_ok(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_alphabetic()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

fn check_draft(reg: &Registry, t: &TemplateDef, d: &DraftBlock) -> Checked {
    let mut problems = Vec::new();
    let mut defs: BTreeMap<&str, &PartDef> = BTreeMap::new();
    let mut dropped: BTreeSet<&str> = BTreeSet::new();
    let mut parts = Vec::new();
    for p in &d.parts {
        let at = format!("part {}", p.local);
        let Some(def) = reg.part(&p.part) else {
            problems.push(Problem::new(E::PartNotInRegistry, format!("{} is not in the registry", p.part), &at));
            dropped.insert(&p.local);
            continue;
        };
        if defs.contains_key(p.local.as_str()) {
            problems.push(Problem::new(
                E::RefdesConflict,
                format!("{} is used twice: give each part its own ref", p.local),
                &at,
            ));
        } else if refdes_category(&p.local) != Some(def.category) {
            let l = def.category.letter();
            problems.push(Problem::new(
                E::RefdesInvalid,
                format!("{} is a {:?} part: its ref is {l} and a number, such as {l}1", p.part, def.category),
                &at,
            ));
            dropped.insert(&p.local);
        } else {
            defs.insert(&p.local, def);
            parts.push(p.clone());
        }
    }

    let mut keys = BTreeSet::new();
    let mut used: BTreeMap<PinRef, &str> = BTreeMap::new();
    let mut nets = Vec::new();
    for n in &d.nets {
        let at = format!("net {}", n.name);
        let key = n.name.to_ascii_lowercase();
        if !net_name_ok(&n.name) {
            problems.push(Problem::new(
                E::NetInvalid,
                format!("\"{}\" is not a net name: letters, digits and _, starting with a letter, at most 32", n.name),
                &at,
            ));
            continue;
        }
        if !keys.insert(key.clone()) {
            problems.push(Problem::new(
                E::NetConflict,
                format!("net {} is listed twice: put all its pins in one list", n.name),
                &at,
            ));
            continue;
        }
        if n.pins.is_empty() {
            problems.push(Problem::new(E::SchemaError, format!("net {} has no pins", n.name), &at));
            continue;
        }
        let mut pins = Vec::new();
        for text in &n.pins {
            let Ok(pin) = text.parse::<PinRef>() else {
                problems.push(Problem::new(
                    E::SchemaError,
                    format!("\"{text}\" is not a pin: write REF.PIN, such as R1.2"),
                    &at,
                ));
                continue;
            };
            let Some(def) = defs.get(pin.refdes.as_str()) else {
                if !dropped.contains(pin.refdes.as_str()) {
                    problems.push(Problem::new(E::PartNotFound, format!("no part {} in this block", pin.refdes), &at));
                }
                continue;
            };
            if def.pin(&pin.pin).is_none() {
                let names: Vec<&str> = def.pins.iter().map(|p| p.name.as_str()).collect();
                problems.push(Problem::new(
                    E::PinNotFound,
                    format!("{} ({}) has no pin {}; its pins are {}", pin.refdes, def.id, pin.pin, names.join(" ")),
                    &at,
                ));
                continue;
            }
            if let Some(other) = used.get(&pin) {
                problems.push(Problem::new(
                    E::PinAlreadyConnected,
                    format!("{pin} is already on net {other}: a pin is on one net only"),
                    &at,
                ));
                continue;
            }
            used.insert(pin.clone(), &n.name);
            pins.push(pin);
        }
        if !pins.is_empty() {
            nets.push(CheckedNet { key, name: n.name.clone(), pins });
        }
    }
    for port in t.ports.keys() {
        if !nets.iter().any(|n| &n.key == port) {
            problems.push(Problem::new(
                E::PortInvalid,
                format!("port {port} has no net: list the pins on it as a net named {port}"),
                "block",
            ));
        }
    }
    Checked { title: d.title.clone(), parts, nets, problems }
}
