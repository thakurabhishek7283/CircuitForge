//! SPICE compiler (LLD §8). Byte-identical output on every runtime; the netlist hash is the cache
//! key for every simulation result. Netlists are built only from registry templates and parsed
//! numbers, so neither users nor the model can inject SPICE (`.control`, `.include`, `shell`).

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::erc::floating_nets;
use crate::ir::*;
use crate::registry::{Category, PartDef, Registry};
use crate::units::{Unit, spice_number};

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Netlist {
    /// Deterministic: parts in natural refdes order.
    pub text: String,
    /// Lowercase hex sha256 of `text`.
    pub hash: String,
    /// IR net id -> SPICE node name ("N_VOUT" -> "n_vout", "GND" -> "0").
    pub node_map: BTreeMap<NetId, String>,
    /// Registry model files the simulator must load, relative to the registry root.
    pub includes: Vec<String>,
    /// Spec checks as `.meas` statements (filled once block templates define them).
    pub meas: Vec<MeasDef>,
    /// Current into each connected pin (`"R1.1"`), as a sum of saved vectors, for the overlays
    /// and current probes. OP and transient plots only: device currents do not exist in AC.
    /// Pins inside subcircuit models (op-amps, regulators) are absent; a net with one such pin
    /// gets its current by KCL.
    pub pin_currents: BTreeMap<String, Vec<CurrentTerm>>,
    /// The analyses in the deck, in order (resolved from `CompileOpts`).
    pub analyses: Vec<Analysis>,
}

/// `coeff · vector`, e.g. `-1 · @r1[i]`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct CurrentTerm {
    /// Canonical result vector name: `@r1[i]`, `i(v1)`, `@q1[ic]`.
    pub vector: String,
    pub coeff: f64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct MeasDef {
    pub name: String,
    pub line: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
pub struct CompileOpts {
    /// Add a 1 GΩ shunt to ground on every node without a DC path (user circuits, ERC003),
    /// so the simulation still runs and the tutor can explain the problem.
    #[serde(default)]
    pub shunt_floating: bool,
    /// Override the circuit's analyses. `None` uses `circuit.analyses`, or `.op` if that is empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyses: Option<Vec<Analysis>>,
    /// Without `analyses`: the editor's set, [`interactive_analyses`].
    #[serde(default)]
    pub interactive: bool,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, thiserror::Error)]
#[error("{refdes:?}: {message}")]
pub struct CompileError {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refdes: Option<RefDes>,
    pub message: String,
}

fn cerr(refdes: Option<&str>, message: impl Into<String>) -> CompileError {
    CompileError { refdes: refdes.map(str::to_string), message: message.into() }
}

pub const SHUNT_OHMS: f64 = 1e9;

pub fn node_name(net: &str) -> String {
    if net == GND { "0".to_string() } else { net.to_ascii_lowercase() }
}

pub fn compile(c: &Circuit, reg: &Registry, opts: &CompileOpts) -> Result<Netlist, CompileError> {
    let pin_net = c.pin_index();
    let node_map: BTreeMap<NetId, String> = c.nets.keys().map(|k| (k.clone(), node_name(k))).collect();
    let mut includes = BTreeSet::new();
    let mut elements = Vec::new();
    let mut saves = vec!["all".to_string()];
    let mut nc_nodes = BTreeSet::new();
    let mut pin_currents = BTreeMap::new();

    for refdes in c.sorted_refdes() {
        let inst = &c.parts[refdes];
        let def =
            reg.part(&inst.part).ok_or_else(|| cerr(Some(refdes), format!("{} is not in the registry", inst.part)))?;
        let Some(sp) = &def.spice else { continue };
        if let Some(inc) = &sp.include {
            includes.insert(inc.clone());
        }
        let mut node = |pin: &str| -> String {
            match pin_net.get(&PinRef::new(refdes, pin)) {
                Some(net) => node_name(net),
                None => {
                    let n = format!("nc_{refdes}_{pin}").to_ascii_lowercase();
                    nc_nodes.insert(n.clone());
                    n
                }
            }
        };
        if let Some(line) = &sp.line {
            elements.push(
                expand(line, |name| resolve(name, inst, def, None, &mut node)).map_err(|m| cerr(Some(refdes), m))?,
            );
        } else if let Some(line) = &sp.unit_line {
            for unit in &def.units {
                let used = def.unit_pins(unit).any(|p| pin_net.contains_key(&PinRef::new(refdes, &p.name)));
                if used {
                    elements.push(
                        expand(line, |name| resolve(name, inst, def, Some(unit), &mut node))
                            .map_err(|m| cerr(Some(refdes), m))?,
                    );
                }
            }
        }
        let r = refdes.to_ascii_lowercase();
        match def.category {
            Category::R | Category::C | Category::L => saves.push(format!("@{r}[i]")),
            Category::D => saves.push(format!("@{r}[id]")),
            Category::Q => saves.extend([format!("@{r}[ic]"), format!("@{r}[ib]")]),
            _ => {}
        }
        if let Some(line) = &sp.line {
            for (pin, terms) in terminal_currents(def, &r, line) {
                if pin_net.contains_key(&PinRef::new(refdes, &pin)) {
                    pin_currents.insert(format!("{refdes}.{pin}"), terms);
                }
            }
        }
    }

    if opts.shunt_floating {
        let mut shunted: BTreeSet<String> = floating_nets(c, reg).iter().map(|n| node_name(n)).collect();
        shunted.extend(nc_nodes);
        for n in shunted.into_iter().filter(|n| n != "0") {
            elements.push(format!("Rshunt_{n} {n} 0 {}", spice_number(SHUNT_OHMS)));
        }
    }

    let analyses = match &opts.analyses {
        Some(a) => a.clone(),
        None if opts.interactive => interactive_analyses(c, reg),
        None if c.analyses.is_empty() => vec![Analysis::Op],
        None => c.analyses.clone(),
    };
    let mut analysis_lines = Vec::new();
    for a in &analyses {
        analysis_lines.push(match a {
            Analysis::Op => ".op".to_string(),
            Analysis::Dc { source, start, stop, step } => {
                if !c.parts.get(source).is_some_and(|p| reg.part(&p.part).is_some_and(|d| d.category == Category::V)) {
                    return Err(cerr(Some(source), "DC sweep source must be a voltage source in the circuit"));
                }
                format!(".dc {source} {} {} {}", spice_number(*start), spice_number(*stop), spice_number(*step))
            }
            Analysis::Ac { points_per_decade, f_start, f_stop } => {
                format!(".ac dec {points_per_decade} {} {}", spice_number(*f_start), spice_number(*f_stop))
            }
            Analysis::Tran { t_step, t_stop } => format!(".tran {} {}", spice_number(*t_step), spice_number(*t_stop)),
        });
    }

    let includes: Vec<String> = includes.into_iter().collect();
    let mut text = String::from("* circuit-tutor netlist\n");
    for inc in &includes {
        text.push_str(&format!(".include {inc}\n"));
    }
    for e in &elements {
        text.push_str(e);
        text.push('\n');
    }
    text.push_str(".options reltol=1e-3 gmin=1e-12\n");
    text.push_str(&format!(".save {}\n", saves.join(" ")));
    for a in &analysis_lines {
        text.push_str(a);
        text.push('\n');
    }
    text.push_str(".end\n");

    let hash = Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    Ok(Netlist { text, hash, node_map, includes, meas: Vec::new(), pin_currents, analyses })
}

/// Pin currents of a primitive device, from SPICE's fixed terminal order (`R n+ n-`,
/// `D anode cathode`, `V n+ n-`, `Q c b e`): ngspice reports current *into* the first terminal.
fn terminal_currents(def: &PartDef, r: &str, line: &str) -> Vec<(String, Vec<CurrentTerm>)> {
    let pins: Vec<&str> = placeholders(line).filter(|n| def.pin(n).is_some()).collect();
    let t = |vector: String, coeff: f64| CurrentTerm { vector, coeff };
    let two = |v: String| match pins[..] {
        [a, b, ..] => vec![(a.to_string(), vec![t(v.clone(), 1.0)]), (b.to_string(), vec![t(v, -1.0)])],
        _ => Vec::new(),
    };
    match def.category {
        Category::R | Category::C | Category::L => two(format!("@{r}[i]")),
        Category::D => two(format!("@{r}[id]")),
        Category::V => two(format!("i({r})")),
        Category::Q => match pins[..] {
            [c, b, e, ..] => {
                let (ic, ib) = (format!("@{r}[ic]"), format!("@{r}[ib]"));
                vec![
                    (c.to_string(), vec![t(ic.clone(), 1.0)]),
                    (b.to_string(), vec![t(ib.clone(), 1.0)]),
                    (e.to_string(), vec![t(ic, -1.0), t(ib, -1.0)]),
                ]
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// `{name}` placeholders of a template line, in order.
fn placeholders(tpl: &str) -> impl Iterator<Item = &str> {
    tpl.split('{').skip(1).filter_map(|s| s.split_once('}').map(|(name, _)| name))
}

/// Default short transient for the editor (LLD §8): five periods of the slowest periodic source,
/// or 10 ms without one, in about 1,000 steps.
pub const DEFAULT_TRAN_PERIODS: f64 = 5.0;
pub const DEFAULT_TRAN_STOP: f64 = 10e-3;
pub const DEFAULT_TRAN_STEPS: f64 = 1000.0;

/// What the editor simulates after every edit (LLD §8): the operating point, the circuit's own
/// transient or else a short default one, then the circuit's other analyses (AC, DC sweeps).
/// AC and long transients therefore run only once someone asked for them with `analysis.set`.
pub fn interactive_analyses(c: &Circuit, reg: &Registry) -> Vec<Analysis> {
    let mut out = vec![Analysis::Op];
    match c.analyses.iter().find(|a| matches!(a, Analysis::Tran { .. })) {
        Some(tran) => out.push(tran.clone()),
        None => {
            let slowest = c
                .parts
                .values()
                .filter_map(|p| reg.part(&p.part).filter(|d| d.category == Category::V).map(|_| p))
                .flat_map(|p| p.params.values())
                .filter(|q| q.unit == Unit::Hertz && q.si > 0.0)
                .map(|q| q.si)
                .reduce(f64::min);
            let t_stop = slowest.map_or(DEFAULT_TRAN_STOP, |f| (DEFAULT_TRAN_PERIODS / f).clamp(1e-6, 1.0));
            out.push(Analysis::Tran { t_step: t_stop / DEFAULT_TRAN_STEPS, t_stop });
        }
    }
    out.extend(c.analyses.iter().filter(|a| !matches!(a, Analysis::Op | Analysis::Tran { .. })).cloned());
    out
}

fn resolve(
    name: &str,
    inst: &PartInstance,
    def: &PartDef,
    unit: Option<&str>,
    node: &mut impl FnMut(&str) -> String,
) -> Option<String> {
    match (name, unit) {
        ("refdes", _) => return Some(inst.refdes.clone()),
        ("unit", Some(u)) => return Some(u.to_string()),
        _ => {}
    }
    let pin = match unit {
        Some(u) => def.resolve_unit_pin(u, name),
        None => def.pin(name),
    };
    if let Some(p) = pin {
        return Some(node(&p.name));
    }
    inst.params.get(name).map(|q| q.to_spice())
}

fn expand(tpl: &str, mut resolve: impl FnMut(&str) -> Option<String>) -> Result<String, String> {
    let mut out = String::with_capacity(tpl.len() + 16);
    let mut rest = tpl;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let close = rest[open..].find('}').ok_or_else(|| format!("unbalanced brace in \"{tpl}\""))?;
        let name = &rest[open + 1..open + close];
        out.push_str(&resolve(name).ok_or_else(|| format!("cannot resolve {{{name}}} in \"{tpl}\""))?);
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}
