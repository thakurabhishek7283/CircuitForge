//! `apply(circuit, op)`: the only way the IR changes (LLD §4). Atomic: an op lands whole or not
//! at all, and returns the ops that undo it.

use std::collections::{BTreeMap, BTreeSet};

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode as E, OpError, err};
use crate::ir::*;
use crate::ops::*;
use crate::registry::{Category, PartDef, Registry};
use crate::units::{Quantity, parse_quantity};

/// Result of applying one op.
#[derive(Clone, Debug)]
pub struct Applied {
    pub circuit: Circuit,
    /// Ops that undo this one, in the order they must be applied.
    pub inverse: Vec<Op>,
    pub patch: Patch,
}

/// What changed, by id, so the UI never needs the whole circuit per op (LLD §10).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
pub struct Patch {
    pub parts_upserted: Vec<RefDes>,
    pub parts_removed: Vec<RefDes>,
    pub nets_upserted: Vec<NetId>,
    pub nets_removed: Vec<NetId>,
    pub blocks_upserted: Vec<BlockId>,
    pub blocks_removed: Vec<BlockId>,
    pub analyses_changed: bool,
    pub hints_changed: bool,
}

impl Patch {
    pub fn diff(before: &Circuit, after: &Circuit) -> Patch {
        fn d<V: PartialEq>(a: &IndexMap<String, V>, b: &IndexMap<String, V>) -> (Vec<String>, Vec<String>) {
            let up = b.iter().filter(|(k, v)| a.get(*k) != Some(*v)).map(|(k, _)| k.clone()).collect();
            let rm = a.keys().filter(|k| !b.contains_key(*k)).cloned().collect();
            (up, rm)
        }
        let (parts_upserted, parts_removed) = d(&before.parts, &after.parts);
        let (nets_upserted, nets_removed) = d(&before.nets, &after.nets);
        let (blocks_upserted, blocks_removed) = d(&before.blocks, &after.blocks);
        Patch {
            parts_upserted,
            parts_removed,
            nets_upserted,
            nets_removed,
            blocks_upserted,
            blocks_removed,
            analyses_changed: before.analyses != after.analyses,
            hints_changed: before.hints != after.hints,
        }
    }
}

struct Ctx<'a> {
    author: Author,
    job: Option<&'a str>,
    env_block: Option<&'a str>,
}

fn check_envelope(c: &Circuit, reg: &Registry, env: &OpEnvelope) -> Result<(), OpError> {
    let v_ok = env.v == PROTOCOL_VERSION || (PROTOCOL_VERSION > 1 && env.v == PROTOCOL_VERSION - 1);
    if !v_ok {
        return err(E::UnsupportedVersion, format!("protocol v{} not supported (current v{PROTOCOL_VERSION})", env.v));
    }
    if c.registry_version != reg.version {
        return err(
            E::RegistryMismatch,
            format!("circuit uses registry {} but {} is loaded", c.registry_version, reg.version),
        );
    }
    Ok(())
}

/// Apply one op envelope. `base_rev` must equal `circuit.rev`.
pub fn apply(c: &Circuit, reg: &Registry, env: &OpEnvelope) -> Result<Applied, OpError> {
    check_envelope(c, reg, env)?;
    if env.base_rev != c.rev {
        return err(E::StaleRev, format!("base_rev {} but circuit is at rev {}", env.base_rev, c.rev));
    }
    let mut next = c.clone();
    let ctx = Ctx { author: env.author, job: env.job.as_deref(), env_block: env.block.as_deref() };
    let inverse = apply_in_place(&mut next, reg, &env.op, &ctx)?;
    let patch = Patch::diff(c, &next);
    Ok(Applied { circuit: next, inverse, patch })
}

/// Apply a sequence of bare ops atomically (e.g. an undo step). Returns the new circuit and the
/// ops that undo the whole sequence.
pub fn apply_ops(
    c: &Circuit,
    reg: &Registry,
    ops: &[Op],
    author: Author,
    job: Option<&str>,
) -> Result<(Circuit, Vec<Op>), OpError> {
    if c.registry_version != reg.version {
        return err(E::RegistryMismatch, "circuit and registry versions differ");
    }
    let mut next = c.clone();
    let ctx = Ctx { author, job, env_block: None };
    let mut inverses = Vec::with_capacity(ops.len());
    for (i, op) in ops.iter().enumerate() {
        let inv = apply_in_place(&mut next, reg, op, &ctx).map_err(|mut e| {
            e.op_index = Some(i);
            e
        })?;
        inverses.push(inv);
    }
    Ok((next, inverses.into_iter().rev().flatten().collect()))
}

/// Outcome of a trial batch (the orchestrator's composer draft).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Trial {
    pub circuit: Circuit,
    /// Every rejected op, with `op_index` set. Rejected ops are skipped; the rest still apply,
    /// so the LLM gets all its mistakes back in one repair round.
    pub errors: Vec<OpError>,
    /// Undo for the ops that did apply.
    pub inverse: Vec<Op>,
}

/// Apply a batch, collecting errors instead of stopping. `base_rev` is ignored: the batch is
/// rebased onto `c`, because skipped ops would otherwise make every later op stale.
pub fn apply_all(c: &Circuit, reg: &Registry, envs: &[OpEnvelope]) -> Trial {
    let mut cur = c.clone();
    let mut errors = Vec::new();
    let mut inverses = Vec::new();
    for (i, env) in envs.iter().enumerate() {
        let res = check_envelope(&cur, reg, env).and_then(|_| {
            let mut next = cur.clone();
            let ctx = Ctx { author: env.author, job: env.job.as_deref(), env_block: env.block.as_deref() };
            apply_in_place(&mut next, reg, &env.op, &ctx).map(|inv| (next, inv))
        });
        match res {
            Ok((next, inv)) => {
                cur = next;
                inverses.push(inv);
            }
            Err(mut e) => {
                e.op_index = Some(i);
                errors.push(e);
            }
        }
    }
    Trial { circuit: cur, errors, inverse: inverses.into_iter().rev().flatten().collect() }
}

fn apply_in_place(c: &mut Circuit, reg: &Registry, op: &Op, ctx: &Ctx) -> Result<Vec<Op>, OpError> {
    let inverse = match op {
        Op::BlockBegin(b) => block_begin(c, b)?,
        Op::BlockCommit(b) => block_commit(c, b)?,
        Op::BlockAbort(b) => block_abort(c, b)?,
        Op::BlockRemove(b) => block_remove(c, b)?,
        Op::BlockSetStatus(b) => block_set_status(c, b)?,
        Op::PartAdd(b) => part_add(c, reg, b, ctx)?,
        Op::PartRemove(b) => part_remove(c, b)?,
        Op::PartSetParam(b) => part_set_param(c, reg, b)?,
        Op::PartSwap(b) => part_swap(c, reg, b)?,
        Op::PartPin(b) => part_pin(c, b, ctx)?,
        Op::NetConnect(b) => net_connect(c, reg, b)?,
        Op::NetDisconnect(b) => net_disconnect(c, b)?,
        Op::NetRename(b) => net_rename(c, b)?,
        Op::AnalysisSet(b) => analysis_set(c, b)?,
        Op::HintAdd(b) => hint_add(c, b)?,
        Op::HintRemove(b) => hint_remove(c, b)?,
        Op::Narrate(_) => return Ok(Vec::new()), // lesson track only; not an IR change
    };
    c.rev += 1;
    Ok(inverse)
}

// ---------------------------------------------------------------- identifiers

/// `R12`, `U1`: category letter plus 1–4 digits without a leading zero.
pub fn refdes_category(r: &str) -> Option<Category> {
    let mut chars = r.chars();
    let cat = Category::from_letter(chars.next()?)?;
    let digits = chars.as_str();
    let ok = (1..=4).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit()) && !digits.starts_with('0');
    ok.then_some(cat)
}

/// `GND`, or a letter followed by up to 63 of `[A-Za-z0-9_]`. Case-insensitive `gnd` and the
/// compiler's `nc_` prefix are reserved.
pub fn valid_net_id(id: &str) -> bool {
    if id == GND {
        return true;
    }
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphabetic()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
        && !id.eq_ignore_ascii_case(GND)
        && !id.to_ascii_lowercase().starts_with("nc_")
}

fn valid_block_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

pub(crate) fn net_conflict<'a>(c: &'a Circuit, id: &str, except: Option<&str>) -> Option<&'a NetId> {
    c.nets.keys().find(|k| k.eq_ignore_ascii_case(id) && Some(k.as_str()) != except)
}

// ---------------------------------------------------------------- blocks

fn block_begin_op(b: &Block) -> Op {
    Op::BlockBegin(BlockBegin {
        id: b.id.clone(),
        role: b.role,
        title: b.title.clone(),
        spec: b.spec.clone(),
        ports: b.ports.clone(),
        template: b.template.clone(),
    })
}

fn block_begin(c: &mut Circuit, b: &BlockBegin) -> Result<Vec<Op>, OpError> {
    if !valid_block_id(&b.id) {
        return err(E::SchemaError, format!("block id \"{}\" must match [a-z][a-z0-9_]*", b.id));
    }
    if c.blocks.contains_key(&b.id) {
        return err(E::BlockConflict, format!("block {} already exists", b.id));
    }
    if c.blocks.len() >= MAX_BLOCKS {
        return err(E::LimitExceeded, format!("at most {MAX_BLOCKS} blocks"));
    }
    for (k, s) in &b.spec {
        if !s.target.is_finite() || !(s.tol_pct.is_finite() && s.tol_pct > 0.0) {
            return err(E::BadValue, format!("spec {k}: target must be finite and tol_pct > 0"));
        }
    }
    let mut names = BTreeSet::new();
    for p in &b.ports {
        if !names.insert(&p.name) {
            return err(E::SchemaError, format!("duplicate port {}", p.name));
        }
        if !valid_net_id(&p.net) {
            return err(E::NetInvalid, format!("port {} names invalid net \"{}\"", p.name, p.net));
        }
    }
    c.blocks.insert(
        b.id.clone(),
        Block {
            id: b.id.clone(),
            role: b.role,
            title: b.title.clone(),
            spec: b.spec.clone(),
            ports: b.ports.clone(),
            status: BlockStatus::Composing,
            template: b.template.clone(),
        },
    );
    Ok(vec![Op::BlockRemove(BlockRef { id: b.id.clone() })])
}

fn get_block<'a>(c: &'a mut Circuit, id: &str) -> Result<&'a mut Block, OpError> {
    c.blocks.get_mut(id).ok_or_else(|| OpError::new(E::BlockNotFound, format!("no block {id}")))
}

fn is_open(s: BlockStatus) -> bool {
    matches!(s, BlockStatus::Planned | BlockStatus::Composing | BlockStatus::Verified)
}

fn block_commit(c: &mut Circuit, b: &BlockRef) -> Result<Vec<Op>, OpError> {
    let block = get_block(c, &b.id)?;
    if !is_open(block.status) {
        return err(E::BlockNotOpen, format!("block {} is {:?}", b.id, block.status));
    }
    let prev = block.status;
    block.status = BlockStatus::Committed;
    Ok(vec![Op::BlockSetStatus(BlockSetStatus { id: b.id.clone(), status: prev })])
}

fn block_set_status(c: &mut Circuit, b: &BlockSetStatus) -> Result<Vec<Op>, OpError> {
    let block = get_block(c, &b.id)?;
    let prev = std::mem::replace(&mut block.status, b.status);
    Ok(vec![Op::BlockSetStatus(BlockSetStatus { id: b.id.clone(), status: prev })])
}

/// Discard an uncommitted block with all its parts and their connections.
fn block_abort(c: &mut Circuit, b: &BlockAbort) -> Result<Vec<Op>, OpError> {
    let block = c.blocks.get(&b.id).ok_or_else(|| OpError::new(E::BlockNotFound, format!("no block {}", b.id)))?;
    if !is_open(block.status) {
        return err(E::BlockNotOpen, format!("block {} is {:?}", b.id, block.status));
    }
    let block = block.clone();
    let parts: BTreeSet<RefDes> =
        c.parts.values().filter(|p| p.block.as_deref() == Some(&b.id)).map(|p| p.refdes.clone()).collect();
    let mut inverse = vec![block_begin_op(&block)];
    inverse.extend(restore_ops(c, &parts, Some(&b.id)));
    if block.status != BlockStatus::Composing {
        inverse.push(Op::BlockSetStatus(BlockSetStatus { id: b.id.clone(), status: block.status }));
    }
    remove_parts(c, &parts, Some(&b.id));
    c.blocks.shift_remove(&b.id);
    Ok(inverse)
}

fn block_remove(c: &mut Circuit, b: &BlockRef) -> Result<Vec<Op>, OpError> {
    let block = c.blocks.get(&b.id).ok_or_else(|| OpError::new(E::BlockNotFound, format!("no block {}", b.id)))?;
    if c.parts.values().any(|p| p.block.as_deref() == Some(&b.id)) || c.hints.iter().any(|h| h.mentions_block(&b.id)) {
        return err(E::BlockNotEmpty, format!("block {} still has parts or hints", b.id));
    }
    let mut inverse = vec![block_begin_op(block)];
    if block.status != BlockStatus::Composing {
        inverse.push(Op::BlockSetStatus(BlockSetStatus { id: b.id.clone(), status: block.status }));
    }
    c.blocks.shift_remove(&b.id);
    Ok(inverse)
}

// ---------------------------------------------------------------- parts

fn lookup_part<'r>(c: &Circuit, reg: &'r Registry, refdes: &str) -> Result<(PartInstance, &'r PartDef), OpError> {
    let inst = c.parts.get(refdes).ok_or_else(|| OpError::new(E::PartNotFound, format!("no part {refdes}")))?;
    let def = reg
        .part(&inst.part)
        .ok_or_else(|| OpError::new(E::PartNotInRegistry, format!("{} is not in the registry", inst.part)))?;
    Ok((inst.clone(), def))
}

fn parse_param(def: &PartDef, key: &str, value: &str) -> Result<Quantity, OpError> {
    let pd = def
        .params
        .get(key)
        .ok_or_else(|| OpError::new(E::ParamUnknown, format!("{} has no param \"{key}\"", def.id)))?;
    let q = parse_quantity(value, pd.unit).map_err(|e| OpError::new(E::BadValue, format!("{key}: {e}")))?;
    let below = pd.min.is_some_and(|lo| q.si < lo);
    let above = pd.max.is_some_and(|hi| q.si > hi);
    if below || above {
        let fmt = |x: Option<f64>| x.map(|v| Quantity::new(v, pd.unit).display).unwrap_or_else(|| "-".into());
        return err(
            E::ParamOutOfRange,
            format!("{key}={} outside {}..{} for {}", q.display, fmt(pd.min), fmt(pd.max), def.id),
        );
    }
    Ok(q)
}

fn default_params(def: &PartDef) -> BTreeMap<String, Quantity> {
    def.params
        .iter()
        .map(|(k, pd)| (k.clone(), parse_quantity(&pd.default, pd.unit).expect("registry defaults are validated")))
        .collect()
}

fn part_add(c: &mut Circuit, reg: &Registry, b: &PartAdd, ctx: &Ctx) -> Result<Vec<Op>, OpError> {
    let cat = refdes_category(&b.refdes)
        .ok_or_else(|| OpError::new(E::RefdesInvalid, format!("\"{}\" is not a valid refdes", b.refdes)))?;
    let def = reg
        .part(&b.part)
        .ok_or_else(|| OpError::new(E::PartNotInRegistry, format!("{} is not in the registry", b.part)))?;
    if def.category != cat {
        return err(
            E::RefdesInvalid,
            format!("{} is a {:?} part; its refdes must start with {}", b.part, def.category, def.category.letter()),
        );
    }
    if c.parts.contains_key(&b.refdes) {
        return err(E::RefdesConflict, format!("{} already exists", b.refdes));
    }
    if c.parts.len() >= MAX_PARTS {
        return err(E::LimitExceeded, format!("at most {MAX_PARTS} parts"));
    }
    let block = b.block.as_deref().or(ctx.env_block).map(str::to_string);
    if let Some(id) = &block {
        let blk = c.blocks.get(id).ok_or_else(|| OpError::new(E::BlockNotFound, format!("no block {id}")))?;
        if ctx.author == Author::Llm && blk.status != BlockStatus::Composing {
            return err(E::BlockNotOpen, format!("block {id} is not open"));
        }
    }
    let mut params = default_params(def);
    for (k, v) in &b.params {
        params.insert(k.clone(), parse_param(def, k, v)?);
    }
    let origin = b.origin.clone().unwrap_or_else(|| match ctx.author {
        Author::Llm => Origin::Llm { job_id: ctx.job.unwrap_or_default().to_string() },
        Author::User => Origin::User,
        Author::Template => {
            Origin::Template { id: block.as_ref().and_then(|id| c.blocks[id].template.clone()).unwrap_or_default() }
        }
    });
    c.parts.insert(
        b.refdes.clone(),
        PartInstance { refdes: b.refdes.clone(), part: b.part.clone(), params, block, origin, pinned: None },
    );
    Ok(vec![Op::PartRemove(PartRef { refdes: b.refdes.clone() })])
}

/// Ops that recreate `parts` (and their connections and hints) after `remove_parts`.
fn restore_ops(c: &Circuit, parts: &BTreeSet<RefDes>, block: Option<&str>) -> Vec<Op> {
    let mut ops = Vec::new();
    for p in c.parts.values().filter(|p| parts.contains(&p.refdes)) {
        ops.push(Op::PartAdd(PartAdd {
            refdes: p.refdes.clone(),
            part: p.part.clone(),
            params: p.params.iter().map(|(k, q)| (k.clone(), q.display.clone())).collect(),
            block: p.block.clone(),
            origin: Some(p.origin.clone()),
        }));
        if p.pinned.is_some() {
            ops.push(Op::PartPin(PartPin { refdes: p.refdes.clone(), placement: p.pinned }));
        }
    }
    for net in c.nets.values() {
        let pins: Vec<PinRef> = net.pins.iter().filter(|p| parts.contains(&p.refdes)).cloned().collect();
        if !pins.is_empty() {
            ops.push(Op::NetConnect(NetConnect {
                net: net.id.clone(),
                pins,
                kind: Some(net.kind),
                label: net.label.clone(),
            }));
        }
    }
    for h in &c.hints {
        if parts.iter().any(|r| h.mentions_part(r)) || block.is_some_and(|b| h.mentions_block(b)) {
            ops.push(Op::HintAdd(HintBody { hint: h.clone() }));
        }
    }
    // DC sweeps of a removed source are dropped with it; restore them once the source is back.
    if c.analyses.iter().any(|a| analysis_uses(a, parts)) {
        ops.push(Op::AnalysisSet(AnalysisSet { analyses: c.analyses.clone() }));
    }
    ops
}

fn analysis_uses(a: &Analysis, parts: &BTreeSet<RefDes>) -> bool {
    matches!(a, Analysis::Dc { source, .. } if parts.contains(source))
}

fn remove_parts(c: &mut Circuit, parts: &BTreeSet<RefDes>, block: Option<&str>) {
    for net in c.nets.values_mut() {
        net.pins.retain(|p| !parts.contains(&p.refdes));
    }
    c.nets.retain(|_, n| !n.pins.is_empty());
    c.hints.retain(|h| !(parts.iter().any(|r| h.mentions_part(r)) || block.is_some_and(|b| h.mentions_block(b))));
    c.analyses.retain(|a| !analysis_uses(a, parts));
    c.parts.retain(|r, _| !parts.contains(r));
}

fn part_remove(c: &mut Circuit, b: &PartRef) -> Result<Vec<Op>, OpError> {
    if !c.parts.contains_key(&b.refdes) {
        return err(E::PartNotFound, format!("no part {}", b.refdes));
    }
    let set = BTreeSet::from([b.refdes.clone()]);
    let inverse = restore_ops(c, &set, None);
    remove_parts(c, &set, None);
    Ok(inverse)
}

fn part_set_param(c: &mut Circuit, reg: &Registry, b: &PartSetParam) -> Result<Vec<Op>, OpError> {
    let (inst, def) = lookup_part(c, reg, &b.refdes)?;
    let q = parse_param(def, &b.key, &b.value)?;
    let old = inst.params.get(&b.key).map(|q| q.display.clone()).unwrap_or_else(|| def.params[&b.key].default.clone());
    c.parts[&b.refdes].params.insert(b.key.clone(), q);
    Ok(vec![Op::PartSetParam(PartSetParam { refdes: b.refdes.clone(), key: b.key.clone(), value: old })])
}

fn part_swap(c: &mut Circuit, reg: &Registry, b: &PartSwap) -> Result<Vec<Op>, OpError> {
    let (inst, old_def) = lookup_part(c, reg, &b.refdes)?;
    let new_def = reg
        .part(&b.part)
        .ok_or_else(|| OpError::new(E::PartNotInRegistry, format!("{} is not in the registry", b.part)))?;
    if new_def.category != old_def.category {
        return err(E::CategoryMismatch, format!("cannot swap {} for a {:?} part", b.refdes, new_def.category));
    }
    for net in c.nets.values() {
        for p in net.pins.iter().filter(|p| p.refdes == b.refdes) {
            if new_def.pin(&p.pin).is_none() {
                return err(E::PinNotFound, format!("{} has no pin {} (connected to {})", b.part, p.pin, net.id));
            }
        }
    }
    // Keep values that still make sense for the new part; otherwise take its default.
    let mut params = default_params(new_def);
    for (k, q) in &inst.params {
        if let Some(pd) = new_def.params.get(k)
            && pd.unit == q.unit
            && !pd.min.is_some_and(|lo| q.si < lo)
            && !pd.max.is_some_and(|hi| q.si > hi)
        {
            params.insert(k.clone(), q.clone());
        }
    }
    let mut inverse = vec![Op::PartSwap(PartSwap { refdes: b.refdes.clone(), part: inst.part.clone() })];
    inverse.extend(inst.params.iter().map(|(k, q)| {
        Op::PartSetParam(PartSetParam { refdes: b.refdes.clone(), key: k.clone(), value: q.display.clone() })
    }));
    let part = &mut c.parts[&b.refdes];
    part.part = b.part.clone();
    part.params = params;
    Ok(inverse)
}

fn part_pin(c: &mut Circuit, b: &PartPin, ctx: &Ctx) -> Result<Vec<Op>, OpError> {
    if ctx.author != Author::User {
        return err(E::Forbidden, "part.pin is set only by a user drag");
    }
    if let Some(pl) = &b.placement
        && (!pl.x.is_finite() || !pl.y.is_finite() || ![0, 90, 180, 270].contains(&pl.rot))
    {
        return err(E::BadValue, "placement needs finite x/y and rot in 0/90/180/270");
    }
    let part =
        c.parts.get_mut(&b.refdes).ok_or_else(|| OpError::new(E::PartNotFound, format!("no part {}", b.refdes)))?;
    let prev = std::mem::replace(&mut part.pinned, b.placement);
    Ok(vec![Op::PartPin(PartPin { refdes: b.refdes.clone(), placement: prev })])
}

// ---------------------------------------------------------------- nets

pub(crate) fn check_pin_exists(c: &Circuit, reg: &Registry, pin: &PinRef) -> Result<(), OpError> {
    let inst = c
        .parts
        .get(&pin.refdes)
        .ok_or_else(|| OpError::new(E::PinNotFound, format!("{pin}: no part {}", pin.refdes)))?;
    let def = reg
        .part(&inst.part)
        .ok_or_else(|| OpError::new(E::PartNotInRegistry, format!("{} is not in the registry", inst.part)))?;
    if def.pin(&pin.pin).is_none() {
        let names: Vec<&str> = def.pins.iter().map(|p| p.name.as_str()).collect();
        return err(E::PinNotFound, format!("{pin}: {} has pins {}", def.id, names.join(" ")));
    }
    Ok(())
}

fn net_connect(c: &mut Circuit, reg: &Registry, b: &NetConnect) -> Result<Vec<Op>, OpError> {
    if b.pins.is_empty() {
        return err(E::SchemaError, "net.connect needs at least one pin");
    }
    if !valid_net_id(&b.net) {
        return err(E::NetInvalid, format!("\"{}\" is not a valid net id", b.net));
    }
    let idx = c.pin_index();
    let mut seen = BTreeSet::new();
    for p in &b.pins {
        check_pin_exists(c, reg, p)?;
        if let Some(on) = idx.get(p) {
            return err(E::PinAlreadyConnected, format!("{p} is already on {on}"));
        }
        if !seen.insert(p) {
            return err(E::PinAlreadyConnected, format!("{p} listed twice"));
        }
    }
    if let Some(net) = c.nets.get(&b.net) {
        if b.kind.is_some_and(|k| k != net.kind) {
            return err(E::NetInvalid, format!("{} is {:?}, not {:?}", b.net, net.kind, b.kind.unwrap()));
        }
        if b.label.is_some() && b.label != net.label {
            return err(E::NetInvalid, format!("{} already has a different label", b.net));
        }
    } else {
        if let Some(other) = net_conflict(c, &b.net, None) {
            return err(E::NetConflict, format!("{} clashes with existing net {other}", b.net));
        }
        if c.nets.len() >= MAX_NETS {
            return err(E::LimitExceeded, format!("at most {MAX_NETS} nets"));
        }
        let is_gnd = b.net == GND;
        let kind = match b.kind {
            None if is_gnd => NetKind::Ground,
            None => NetKind::Signal,
            Some(NetKind::Ground) if is_gnd => NetKind::Ground,
            Some(NetKind::Ground) => return err(E::NetInvalid, "only GND can be a ground net"),
            Some(_) if is_gnd => return err(E::NetInvalid, "GND is always the ground net"),
            Some(NetKind::Power { volts }) if !volts.is_finite() => {
                return err(E::BadValue, "power net volts must be finite");
            }
            Some(k) => k,
        };
        c.nets.insert(b.net.clone(), Net { id: b.net.clone(), pins: BTreeSet::new(), kind, label: b.label.clone() });
    }
    c.nets[&b.net].pins.extend(b.pins.iter().cloned());
    Ok(vec![Op::NetDisconnect(NetDisconnect { net: b.net.clone(), pins: b.pins.clone() })])
}

fn net_disconnect(c: &mut Circuit, b: &NetDisconnect) -> Result<Vec<Op>, OpError> {
    let net = c.nets.get(&b.net).ok_or_else(|| OpError::new(E::NetNotFound, format!("no net {}", b.net)))?;
    if b.pins.is_empty() {
        return err(E::SchemaError, "net.disconnect needs at least one pin");
    }
    let mut seen = BTreeSet::new();
    for p in &b.pins {
        if !net.pins.contains(p) || !seen.insert(p) {
            return err(E::PinNotFound, format!("{p} is not on {}", b.net));
        }
    }
    let inverse = vec![Op::NetConnect(NetConnect {
        net: b.net.clone(),
        pins: b.pins.clone(),
        kind: Some(net.kind),
        label: net.label.clone(),
    })];
    let net = &mut c.nets[&b.net];
    net.pins.retain(|p| !seen.contains(p));
    if net.pins.is_empty() {
        c.nets.shift_remove(&b.net);
    }
    Ok(inverse)
}

fn net_rename(c: &mut Circuit, b: &NetRename) -> Result<Vec<Op>, OpError> {
    if !c.nets.contains_key(&b.from) {
        return err(E::NetNotFound, format!("no net {}", b.from));
    }
    if b.from == GND || b.to == GND {
        return err(E::NetInvalid, "GND cannot be renamed");
    }
    if !valid_net_id(&b.to) {
        return err(E::NetInvalid, format!("\"{}\" is not a valid net id", b.to));
    }
    if let Some(other) = net_conflict(c, &b.to, Some(&b.from)) {
        return err(E::NetConflict, format!("{} clashes with existing net {other}", b.to));
    }
    if b.from != b.to && c.blocks.values().any(|blk| blk.ports.iter().any(|p| p.net == b.to)) {
        return err(E::NetConflict, format!("a block port is already bound to {}", b.to));
    }
    c.nets = std::mem::take(&mut c.nets)
        .into_iter()
        .map(|(k, mut n)| {
            if k == b.from {
                n.id = b.to.clone();
                (b.to.clone(), n)
            } else {
                (k, n)
            }
        })
        .collect();
    for blk in c.blocks.values_mut() {
        for p in blk.ports.iter_mut().filter(|p| p.net == b.from) {
            p.net = b.to.clone();
        }
    }
    Ok(vec![Op::NetRename(NetRename { from: b.to.clone(), to: b.from.clone() })])
}

// ---------------------------------------------------------------- analyses and hints

fn validate_analysis(c: &Circuit, a: &Analysis) -> Result<(), OpError> {
    let bad = |m: &str| err(E::AnalysisInvalid, m.to_string());
    match a {
        Analysis::Op => Ok(()),
        Analysis::Dc { source, start, stop, step } => {
            if refdes_category(source) != Some(Category::V) || !c.parts.contains_key(source) {
                return bad(&format!("DC sweep source {source} must be an existing voltage source"));
            }
            if ![start, stop, step].iter().all(|x| x.is_finite()) || *step == 0.0 {
                return bad("DC sweep needs finite start/stop and a non-zero step");
            }
            let n = (stop - start) / step;
            if !(0.0..=100_000.0).contains(&n) {
                return bad("DC sweep step must head from start to stop in at most 100k points");
            }
            Ok(())
        }
        Analysis::Ac { points_per_decade, f_start, f_stop } => {
            if !(1..=1000).contains(points_per_decade) {
                return bad("AC points_per_decade must be 1..1000");
            }
            if !(f_start.is_finite() && f_stop.is_finite() && *f_start > 0.0 && f_start < f_stop) {
                return bad("AC needs 0 < f_start < f_stop");
            }
            Ok(())
        }
        Analysis::Tran { t_step, t_stop } => {
            if !(t_step.is_finite() && t_stop.is_finite() && *t_step > 0.0 && t_step <= t_stop) {
                return bad("transient needs 0 < t_step <= t_stop");
            }
            if t_stop / t_step > 1e7 {
                return bad("transient would take more than 10M steps");
            }
            Ok(())
        }
    }
}

fn analysis_set(c: &mut Circuit, b: &AnalysisSet) -> Result<Vec<Op>, OpError> {
    for a in &b.analyses {
        validate_analysis(c, a)?;
    }
    let prev = std::mem::replace(&mut c.analyses, b.analyses.clone());
    Ok(vec![Op::AnalysisSet(AnalysisSet { analyses: prev })])
}

fn hint_add(c: &mut Circuit, b: &HintBody) -> Result<Vec<Op>, OpError> {
    match &b.hint {
        LayoutHint::Flow { .. } => {}
        LayoutHint::Near { a, b: other } => {
            for r in [a, other] {
                if !c.parts.contains_key(r) {
                    return err(E::PartNotFound, format!("no part {r}"));
                }
            }
            if a == other {
                return err(E::SchemaError, "near hint needs two different parts");
            }
        }
        LayoutHint::Group { block } => {
            if !c.blocks.contains_key(block) {
                return err(E::BlockNotFound, format!("no block {block}"));
            }
        }
    }
    match c.hints.binary_search(&b.hint) {
        Ok(_) => Ok(Vec::new()), // already present: no-op
        Err(pos) => {
            c.hints.insert(pos, b.hint.clone());
            Ok(vec![Op::HintRemove(HintBody { hint: b.hint.clone() })])
        }
    }
}

fn hint_remove(c: &mut Circuit, b: &HintBody) -> Result<Vec<Op>, OpError> {
    let pos = c.hints.binary_search(&b.hint).map_err(|_| OpError::new(E::HintNotFound, "no such hint"))?;
    c.hints.remove(pos);
    Ok(vec![Op::HintAdd(HintBody { hint: b.hint.clone() })])
}

// ---------------------------------------------------------------- whole-circuit validation

/// Check every structural invariant (LLD §3) on a circuit that did not come from `apply`, such as
/// a server snapshot. Circuits produced by `apply` always pass.
pub fn validate(c: &Circuit, reg: &Registry) -> Vec<OpError> {
    let mut errs = Vec::new();
    let mut fail = |code, msg: String| errs.push(OpError::new(code, msg));
    if c.schema_version != SCHEMA_VERSION {
        fail(E::SchemaError, format!("schema_version {} != {SCHEMA_VERSION}", c.schema_version));
    }
    if c.registry_version != reg.version {
        fail(E::RegistryMismatch, format!("registry {} != {}", c.registry_version, reg.version));
    }
    if c.parts.len() > MAX_PARTS || c.nets.len() > MAX_NETS || c.blocks.len() > MAX_BLOCKS {
        fail(E::LimitExceeded, "circuit exceeds part/net/block limits".into());
    }
    for (k, b) in &c.blocks {
        if *k != b.id || !valid_block_id(k) {
            fail(E::SchemaError, format!("block key {k} / id {}", b.id));
        }
    }
    for (k, p) in &c.parts {
        if *k != p.refdes {
            fail(E::SchemaError, format!("part key {k} != refdes {}", p.refdes));
        }
        let Some(def) = reg.part(&p.part) else {
            fail(E::PartNotInRegistry, format!("{k}: {} not in registry", p.part));
            continue;
        };
        if refdes_category(k) != Some(def.category) {
            fail(E::RefdesInvalid, format!("{k} does not match category {:?}", def.category));
        }
        let declared: BTreeSet<&String> = def.params.keys().collect();
        let present: BTreeSet<&String> = p.params.keys().collect();
        if declared != present {
            fail(E::ParamUnknown, format!("{k}: params {present:?} != declared {declared:?}"));
        }
        for (key, q) in &p.params {
            if let Some(pd) = def.params.get(key)
                && (pd.unit != q.unit || pd.min.is_some_and(|lo| q.si < lo) || pd.max.is_some_and(|hi| q.si > hi))
            {
                fail(E::ParamOutOfRange, format!("{k}.{key} = {}", q.display));
            }
        }
        if let Some(b) = &p.block
            && !c.blocks.contains_key(b)
        {
            fail(E::BlockNotFound, format!("{k} is in missing block {b}"));
        }
    }
    let mut seen: BTreeMap<&PinRef, &NetId> = BTreeMap::new();
    for (k, n) in &c.nets {
        if *k != n.id || !valid_net_id(k) {
            fail(E::NetInvalid, format!("net key {k} / id {}", n.id));
        }
        if net_conflict(c, k, Some(k)).is_some() {
            fail(E::NetConflict, format!("{k} clashes with another net"));
        }
        if n.pins.is_empty() {
            fail(E::NetInvalid, format!("{k} has no pins"));
        }
        if (n.kind == NetKind::Ground) != (k == GND) {
            fail(E::NetInvalid, format!("{k}: only GND is a ground net"));
        }
        for p in &n.pins {
            if let Err(e) = check_pin_exists(c, reg, p) {
                fail(e.code, e.message);
            }
            if let Some(other) = seen.insert(p, k) {
                fail(E::PinAlreadyConnected, format!("{p} is on {other} and {k}"));
            }
        }
    }
    for a in &c.analyses {
        if let Err(e) = validate_analysis(c, a) {
            fail(e.code, e.message);
        }
    }
    let mut sorted = c.hints.clone();
    sorted.sort();
    sorted.dedup();
    if sorted != c.hints {
        fail(E::SchemaError, "hints must be sorted and unique".into());
    }
    errs
}
