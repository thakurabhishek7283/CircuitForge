//! Block templates (LLD §12): a verified sub-circuit with named ports, a value solver that turns
//! targets ("fc = 1 kHz") into part values, and the spec checks that prove it works.
//!
//! Templates are data (`registry/templates/*.yaml`, shipped in the bundle); solvers are code in
//! this crate ([`solvers`]), so the browser and the API instantiate a template identically.
//! Instantiation only reads the circuit: it returns ops (`block.begin`, `part.add`,
//! `net.connect`, `analysis.set`, `block.commit`) that still go through `apply()`.

pub mod checks;
pub mod solvers;

use std::collections::{BTreeMap, BTreeSet};

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::apply::{apply_ops, net_conflict, refdes_category, valid_net_id};
use crate::error::{ErrorCode as E, OpError, err};
use crate::ir::*;
use crate::ops::{Author, BlockBegin, BlockRef, NetConnect, Op, PartAdd};
use crate::registry::{PartDef, PinType};
use crate::units::{Quantity, Unit, parse_quantity};
use crate::{Registry, edit};

pub use checks::{CheckResult, SpecCheckDef, evaluate_checks};

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TemplateDef {
    pub id: String,
    pub version: u32,
    pub role: BlockRole,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teach: Option<String>,
    /// What the user asks for, in order (the insert form shows them in this order).
    #[serde(default)]
    pub targets: IndexMap<String, TargetDef>,
    /// The block's interface: port name -> direction.
    pub ports: IndexMap<String, PortDirection>,
    /// The supply each power port expects: default rail and the range the design works over.
    #[serde(default)]
    pub rails: IndexMap<String, RailDef>,
    /// Local refdes (R1, C1, U1, ...) -> registry part. Renumbered on instantiation.
    pub parts: IndexMap<String, TemplatePart>,
    /// Port or internal net name -> pins (`R1.2`, `U1.OUT_A`). Every port has one.
    pub nets: IndexMap<String, Vec<PinRef>>,
    /// A solver in [`solvers`], by name.
    pub solver: String,
    pub checks: Vec<CheckDef>,
    /// The test bench CI simulates the template in (LLD §12 step 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<VerifyBench>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TargetDef {
    pub label: String,
    pub unit: Unit,
    /// In SI units; YAML may write `10`, `50k` or `1meg`.
    #[serde(deserialize_with = "eng")]
    pub min: f64,
    #[serde(deserialize_with = "eng")]
    pub max: f64,
    /// As the user would type it.
    pub default: String,
    /// How verification spreads its points (frequencies and gains are `log`).
    #[serde(default)]
    pub scale: Scale,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scale {
    #[default]
    Lin,
    Log,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RailDef {
    /// The rail this port binds to by default (created if missing).
    pub net: NetId,
    pub volts: f64,
    /// The supply range the design is verified over; absent means exactly `volts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
}

impl RailDef {
    pub fn range(&self) -> (f64, f64) {
        (self.min.unwrap_or(self.volts), self.max.unwrap_or(self.volts))
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TemplatePart {
    pub part: PartId,
}

/// One spec check: what to measure (a closed set of kinds, so a template can never inject SPICE)
/// on which ports. Its target is the block's `spec[name]`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckDef {
    pub name: String,
    pub label: String,
    /// A few characters for badges on the drawing: `fc`, `Q`, `Vth+`.
    pub symbol: String,
    pub kind: CheckKind,
    /// Output port measured.
    pub out: String,
    /// Input port (gain reference, threshold input).
    #[serde(default, rename = "in", skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// Which side of a corner is the pass band (corner and Q checks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass: Option<Pass>,
    /// Output edge whose input level is the threshold (threshold checks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge: Option<Edge>,
    /// Frequency a gain is measured at; default 1 kHz.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "eng_opt")]
    pub at_hz: Option<f64>,
    /// The transient a time-domain check needs. Regenerative circuits (a Schmitt trigger) switch
    /// late in simulation unless the steps are near the op-amp's own speed: with coarse steps the
    /// integrator follows the unstable balance point until it hits a rail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tran: Option<TranWindow>,
    pub tol_pct: f64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TranWindow {
    /// Run length, seconds.
    #[serde(deserialize_with = "eng")]
    pub stop: f64,
    /// Largest step, seconds.
    #[serde(deserialize_with = "eng")]
    pub step: f64,
}

/// LLD §7 spec checks. Each is a few primitive ngspice `.meas` results combined by
/// [`evaluate_checks`] (ngspice cannot measure an expression such as `vdb(out)-vdb(in)`).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum CheckKind {
    /// −3 dB frequency below the pass-band gain (AC).
    AcCorner,
    /// Q of a 2nd-order low/high-pass: |H(f0)| / pass-band gain, f0 at the ∓90° phase point (AC).
    /// Assumes the input port is driven with flat phase (a source or a buffer).
    AcQ,
    /// |V(out)| / |V(in)| at `at_hz` (AC).
    AcGain,
    /// Band-pass centre, √(f_lo·f_hi) of the −3 dB points around the peak (AC).
    AcCenter,
    /// Band-pass Q, centre / (f_hi − f_lo) (AC).
    AcBandQ,
    /// Frequency of a periodic output: two periods between rising crossings of mid-level, in the
    /// second half of the transient (tran).
    TranFreq,
    /// Share of a period the output is high, from its average over two periods (tran).
    TranDuty,
    /// Half the peak-to-peak output (tran).
    TranAmplitude,
    /// Average output over the transient: the DC level (ngspice `.meas` has no OP mode).
    DcLevel,
    /// Input level at the 2nd rising/falling output edge: a comparator threshold (tran).
    TranThreshold,
}

impl CheckKind {
    pub fn unit(self) -> Unit {
        match self {
            CheckKind::AcCorner | CheckKind::AcCenter | CheckKind::TranFreq => Unit::Hertz,
            CheckKind::AcQ | CheckKind::AcBandQ | CheckKind::AcGain | CheckKind::TranDuty => Unit::Unitless,
            CheckKind::TranAmplitude | CheckKind::DcLevel | CheckKind::TranThreshold => Unit::Volt,
        }
    }

    /// A response to an input signal (an oscillator's or a supply's output needs none).
    pub fn needs_signal(self) -> bool {
        self.is_ac() || self == CheckKind::TranThreshold
    }

    pub fn is_ac(self) -> bool {
        matches!(
            self,
            CheckKind::AcCorner | CheckKind::AcQ | CheckKind::AcGain | CheckKind::AcCenter | CheckKind::AcBandQ
        )
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Pass {
    Low,
    High,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Rise,
    Fall,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VerifyBench {
    /// A sine source from each listed port to ground.
    #[serde(default)]
    pub drive: IndexMap<String, Drive>,
    /// A resistor from each listed port to ground, in ohms.
    #[serde(default, deserialize_with = "eng_map")]
    pub load: IndexMap<String, f64>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Drive {
    #[serde(deserialize_with = "eng")]
    pub amplitude: f64,
    #[serde(deserialize_with = "eng")]
    pub frequency: f64,
    #[serde(default, deserialize_with = "eng")]
    pub offset: f64,
}

// ---------------------------------------------------------------- YAML numbers

#[derive(Deserialize)]
#[serde(untagged)]
enum NumOrStr {
    Num(f64),
    Str(String),
}

fn num(v: NumOrStr) -> Result<f64, String> {
    match v {
        NumOrStr::Num(x) => Ok(x),
        NumOrStr::Str(s) => parse_quantity(&s, Unit::Unitless).map(|q| q.si).map_err(|e| e.to_string()),
    }
}

fn eng<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    num(NumOrStr::deserialize(d)?).map_err(serde::de::Error::custom)
}

fn eng_opt<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Option::<NumOrStr>::deserialize(d)?.map(num).transpose().map_err(serde::de::Error::custom)
}

fn eng_map<'de, D: serde::Deserializer<'de>>(d: D) -> Result<IndexMap<String, f64>, D::Error> {
    IndexMap::<String, NumOrStr>::deserialize(d)?
        .into_iter()
        .map(|(k, v)| num(v).map(|x| (k, x)))
        .collect::<Result<_, _>>()
        .map_err(serde::de::Error::custom)
}

// ---------------------------------------------------------------- validation

fn ident(s: &str) -> bool {
    !s.is_empty()
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

impl TemplateDef {
    pub fn is_power(dir: PortDirection) -> bool {
        matches!(dir, PortDirection::PowerPos | PortDirection::PowerNeg)
    }

    /// Target values at the middle of every range (log ranges: the geometric middle).
    pub fn center(&self) -> (BTreeMap<String, f64>, BTreeMap<String, f64>) {
        let targets = self.targets.iter().map(|(k, t)| (k.clone(), t.at(0.5))).collect();
        let rails = self.rails.iter().map(|(k, r)| (k.clone(), r.volts)).collect();
        (targets, rails)
    }

    /// Structural checks against the parts, then a solve at the centre of the ranges so a
    /// solver/template mismatch fails when the bundle loads, not when a student clicks Insert.
    pub(crate) fn validate(&self, parts: &IndexMap<PartId, PartDef>) -> Vec<String> {
        let mut errs = Vec::new();
        if !ident(&self.id) {
            errs.push(format!("id \"{}\" must be lowercase [a-z0-9_]", self.id));
        }
        for (name, t) in &self.targets {
            if !ident(name) {
                errs.push(format!("target name \"{name}\" must be lowercase [a-z0-9_]"));
            }
            if !(t.min.is_finite() && t.max.is_finite() && t.min < t.max) {
                errs.push(format!("target {name}: needs min < max"));
            }
            if t.scale == Scale::Log && t.min <= 0.0 {
                errs.push(format!("target {name}: a log range must be positive"));
            }
            match parse_quantity(&t.default, t.unit) {
                Ok(q) if q.si >= t.min && q.si <= t.max => {}
                Ok(_) => errs.push(format!("target {name}: default {} outside min/max", t.default)),
                Err(e) => errs.push(format!("target {name}: default: {e}")),
            }
        }
        for (name, dir) in &self.ports {
            if !ident(name) {
                errs.push(format!("port name \"{name}\" must be lowercase [a-z0-9_]"));
            }
            if Self::is_power(*dir) && !self.rails.contains_key(name) {
                errs.push(format!("power port {name} needs a rail"));
            }
            if !self.nets.contains_key(name) {
                errs.push(format!("port {name} has no net"));
            }
        }
        for (name, r) in &self.rails {
            match self.ports.get(name) {
                Some(d) if Self::is_power(*d) => {}
                _ => errs.push(format!("rail {name} is not a power port")),
            }
            if !valid_net_id(&r.net) || r.net == GND {
                errs.push(format!("rail {name}: \"{}\" is not a valid rail net", r.net));
            }
            let (lo, hi) = r.range();
            if r.volts == 0.0 || !(lo <= r.volts && r.volts <= hi) || lo * hi <= 0.0 {
                errs.push(format!("rail {name}: volts must be non-zero, one sign, within min..max"));
            }
        }

        let mut used_pins: BTreeSet<&PinRef> = BTreeSet::new();
        for (local, tp) in &self.parts {
            let Some(def) = parts.get(&tp.part) else {
                errs.push(format!("part {local}: {} is not in the registry", tp.part));
                continue;
            };
            if refdes_category(local) != Some(def.category) {
                errs.push(format!(
                    "part {local}: a {:?} part needs a refdes like {}1",
                    def.category,
                    def.category.letter()
                ));
            }
        }
        for (name, pins) in &self.nets {
            if !ident(name) {
                errs.push(format!("net name \"{name}\" must be lowercase [a-z0-9_]"));
            }
            if pins.is_empty() || (pins.len() < 2 && !self.ports.contains_key(name)) {
                errs.push(format!("net {name}: an internal net needs at least 2 pins"));
            }
            for p in pins {
                match self.parts.get(&p.refdes).and_then(|tp| parts.get(&tp.part)) {
                    None => errs.push(format!("net {name}: {p} names no template part")),
                    Some(def) if def.pin(&p.pin).is_none() => {
                        errs.push(format!("net {name}: {} has no pin {}", def.id, p.pin))
                    }
                    Some(_) if !used_pins.insert(p) => errs.push(format!("net {name}: {p} is on two nets")),
                    Some(_) => {}
                }
            }
        }
        // Every pin is wired, except `nc` pins and the pins of a wholly unused unit.
        for (local, tp) in &self.parts {
            let Some(def) = parts.get(&tp.part) else { continue };
            let on = |pin: &str| used_pins.contains(&PinRef::new(local, pin));
            for p in &def.pins {
                let unit_unused = p.unit.as_ref().is_some_and(|u| !def.unit_pins(u).any(|q| on(&q.name)));
                if p.kind != PinType::Nc && !unit_unused && !on(&p.name) {
                    errs.push(format!("{local}.{} is not on any net", p.name));
                }
            }
        }

        if solvers::solver(&self.solver).is_none() {
            errs.push(format!("unknown solver \"{}\" (known: {})", self.solver, solvers::NAMES.join(", ")));
        }
        let mut names = BTreeSet::new();
        for ch in &self.checks {
            if !ident(&ch.name) || !names.insert(&ch.name) {
                errs.push(format!("check \"{}\": names must be unique lowercase [a-z0-9_]", ch.name));
            }
            if ch.symbol.is_empty() || ch.symbol.chars().count() > 6 {
                errs.push(format!("check {}: symbol must be 1 to 6 characters", ch.name));
            }
            for port in std::iter::once(&ch.out).chain(&ch.input) {
                if !self.ports.contains_key(port) {
                    errs.push(format!("check {}: no port {port}", ch.name));
                }
            }
            let needs_in = matches!(ch.kind, CheckKind::AcGain | CheckKind::TranThreshold);
            if needs_in != ch.input.is_some() {
                errs.push(format!("check {}: `in` is {}", ch.name, if needs_in { "required" } else { "not used" }));
            }
            let needs_pass = matches!(ch.kind, CheckKind::AcCorner | CheckKind::AcQ);
            if needs_pass != ch.pass.is_some() {
                errs.push(format!("check {}: `pass` is {}", ch.name, if needs_pass { "required" } else { "not used" }));
            }
            if (ch.kind == CheckKind::TranThreshold) != ch.edge.is_some() {
                errs.push(format!("check {}: `edge` is only, and always, for tran_threshold", ch.name));
            }
            if ch.at_hz.is_some() && ch.kind != CheckKind::AcGain || ch.at_hz.is_some_and(|f| f.is_nan() || f <= 0.0) {
                errs.push(format!("check {}: `at_hz` is a positive frequency for ac_gain", ch.name));
            }
            if let Some(w) = ch.tran
                && (ch.kind.is_ac() || !(w.step > 0.0 && w.stop > w.step))
            {
                errs.push(format!("check {}: `tran` needs 0 < step < stop and a time-domain kind", ch.name));
            }
            if !(ch.tol_pct > 0.0 && ch.tol_pct < 100.0) {
                errs.push(format!("check {}: tol_pct must be in (0, 100)", ch.name));
            }
            if let Some(t) = self.targets.get(&ch.name)
                && t.unit != ch.kind.unit()
            {
                errs.push(format!(
                    "check {}: measures {:?} but the target is in {:?}",
                    ch.name,
                    ch.kind.unit(),
                    t.unit
                ));
            }
        }
        let has = |k| self.checks.iter().any(|c| c.kind == k);
        // A check whose target is not a frequency gets its analysis range from a sibling's.
        for (k, needs) in [
            (CheckKind::TranDuty, CheckKind::TranFreq),
            (CheckKind::AcQ, CheckKind::AcCorner),
            (CheckKind::AcBandQ, CheckKind::AcCenter),
        ] {
            if has(k) && !has(needs) {
                errs.push(format!(
                    "a {k:?} check needs a {needs:?} check: the analysis range comes from its frequency"
                ));
            }
        }
        if let Some(v) = &self.verify {
            for port in v.drive.keys().chain(v.load.keys()) {
                if !self.ports.contains_key(port) {
                    errs.push(format!("verify: no port {port}"));
                }
            }
        }
        if !errs.is_empty() {
            return errs;
        }

        let (targets, rails) = self.center();
        match self.solve(parts, &targets, &rails) {
            Ok(solved) => {
                for ch in &self.checks {
                    if !targets.contains_key(&ch.name) && !solved.spec.contains_key(&ch.name) {
                        errs.push(format!("check {}: neither a target nor a value the solver derives", ch.name));
                    }
                }
            }
            Err(e) => errs.push(format!("solver {} at the centre of the ranges: {e}", self.solver)),
        }
        errs
    }

    /// Run the solver and check its output: a value for every param of every part that has
    /// params, nothing else, each within the part's range.
    pub fn solve(
        &self,
        parts: &IndexMap<PartId, PartDef>,
        targets: &BTreeMap<String, f64>,
        rails: &BTreeMap<String, f64>,
    ) -> Result<Solution, String> {
        let f = solvers::solver(&self.solver).ok_or_else(|| format!("unknown solver {}", self.solver))?;
        let out = f(&solvers::Input { targets, rails })?;
        let mut values = BTreeMap::new();
        for (local, tp) in &self.parts {
            let def = parts.get(&tp.part).ok_or_else(|| format!("{} is not in the registry", tp.part))?;
            let mut params = BTreeMap::new();
            for (key, pd) in &def.params {
                let si = out
                    .values
                    .get(local)
                    .and_then(|m| m.get(key))
                    .ok_or_else(|| format!("no value for {local}.{key}"))?;
                if !si.is_finite() || pd.min.is_some_and(|lo| *si < lo) || pd.max.is_some_and(|hi| *si > hi) {
                    return Err(format!("{local}.{key} = {si} is outside the part's range"));
                }
                params.insert(key.clone(), Quantity::new(*si, pd.unit));
            }
            values.insert(local.clone(), params);
        }
        for (local, m) in &out.values {
            for key in m.keys() {
                if !values.get(local).is_some_and(|p| p.contains_key(key)) {
                    return Err(format!("solver set {local}.{key}, which the template has no param for"));
                }
            }
        }
        // Derived targets can come from ln/exp, whose last bits differ between libm builds (native
        // vs WASM). Four significant digits, through Rust's exact float formatting, make the IR
        // identical on every runtime; part values are already exact (E-series from decimal text).
        let spec = out.spec.into_iter().map(|(k, v)| (k, format!("{v:.3e}").parse().expect("re-parses"))).collect();
        Ok(Solution { values, spec })
    }
}

impl TargetDef {
    /// The value at fraction `x` of the range (geometric for log ranges).
    pub fn at(&self, x: f64) -> f64 {
        match self.scale {
            Scale::Lin => self.min + x * (self.max - self.min),
            Scale::Log => (self.min.ln() + x * (self.max / self.min).ln()).exp(),
        }
    }
}

/// Solved part values (per local refdes and param) and the spec targets the solver derives.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Solution {
    pub values: BTreeMap<String, BTreeMap<String, Quantity>>,
    pub spec: BTreeMap<String, f64>,
}

// ---------------------------------------------------------------- verification points

/// One verification point: target values as text (what a user would type) and rail volts.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct VerifyPoint {
    pub targets: BTreeMap<String, String>,
    pub rails: BTreeMap<String, f64>,
}

/// The 5 points CI verifies a template at (LLD §12 step 2), spread over every target and rail
/// range: with two or more dimensions the first two take the corners and the centre; a single
/// dimension takes quarters; further dimensions cycle through quarters.
pub fn verify_points(t: &TemplateDef) -> Vec<VerifyPoint> {
    const CORNERS: [(f64, f64); 5] = [(0.0, 0.0), (1.0, 1.0), (0.0, 1.0), (1.0, 0.0), (0.5, 0.5)];
    let ranged_rails: Vec<&String> =
        t.rails.iter().filter(|(_, r)| r.range().0 < r.range().1).map(|(k, _)| k).collect();
    let dims = t.targets.len() + ranged_rails.len();
    (0..5)
        .map(|k| {
            let frac = |d: usize| match (dims, d) {
                (1, _) => k as f64 / 4.0,
                (_, 0) => CORNERS[k].0,
                (_, 1) => CORNERS[k].1,
                _ => ((k + 2 * d) % 5) as f64 / 4.0,
            };
            // Three significant digits, as a user would type them, kept inside the range.
            let typed = |td: &TargetDef, x: f64| {
                let v: f64 = format!("{:.2e}", td.at(x)).parse().expect("{:.2e} re-parses");
                Quantity::new(v.clamp(td.min, td.max), td.unit).display
            };
            let targets = t.targets.iter().enumerate().map(|(d, (n, td))| (n.clone(), typed(td, frac(d)))).collect();
            let mut rails: BTreeMap<String, f64> = t.rails.iter().map(|(n, r)| (n.clone(), r.volts)).collect();
            for (i, name) in ranged_rails.iter().enumerate() {
                let (lo, hi) = t.rails[*name].range();
                let x = frac(t.targets.len() + i);
                // Rounded to 0.1 V, as a user would set a supply.
                rails.insert((*name).clone(), ((lo + x * (hi - lo)) * 10.0).round() / 10.0);
            }
            VerifyPoint { targets, rails }
        })
        .collect()
}

// ---------------------------------------------------------------- instantiation

/// Insert a block from a template (the editor's "insert block", the generator's fallback).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct InsertBlock {
    pub template: String,
    /// Target values as typed ("1k", "0.707"); a missing target takes the template default.
    #[serde(default)]
    pub targets: BTreeMap<String, String>,
    /// How each port is wired; a missing port takes its default (signals: a new net; power: the
    /// template's rail; ground: GND).
    #[serde(default)]
    pub ports: BTreeMap<String, PortBinding>,
    /// Block id; default the lowest free `bN`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<BlockId>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PortBinding {
    /// An existing net (for a power port: an existing rail, whose voltage the solver uses).
    Net(NetId),
    /// A new net named after the block and port (`B2_IN`).
    New,
    /// A supply rail at `volts`, created if it does not exist.
    Rail { net: NetId, volts: f64 },
}

/// What inserting would produce, before anything is applied: the insert form shows it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Preview {
    pub template: String,
    pub targets: BTreeMap<String, Quantity>,
    /// Supply volts per power port.
    pub rails: BTreeMap<String, f64>,
    /// Solved part values by the template's local refdes.
    pub values: BTreeMap<String, BTreeMap<String, Quantity>>,
    /// The block's spec: every check's target and tolerance.
    pub spec: BTreeMap<String, SpecTarget>,
    /// Each spec target formatted for reading (`1kHz`, `0.707`, `2.5V`).
    pub spec_display: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Inserted {
    pub block: BlockId,
    /// Apply as one batch (author `template`): one undo step.
    pub ops: Vec<Op>,
    /// Local refdes -> refdes in the circuit.
    pub refdes: BTreeMap<String, RefDes>,
    pub preview: Preview,
}

fn target_err(msg: String) -> OpError {
    OpError::new(E::TargetOutOfRange, msg)
}

fn template<'r>(reg: &'r Registry, id: &str) -> Result<&'r TemplateDef, OpError> {
    reg.templates.get(id).ok_or_else(|| OpError::new(E::TemplateNotFound, format!("no block template {id}")))
}

/// Parse targets, resolve each power port's voltage, and solve.
pub fn preview(c: &Circuit, reg: &Registry, req: &InsertBlock) -> Result<Preview, OpError> {
    let t = template(reg, &req.template)?;
    for name in req.targets.keys() {
        if !t.targets.contains_key(name) {
            return Err(target_err(format!("{} has no target {name}", t.id)));
        }
    }
    for name in req.ports.keys() {
        if !t.ports.contains_key(name) {
            return err(E::PortInvalid, format!("{} has no port {name}", t.id));
        }
    }
    let mut targets = BTreeMap::new();
    for (name, td) in &t.targets {
        let text = req.targets.get(name).unwrap_or(&td.default);
        let q = parse_quantity(text, td.unit).map_err(|e| target_err(format!("{}: {e}", td.label)))?;
        // A hair of slack so a range end typed in another notation still counts as inside.
        if q.si < td.min * (1.0 - 1e-9) || q.si > td.max * (1.0 + 1e-9) {
            let fmt = |x| Quantity::new(x, td.unit).display;
            return Err(target_err(format!("{} must be {} to {}", td.label, fmt(td.min), fmt(td.max))));
        }
        targets.insert(name.clone(), q);
    }
    let mut rails = BTreeMap::new();
    for (name, rd) in &t.rails {
        let (lo, hi) = rd.range();
        let volts = match req.ports.get(name) {
            // The template's rail, or the circuit's rail of that name when its voltage suits.
            None => match c.nets.get(&rd.net).map(|n| n.kind) {
                Some(NetKind::Power { volts }) if volts >= lo - 1e-9 && volts <= hi + 1e-9 => volts,
                Some(_) => {
                    return err(
                        E::PortInvalid,
                        format!("{name}: {} is not a supply between {lo} and {hi} V; bind another rail", rd.net),
                    );
                }
                None => rd.volts,
            },
            Some(PortBinding::Rail { volts, .. }) => *volts,
            Some(PortBinding::Net(id)) => match c.nets.get(id).map(|n| n.kind) {
                Some(NetKind::Power { volts }) => volts,
                _ => return err(E::PortInvalid, format!("{name} needs a supply rail; {id} is not one")),
            },
            Some(PortBinding::New) => {
                return err(E::PortInvalid, format!("{name} is a supply port: bind it to a rail"));
            }
        };
        if volts < lo - 1e-9 || volts > hi + 1e-9 {
            let range = if lo == hi { format!("{lo} V") } else { format!("{lo} to {hi} V") };
            return Err(target_err(format!("{name} must be {range}, not {volts} V")));
        }
        rails.insert(name.clone(), volts);
    }
    let si: BTreeMap<String, f64> = targets.iter().map(|(k, q)| (k.clone(), q.si)).collect();
    let solution = t.solve(&reg.parts, &si, &rails).map_err(|e| target_err(format!("{}: {e}", t.title)))?;
    let mut spec = BTreeMap::new();
    let mut spec_display = BTreeMap::new();
    for ch in &t.checks {
        let Some(target) = si.get(&ch.name).or_else(|| solution.spec.get(&ch.name)) else { continue };
        spec.insert(ch.name.clone(), SpecTarget { target: *target, tol_pct: ch.tol_pct });
        spec_display.insert(ch.name.clone(), crate::units::format_sig(*target, ch.kind.unit()));
    }
    Ok(Preview { template: t.id.clone(), targets, rails, values: solution.values, spec, spec_display })
}

/// The ops that insert the block: `block.begin`, its parts, its nets, the analyses its checks
/// need (merged into the circuit's), `block.commit`. They are trial-applied here, so they apply.
pub fn instantiate(c: &Circuit, reg: &Registry, req: &InsertBlock) -> Result<Inserted, OpError> {
    let t = template(reg, &req.template)?;
    let preview = preview(c, reg, req)?;
    let block = match &req.id {
        Some(id) => id.clone(),
        None => (1..=crate::ir::MAX_BLOCKS + c.blocks.len())
            .map(|n| format!("b{n}"))
            .find(|id| !c.blocks.contains_key(id))
            .expect("a free block id"),
    };
    let upper = block.to_ascii_uppercase();

    // Refdes: the lowest free numbers, in template order.
    let mut scratch = c.clone();
    let mut refdes = BTreeMap::new();
    for (local, tp) in &t.parts {
        let r = edit::next_refdes(&scratch, reg, &tp.part)?;
        scratch.parts.insert(
            r.clone(),
            PartInstance {
                refdes: r.clone(),
                part: tp.part.clone(),
                params: BTreeMap::new(),
                block: None,
                origin: Origin::User,
                pinned: None,
            },
        );
        refdes.insert(local.clone(), r);
    }

    // Net per template net: bound port nets, rails, ground, or new names.
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let fresh = |taken: &mut BTreeSet<String>, base: String| -> NetId {
        let mut id = base.clone();
        let mut n = 2;
        while net_conflict(c, &id, None).is_some() || taken.contains(&id.to_ascii_lowercase()) {
            id = format!("{base}_{n}");
            n += 1;
        }
        taken.insert(id.to_ascii_lowercase());
        id
    };
    let mut nets: IndexMap<&str, (NetId, Option<NetKind>)> = IndexMap::new();
    for (name, dir) in &t.ports {
        let binding = req.ports.get(name);
        let bound = match (dir, binding) {
            (PortDirection::Ground, None) => (GND.to_string(), Some(NetKind::Ground)),
            (PortDirection::Ground, Some(PortBinding::Net(id))) if id == GND => {
                (GND.to_string(), Some(NetKind::Ground))
            }
            (PortDirection::Ground, Some(_)) => {
                return err(E::PortInvalid, format!("{name} is a ground port: it binds to GND"));
            }
            (d, b) if TemplateDef::is_power(*d) => {
                let rail = &t.rails[name];
                let volts = preview.rails[name];
                let net = match b {
                    Some(PortBinding::Net(id)) | Some(PortBinding::Rail { net: id, .. }) => id.clone(),
                    _ => rail.net.clone(),
                };
                if let Some(existing) = c.nets.get(&net)
                    && existing.kind != (NetKind::Power { volts })
                {
                    return err(E::PortInvalid, format!("{name}: {net} exists and is not a {volts} V rail"));
                }
                if net == GND || !valid_net_id(&net) {
                    return err(E::PortInvalid, format!("{name}: \"{net}\" is not a valid rail name"));
                }
                taken.insert(net.to_ascii_lowercase());
                (net, Some(NetKind::Power { volts }))
            }
            (_, Some(PortBinding::Net(id))) => match c.nets.get(id) {
                Some(n) if n.kind == NetKind::Signal => (id.clone(), None),
                Some(_) => return err(E::PortInvalid, format!("{name} carries a signal; {id} is a supply or ground")),
                None => return err(E::PortInvalid, format!("{name}: no net {id}")),
            },
            (_, Some(PortBinding::Rail { .. })) => {
                return err(E::PortInvalid, format!("{name} carries a signal: bind it to a net, not a rail"));
            }
            (_, None | Some(PortBinding::New)) => {
                (fresh(&mut taken, format!("{upper}_{}", name.to_ascii_uppercase())), None)
            }
        };
        nets.insert(name, bound);
    }
    for name in t.nets.keys() {
        if !nets.contains_key(name.as_str()) {
            nets.insert(name, (fresh(&mut taken, format!("{upper}_{}", name.to_ascii_uppercase())), None));
        }
    }

    let mut ops = vec![Op::BlockBegin(BlockBegin {
        id: block.clone(),
        role: t.role,
        title: t.title.clone(),
        spec: preview.spec.clone(),
        ports: t
            .ports
            .iter()
            .map(|(name, dir)| BlockPort { name: name.clone(), direction: *dir, net: nets[name.as_str()].0.clone() })
            .collect(),
        template: Some(t.id.clone()),
    })];
    for (local, tp) in &t.parts {
        ops.push(Op::PartAdd(PartAdd {
            refdes: refdes[local].clone(),
            part: tp.part.clone(),
            params: preview.values[local].iter().map(|(k, q)| (k.clone(), q.display.clone())).collect(),
            block: Some(block.clone()),
            origin: None,
        }));
    }
    for (name, pins) in &t.nets {
        let (net, kind) = &nets[name.as_str()];
        ops.push(Op::NetConnect(NetConnect {
            net: net.clone(),
            pins: pins.iter().map(|p| PinRef::new(&refdes[&p.refdes], &p.pin)).collect(),
            kind: *kind,
            label: None,
        }));
    }
    let needs = t.checks.iter().filter_map(|ch| {
        let target = preview.spec.get(&ch.name)?.target;
        Some(checks::need(ch, target))
    });
    if let Some(analyses) = checks::merge_analyses(&c.analyses, needs) {
        ops.push(Op::AnalysisSet(crate::ops::AnalysisSet { analyses }));
    }
    ops.push(Op::BlockCommit(BlockRef { id: block.clone() }));

    apply_ops(c, reg, &ops, Author::Template, None)?;
    Ok(Inserted { block, ops, refdes, preview })
}
