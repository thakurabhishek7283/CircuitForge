//! Static electrical rule checks, ERC001–ERC010 (LLD §7). Graph-only, no simulation.
//! Post-sim rules (ERC011–ERC014) need simulation results and live with the sim integration.

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ir::*;
use crate::registry::{Category, PartDef, PinType, Registry};

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ErcCode {
    FloatingPin,
    DanglingNet,
    NoDcPath,
    VsourceLoop,
    UnpoweredIc,
    OutputConflict,
    SupplyShort,
    OverVoltage,
    PortUnbound,
    UnusedUnit,
}

impl ErcCode {
    pub fn rule(self) -> &'static str {
        match self {
            ErcCode::FloatingPin => "ERC001",
            ErcCode::DanglingNet => "ERC002",
            ErcCode::NoDcPath => "ERC003",
            ErcCode::VsourceLoop => "ERC004",
            ErcCode::UnpoweredIc => "ERC005",
            ErcCode::OutputConflict => "ERC006",
            ErcCode::SupplyShort => "ERC007",
            ErcCode::OverVoltage => "ERC008",
            ErcCode::PortUnbound => "ERC009",
            ErcCode::UnusedUnit => "ERC010",
        }
    }
}

/// Who the check is for: LLM blocks must be clean; learners may build broken circuits.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErcContext {
    LlmBlock,
    UserEdit,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Rejects an LLM block; for user edits, blocks simulation.
    Error,
    Warning,
    Info,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ErcIssue {
    pub rule: String,
    pub code: ErcCode,
    pub severity: Severity,
    pub message: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<RefDes>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nets: Vec<NetId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pins: Vec<PinRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockId>,
}

/// Severity table from LLD §7. `None` means the rule does not apply in that context.
fn severity(code: ErcCode, ctx: ErcContext) -> Option<Severity> {
    use ErcCode::*;
    use Severity::*;
    Some(match (ctx, code) {
        (ErcContext::LlmBlock, UnusedUnit) => Warning,
        (ErcContext::LlmBlock, _) => Error,
        (ErcContext::UserEdit, VsourceLoop) => Error,
        (ErcContext::UserEdit, UnusedUnit) => Info,
        (ErcContext::UserEdit, PortUnbound) => return None,
        (ErcContext::UserEdit, _) => Warning,
    })
}

struct Finding {
    code: ErcCode,
    message: String,
    parts: Vec<RefDes>,
    nets: Vec<NetId>,
    pins: Vec<PinRef>,
    block: Option<BlockId>,
}

impl Finding {
    fn new(code: ErcCode, message: String) -> Finding {
        Finding { code, message, parts: vec![], nets: vec![], pins: vec![], block: None }
    }
    fn parts(mut self, p: impl IntoIterator<Item = RefDes>) -> Self {
        self.parts.extend(p);
        self
    }
    fn nets(mut self, n: impl IntoIterator<Item = NetId>) -> Self {
        self.nets.extend(n);
        self
    }
    fn pins(mut self, p: impl IntoIterator<Item = PinRef>) -> Self {
        self.pins.extend(p);
        self
    }
}

/// Run static ERC. With `scope`, only issues touching that block's parts, nets or ports are kept.
pub fn erc(c: &Circuit, reg: &Registry, ctx: ErcContext, scope: Option<&str>) -> Vec<ErcIssue> {
    let g = Graph::new(c, reg);
    let mut f = Vec::new();
    floating_and_unused(&g, &mut f);
    dangling_nets(&g, &mut f);
    no_dc_path(&g, &mut f);
    vsource_loops(&g, &mut f);
    unpowered_ics(&g, &mut f);
    output_conflicts(&g, &mut f);
    supply_shorts(&g, &mut f);
    over_voltage(&g, &mut f);
    ports_unbound(&g, &mut f);

    let in_scope = |x: &Finding| -> bool {
        let Some(b) = scope else { return true };
        let part_in = |r: &str| c.parts.get(r).is_some_and(|p| p.block.as_deref() == Some(b));
        x.block.as_deref() == Some(b)
            || x.parts.iter().any(|r| part_in(r))
            || x.pins.iter().any(|p| part_in(&p.refdes))
            || x.nets.iter().any(|n| c.nets.get(n).is_some_and(|n| n.pins.iter().any(|p| part_in(&p.refdes))))
    };
    let mut out: Vec<ErcIssue> = f
        .into_iter()
        .filter(in_scope)
        .filter_map(|x| {
            severity(x.code, ctx).map(|severity| ErcIssue {
                rule: x.code.rule().to_string(),
                code: x.code,
                severity,
                message: x.message,
                parts: x.parts,
                nets: x.nets,
                pins: x.pins,
                block: x.block,
            })
        })
        .collect();
    // Natural refdes order (R9 before R10), so issue lists read the way the schematic does.
    out.sort_by_cached_key(|i| {
        let parts: Vec<_> = i.parts.iter().map(|r| refdes_sort_key(r)).collect();
        let pins: Vec<_> = i.pins.iter().map(|p| (refdes_sort_key(&p.refdes), p.pin.clone())).collect();
        (i.code, parts, pins, i.nets.clone(), i.block.clone())
    });
    out
}

/// Supply rails nothing drives: no voltage source and no IC output (a regulator's) on them.
/// A rail flag is a supply, so the compiler simulates each as an ideal source at its declared
/// volts and ERC003 counts it as tied to ground.
pub fn implicit_supplies(c: &Circuit, reg: &Registry) -> Vec<(NetId, f64)> {
    let driven = |p: &PinRef| {
        c.parts
            .get(&p.refdes)
            .and_then(|i| reg.part(&i.part))
            .is_some_and(|d| d.category == Category::V || d.pin(&p.pin).is_some_and(|pd| pd.kind == PinType::Output))
    };
    let mut out: Vec<(NetId, f64)> = c
        .nets
        .values()
        .filter_map(|n| match n.kind {
            NetKind::Power { volts } if !n.pins.iter().any(driven) => Some((n.id.clone(), volts)),
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Nets with no DC path to GND (ERC003). The SPICE compiler shunts these for user circuits.
pub fn floating_nets(c: &Circuit, reg: &Registry) -> Vec<NetId> {
    let g = Graph::new(c, reg);
    let mut f = Vec::new();
    no_dc_path(&g, &mut f);
    let mut nets: Vec<NetId> = f.into_iter().flat_map(|x| x.nets).collect();
    nets.sort();
    nets
}

/// Read-only view with the registry joined in, parts in natural refdes order.
struct Graph<'a> {
    c: &'a Circuit,
    reg: &'a Registry,
    parts: Vec<(&'a PartInstance, &'a PartDef)>,
    pin_net: BTreeMap<&'a PinRef, &'a NetId>,
}

impl<'a> Graph<'a> {
    fn new(c: &'a Circuit, reg: &'a Registry) -> Graph<'a> {
        let parts = c
            .sorted_refdes()
            .into_iter()
            .filter_map(|r| {
                let inst = &c.parts[r];
                reg.part(&inst.part).map(|d| (inst, d))
            })
            .collect();
        Graph { c, reg, parts, pin_net: c.pin_index() }
    }

    fn net_of(&self, refdes: &str, pin: &str) -> Option<&'a NetId> {
        self.pin_net.get(&PinRef::new(refdes, pin)).copied()
    }

    fn net_volts(&self, net: &str) -> Option<f64> {
        match self.c.nets.get(net)?.kind {
            NetKind::Power { volts } => Some(volts),
            NetKind::Ground => Some(0.0),
            NetKind::Signal => None,
        }
    }

    fn dc_value(&self, inst: &PartInstance, def: &PartDef) -> Option<f64> {
        def.dc_param.as_ref().and_then(|p| inst.params.get(p)).map(|q| q.si)
    }
}

/// Union-find over net ids.
struct Dsu<'a> {
    parent: BTreeMap<&'a str, &'a str>,
}

impl<'a> Dsu<'a> {
    fn new(nets: impl IntoIterator<Item = &'a str>) -> Self {
        Dsu { parent: nets.into_iter().map(|n| (n, n)).collect() }
    }
    fn find(&mut self, x: &'a str) -> &'a str {
        let p = self.parent[x];
        if p == x {
            return x;
        }
        let r = self.find(p);
        self.parent.insert(x, r);
        r
    }
    /// Returns false if already joined.
    fn union(&mut self, a: &'a str, b: &'a str) -> bool {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return false;
        }
        // Deterministic: smaller root wins.
        let (lo, hi) = if ra < rb { (ra, rb) } else { (rb, ra) };
        self.parent.insert(hi, lo);
        true
    }
}

fn floating_and_unused(g: &Graph, f: &mut Vec<Finding>) {
    for (inst, def) in &g.parts {
        let mut unused_units = BTreeSet::new();
        for unit in &def.units {
            if def.unit_pins(unit).all(|p| g.net_of(&inst.refdes, &p.name).is_none()) {
                unused_units.insert(unit.as_str());
                f.push(
                    Finding::new(
                        ErcCode::UnusedUnit,
                        format!("{} unit {unit} is unused and left floating", inst.refdes),
                    )
                    .parts([inst.refdes.clone()]),
                );
            }
        }
        let floating: Vec<PinRef> = def
            .pins
            .iter()
            .filter(|p| p.kind != PinType::Nc)
            .filter(|p| !p.unit.as_deref().is_some_and(|u| unused_units.contains(u)))
            .filter(|p| g.net_of(&inst.refdes, &p.name).is_none())
            .map(|p| PinRef::new(&inst.refdes, &p.name))
            .collect();
        if !floating.is_empty() {
            let names: Vec<String> = floating.iter().map(|p| p.to_string()).collect();
            f.push(
                Finding::new(ErcCode::FloatingPin, format!("not connected: {}", names.join(", ")))
                    .parts([inst.refdes.clone()])
                    .pins(floating),
            );
        }
    }
}

/// A ground or an undriven rail with one pin is not dangling: its flag connects that pin to the
/// ground reference or to the rail's (implicit) supply.
fn dangling_nets(g: &Graph, f: &mut Vec<Finding>) {
    let rails: BTreeSet<NetId> = implicit_supplies(g.c, g.reg).into_iter().map(|(n, _)| n).collect();
    let flagged = |n: &Net| n.kind == NetKind::Ground || rails.contains(&n.id);
    for net in g.c.nets.values().filter(|n| n.pins.len() < 2 && !(n.pins.len() == 1 && flagged(n))) {
        f.push(
            Finding::new(ErcCode::DanglingNet, format!("{} connects only {} pin", net.id, net.pins.len()))
                .nets([net.id.clone()])
                .pins(net.pins.iter().cloned()),
        );
    }
}

/// Pins of a part that conduct DC between each other.
fn dc_pins<'a>(g: &Graph<'a>, inst: &'a PartInstance, def: &'a PartDef) -> Vec<&'a NetId> {
    let conducts = |t: PinType| match def.category {
        Category::R | Category::L | Category::V | Category::D | Category::Q => t != PinType::Nc,
        Category::U => !matches!(t, PinType::Input | PinType::Nc),
        Category::C | Category::J => false,
    };
    def.pins.iter().filter(|p| conducts(p.kind)).filter_map(|p| g.net_of(&inst.refdes, &p.name)).collect()
}

fn no_dc_path(g: &Graph, f: &mut Vec<Finding>) {
    let mut dsu = Dsu::new(g.c.nets.keys().map(String::as_str));
    for (inst, def) in &g.parts {
        let nets = dc_pins(g, inst, def);
        for w in nets.windows(2) {
            dsu.union(w[0], w[1]);
        }
    }
    if g.c.nets.contains_key(GND) {
        let rails: BTreeSet<NetId> = implicit_supplies(g.c, g.reg).into_iter().map(|(n, _)| n).collect();
        for id in g.c.nets.keys().filter(|id| rails.contains(*id)) {
            dsu.union(id, GND);
        }
    }
    let gnd_root = g.c.nets.contains_key(GND).then(|| dsu.find(GND));
    let mut groups: BTreeMap<&str, Vec<NetId>> = BTreeMap::new();
    for id in g.c.nets.keys() {
        let root = dsu.find(id);
        if Some(root) != gnd_root {
            groups.entry(root).or_default().push(id.clone());
        }
    }
    for (_, mut nets) in groups {
        nets.sort();
        let msg = if gnd_root.is_none() {
            format!("no GND net: {} has no DC path to ground", nets.join(", "))
        } else {
            format!("{} has no DC path to GND", nets.join(", "))
        };
        f.push(Finding::new(ErcCode::NoDcPath, msg).nets(nets));
    }
}

fn two_terminal<'a>(g: &Graph<'a>, inst: &'a PartInstance, def: &'a PartDef) -> Option<(&'a NetId, &'a NetId)> {
    let (a, b) = match def.category {
        Category::V => ("P", "N"),
        _ if def.pins.len() == 2 => (def.pins[0].name.as_str(), def.pins[1].name.as_str()),
        _ => return None,
    };
    Some((g.net_of(&inst.refdes, a)?, g.net_of(&inst.refdes, b)?))
}

fn vsource_loops(g: &Graph, f: &mut Vec<Finding>) {
    let mut dsu = Dsu::new(g.c.nets.keys().map(String::as_str));
    for (inst, def) in g.parts.iter().filter(|(_, d)| matches!(d.category, Category::V | Category::L)) {
        let Some((a, b)) = two_terminal(g, inst, def) else { continue };
        if a == b {
            continue; // a shorted source is ERC007; a shorted inductor is harmless
        }
        if !dsu.union(a, b) {
            f.push(
                Finding::new(
                    ErcCode::VsourceLoop,
                    format!("{} closes a loop of voltage sources/inductors between {a} and {b}", inst.refdes),
                )
                .parts([inst.refdes.clone()])
                .nets([a.clone(), b.clone()]),
            );
        }
    }
}

fn unpowered_ics(g: &Graph, f: &mut Vec<Finding>) {
    for (inst, def) in g.parts.iter().filter(|(_, d)| d.category == Category::U) {
        for p in &def.pins {
            let kind = g.net_of(&inst.refdes, &p.name).and_then(|n| g.c.nets.get(n)).map(|n| n.kind);
            let ok = match p.kind {
                PinType::PowerPos => matches!(kind, Some(NetKind::Power { .. })),
                PinType::PowerNeg => matches!(kind, Some(NetKind::Power { .. } | NetKind::Ground)),
                _ => true,
            };
            if !ok {
                let pin = PinRef::new(&inst.refdes, &p.name);
                f.push(
                    Finding::new(ErcCode::UnpoweredIc, format!("{pin} is not on a power net"))
                        .parts([inst.refdes.clone()])
                        .pins([pin]),
                );
            }
        }
    }
}

fn output_conflicts(g: &Graph, f: &mut Vec<Finding>) {
    let defs: BTreeMap<&str, &PartDef> = g.parts.iter().map(|(i, d)| (i.refdes.as_str(), *d)).collect();
    for net in g.c.nets.values() {
        let outs: Vec<PinRef> = net
            .pins
            .iter()
            .filter(|p| {
                defs.get(p.refdes.as_str()).and_then(|d| d.pin(&p.pin)).is_some_and(|d| d.kind == PinType::Output)
            })
            .cloned()
            .collect();
        if outs.len() > 1 {
            let names: Vec<String> = outs.iter().map(|p| p.to_string()).collect();
            f.push(
                Finding::new(
                    ErcCode::OutputConflict,
                    format!("outputs {} drive {} together", names.join(", "), net.id),
                )
                .nets([net.id.clone()])
                .pins(outs),
            );
        }
    }
}

fn supply_shorts(g: &Graph, f: &mut Vec<Finding>) {
    // (lower net, higher net) -> (refdes, volts across lower→higher)
    let mut across: BTreeMap<(&NetId, &NetId), (&RefDes, f64)> = BTreeMap::new();
    for (inst, def) in g.parts.iter().filter(|(_, d)| d.category == Category::V) {
        let Some((p, n)) = two_terminal(g, inst, def) else { continue };
        let Some(dc) = g.dc_value(inst, def) else { continue };
        let r = &inst.refdes;
        if p == n {
            f.push(
                Finding::new(ErcCode::SupplyShort, format!("{r} is shorted: both terminals on {p}"))
                    .parts([r.clone()])
                    .nets([p.clone()]),
            );
            continue;
        }
        // A source between a declared power net and GND must match its declared volts.
        for (rail, sign) in [(p, 1.0), (n, -1.0)] {
            let other = if rail == p { n } else { p };
            if let (Some(NetKind::Power { volts }), true) = (g.c.nets.get(rail).map(|x| x.kind), other == GND)
                && (sign * dc - volts).abs() > 1e-9 * volts.abs().max(1.0)
            {
                f.push(
                    Finding::new(
                        ErcCode::SupplyShort,
                        format!("{r} drives {rail} to {}V but the net is declared {volts}V", sign * dc),
                    )
                    .parts([r.clone()])
                    .nets([rail.clone()]),
                );
            }
        }
        // V(key.0) − V(key.1); a source defines V(P) − V(N) = dc.
        let (key, v) = if p < n { ((p, n), dc) } else { ((n, p), -dc) };
        match across.get(&key) {
            Some((other, ov)) if (ov - v).abs() > 1e-9 * v.abs().max(1.0) => f.push(
                Finding::new(
                    ErcCode::SupplyShort,
                    format!("{other} and {r} force different voltages across {} and {}", key.0, key.1),
                )
                .parts([(*other).clone(), r.clone()])
                .nets([key.0.clone(), key.1.clone()]),
            ),
            Some(_) => {}
            None => {
                across.insert(key, (r, v));
            }
        }
    }
}

fn over_voltage(g: &Graph, f: &mut Vec<Finding>) {
    for (inst, def) in g.parts.iter().filter(|(_, d)| d.category == Category::U) {
        let Some(max) = def.limits.get("v_supply_max") else { continue };
        let rail = |t: PinType| {
            def.pins
                .iter()
                .filter(|p| p.kind == t)
                .find_map(|p| g.net_of(&inst.refdes, &p.name))
                .and_then(|n| g.net_volts(n))
        };
        if let (Some(hi), Some(lo)) = (rail(PinType::PowerPos), rail(PinType::PowerNeg))
            && hi - lo > *max
        {
            f.push(
                Finding::new(
                    ErcCode::OverVoltage,
                    format!("{} sees {}V across its supply pins (max {max}V)", inst.refdes, hi - lo),
                )
                .parts([inst.refdes.clone()]),
            );
        }
    }
}

fn ports_unbound(g: &Graph, f: &mut Vec<Finding>) {
    for block in g.c.blocks.values() {
        for port in &block.ports {
            let bound = g.c.nets.get(&port.net).is_some_and(|n| {
                n.pins.iter().any(|p| g.c.parts.get(&p.refdes).is_some_and(|x| x.block.as_ref() == Some(&block.id)))
            });
            if !bound {
                let mut x = Finding::new(
                    ErcCode::PortUnbound,
                    format!("block {} port \"{}\" is not bound to a part on {}", block.id, port.name, port.net),
                )
                .nets([port.net.clone()]);
                x.block = Some(block.id.clone());
                f.push(x);
            }
        }
    }
}
