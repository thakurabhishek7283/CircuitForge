//! Spec checks (LLD §7): the compiler turns each check of a template block into primitive ngspice
//! `.meas` cards on the block's port nets; [`evaluate_checks`] combines their results into
//! `{name, target, measured, tol_pct, pass}`. ngspice measures only single vectors (it rejects
//! `vdb(out)-vdb(in)`), so every ratio, product or difference is taken here, identically in the
//! browser and on the server.

use std::collections::BTreeMap;
use std::f64::consts::FRAC_PI_2;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{CheckDef, CheckKind, Edge, Pass};
use crate::Registry;
use crate::ir::{Analysis, BlockId, Circuit};
use crate::spice::{MeasDef, node_name};
use crate::units::{Unit, format_sig, spice_number};

/// AC sweeps added for spec checks resolve crossings to well under 1%.
pub const AC_POINTS_PER_DECADE: u32 = 50;
/// An oscillator check measures in the second half of 16 periods, so start-up (a 555 leaving a
/// poor operating point can take several periods) never counts.
pub const TRAN_PERIODS: f64 = 16.0;
pub const TRAN_STEPS_PER_PERIOD: f64 = 200.0;
/// The most transient steps a check (or the scope) asks for.
pub const MAX_TRAN_STEPS: f64 = 100_000.0;
pub const DEFAULT_GAIN_HZ: f64 = 1e3;

/// A check as compiled into one netlist: which `.meas` results it combines.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct SpecCheckDef {
    pub block: BlockId,
    pub name: String,
    pub label: String,
    pub symbol: String,
    pub kind: CheckKind,
    pub unit: Unit,
    pub target: f64,
    pub tol_pct: f64,
    /// `.meas` result names, in the order the kind combines them. Empty when `missing` is set.
    pub meas: Vec<String>,
    /// Why the check could not be compiled into this netlist ("needs an AC analysis").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing: Option<String>,
}

/// One check's outcome (LLD §7: `{name, target, measured, tol_pct, pass}`), with the numbers
/// already formatted by the core so no client formats units itself.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct CheckResult {
    pub block: BlockId,
    pub name: String,
    pub label: String,
    pub symbol: String,
    pub unit: Unit,
    pub target: f64,
    pub tol_pct: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured: Option<f64>,
    pub pass: bool,
    pub target_display: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured_display: Option<String>,
    /// Why there is no measurement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// `.meas` cards and check definitions for every template block of `c`, against the analyses
/// the deck runs (a check whose analysis is absent is listed with `missing`, not emitted).
pub fn emit(c: &Circuit, reg: &Registry, analyses: &[Analysis]) -> (Vec<MeasDef>, Vec<SpecCheckDef>) {
    let ac = analyses.iter().find_map(|a| match a {
        Analysis::Ac { f_start, f_stop, .. } => Some((*f_start, *f_stop)),
        _ => None,
    });
    let tran = analyses.iter().find_map(|a| match a {
        Analysis::Tran { t_stop, t_step } => Some((*t_stop, *t_step)),
        _ => None,
    });
    // A signal to measure a response to: a periodic source (one with a frequency), as for the
    // editor's default transient.
    let signal = c.parts.values().any(|p| {
        reg.part(&p.part).is_some_and(|d| d.category == crate::registry::Category::V)
            && p.params.values().any(|q| q.unit == Unit::Hertz && q.si > 0.0)
    });
    let mut cards = Vec::new();
    let mut defs = Vec::new();
    for block in c.blocks.values() {
        let Some(t) = block.template.as_ref().and_then(|id| reg.templates.get(id)) else { continue };
        for ch in &t.checks {
            let Some(spec) = block.spec.get(&ch.name) else { continue };
            let mut def = SpecCheckDef {
                block: block.id.clone(),
                name: ch.name.clone(),
                label: ch.label.clone(),
                symbol: ch.symbol.clone(),
                kind: ch.kind,
                unit: ch.kind.unit(),
                target: spec.target,
                tol_pct: spec.tol_pct,
                meas: Vec::new(),
                missing: None,
            };
            let node = |port: &str| {
                block
                    .ports
                    .iter()
                    .find(|p| p.name == port)
                    .filter(|p| c.nets.contains_key(&p.net))
                    .map(|p| node_name(&p.net))
                    .ok_or_else(|| format!("port {port} is not connected"))
            };
            let nodes = node(&ch.out).and_then(|o| Ok((o, ch.input.as_deref().map(node).transpose()?)));
            let lines = match nodes {
                Err(why) => Err(why),
                Ok(_) if ch.kind.needs_signal() && !signal => {
                    Err("needs a signal: connect a sine source to the block's input".to_string())
                }
                Ok(_) if ch.kind.is_ac() && ac.is_none() => Err("needs an AC analysis".to_string()),
                Ok(_) if !ch.kind.is_ac() && tran.is_none() => Err("needs a transient analysis".to_string()),
                Ok(_) if ch.tran.zip(tran).is_some_and(|(w, (_, step))| step > w.step * (1.0 + 1e-9)) => {
                    let w = ch.tran.expect("checked");
                    Err(format!("needs transient steps of at most {}", format_sig(w.step, Unit::Second)))
                }
                Ok((out, inp)) => {
                    let sweep = ac.unwrap_or((0.0, f64::MAX));
                    Ok(cards_for(ch, spec.target, &out, inp.as_deref(), sweep, tran.map_or(0.0, |t| t.0)))
                }
            };
            match lines {
                Err(why) => def.missing = Some(why),
                Ok(lines) => {
                    let prefix = format!("{}_{}", block.id, ch.name).to_ascii_lowercase();
                    let analysis = if ch.kind.is_ac() { "ac" } else { "tran" };
                    for (suffix, body) in lines {
                        let name = format!("{prefix}_{suffix}");
                        let body = body.replace("{p}", &prefix);
                        cards.push(MeasDef { line: format!(".meas {analysis} {name} {body}"), name: name.clone() });
                        def.meas.push(name);
                    }
                }
            }
            defs.push(def);
        }
    }
    (cards, defs)
}

/// `(suffix, card body)` per primitive measurement; `{p}` in a body is the check's name prefix.
fn cards_for(
    ch: &CheckDef,
    target: f64,
    out: &str,
    inp: Option<&str>,
    (f_start, f_stop): (f64, f64),
    t_stop: f64,
) -> Vec<(&'static str, String)> {
    let n = spice_number;
    let mid = "({p}_hi+{p}_lo)/2";
    let range = || vec![("hi", format!("max v({out})")), ("lo", format!("min v({out})"))];
    let inp = inp.unwrap_or("0");
    // A pass-band reference a decade from the corner, kept inside the sweep.
    let reference = |pass: Option<Pass>| match pass {
        Some(Pass::High) => (target * 10.0).min(f_stop),
        _ => (target / 10.0).max(f_start),
    };
    match ch.kind {
        CheckKind::AcCorner => {
            let crossing = if ch.pass == Some(Pass::High) { "rise=1" } else { "fall=1" };
            vec![
                ("ref", format!("find vdb({out}) at={}", n(reference(ch.pass)))),
                ("x", format!("when vdb({out})={{p}}_ref-3 {crossing}")),
            ]
        }
        CheckKind::AcQ => {
            // Phase falls through ∓90° at f0; there |H| = Q times the pass-band gain, read a
            // decade from f0 (the target here is Q, not a frequency).
            let (phase, reference) =
                if ch.pass == Some(Pass::High) { (FRAC_PI_2, "{p}_f0*10") } else { (-FRAC_PI_2, "{p}_f0/10") };
            vec![
                ("f0", format!("when vp({out})={} fall=1", n(phase))),
                ("ref", format!("find vdb({out}) at={reference}")),
                ("g0", format!("find vdb({out}) at={{p}}_f0")),
            ]
        }
        CheckKind::AcGain => {
            let at = n(ch.at_hz.unwrap_or(DEFAULT_GAIN_HZ));
            vec![("o", format!("find vdb({out}) at={at}")), ("i", format!("find vdb({inp}) at={at}"))]
        }
        CheckKind::AcCenter | CheckKind::AcBandQ => vec![
            ("pk", format!("max vdb({out})")),
            ("lo", format!("when vdb({out})={{p}}_pk-3 rise=1")),
            ("hi", format!("when vdb({out})={{p}}_pk-3 fall=1")),
        ],
        CheckKind::TranFreq | CheckKind::TranDuty => {
            // The second half of the run only: start-up (a 555's long first cycle, a circuit
            // leaving its operating point) can add stray crossings.
            let td = n(t_stop / 2.0);
            let mut v = vec![("hi", format!("max v({out}) from={td}")), ("lo", format!("min v({out}) from={td}"))];
            v.push(("a", format!("when v({out})={mid} rise=1 td={td}")));
            v.push(("b", format!("when v({out})={mid} rise=3 td={td}")));
            if ch.kind == CheckKind::TranDuty {
                v.push(("av", format!("avg v({out}) from={{p}}_a to={{p}}_b")));
            }
            v
        }
        CheckKind::TranAmplitude => range(),
        CheckKind::DcLevel => vec![("av", format!("avg v({out})"))],
        CheckKind::TranThreshold => {
            let edge = if ch.edge == Some(Edge::Fall) { "fall=2" } else { "rise=2" };
            let mut v = range();
            v.push(("x", format!("find v({inp}) when v({out})={mid} {edge}")));
            v
        }
    }
}

/// The measured value of one check from its `.meas` results.
fn combine(kind: CheckKind, v: &[f64]) -> Option<f64> {
    let x = match (kind, v) {
        (CheckKind::AcCorner, [_, x]) => *x,
        (CheckKind::AcQ, [_, r, g0]) => 10f64.powf((g0 - r) / 20.0),
        (CheckKind::AcGain, [o, i]) => 10f64.powf((o - i) / 20.0),
        (CheckKind::AcCenter, [_, lo, hi]) => (lo * hi).sqrt(),
        (CheckKind::AcBandQ, [_, lo, hi]) if hi > lo => (lo * hi).sqrt() / (hi - lo),
        (CheckKind::TranFreq, [_, _, a, b]) if b > a => 2.0 / (b - a),
        (CheckKind::TranDuty, [hi, lo, _, _, av]) if hi > lo => (av - lo) / (hi - lo),
        (CheckKind::TranAmplitude, [hi, lo]) => (hi - lo) / 2.0,
        (CheckKind::DcLevel, [av]) => *av,
        (CheckKind::TranThreshold, [_, _, x]) => *x,
        _ => return None,
    };
    x.is_finite().then_some(x)
}

/// What a learner reads when ngspice found nothing to measure.
fn unmeasured(kind: CheckKind) -> &'static str {
    match kind {
        CheckKind::AcCorner => "no −3 dB point in the AC sweep",
        CheckKind::AcQ => "no ±90° phase point in the AC sweep",
        CheckKind::AcGain => "the gain frequency is outside the AC sweep",
        CheckKind::AcCenter | CheckKind::AcBandQ => "no pass band with −3 dB edges in the AC sweep",
        CheckKind::TranFreq | CheckKind::TranDuty => "the output does not oscillate (yet)",
        CheckKind::TranAmplitude | CheckKind::DcLevel => "the output was not simulated",
        CheckKind::TranThreshold => "the output never switched: is the input swinging past the threshold?",
    }
}

/// Combine `.meas` results (`SimResult.meas`, a failed measurement is absent) into check results.
pub fn evaluate_checks(defs: &[SpecCheckDef], meas: &BTreeMap<String, f64>) -> Vec<CheckResult> {
    defs.iter()
        .map(|d| {
            let values: Option<Vec<f64>> = d.meas.iter().map(|m| meas.get(m).copied()).collect();
            let measured = match (&d.missing, values) {
                (None, Some(v)) => combine(d.kind, &v),
                _ => None,
            };
            let pass =
                measured.is_some_and(|m| (m - d.target).abs() <= d.tol_pct / 100.0 * d.target.abs() * (1.0 + 1e-9));
            CheckResult {
                block: d.block.clone(),
                name: d.name.clone(),
                label: d.label.clone(),
                symbol: d.symbol.clone(),
                unit: d.unit,
                target: d.target,
                tol_pct: d.tol_pct,
                measured,
                pass,
                target_display: format_sig(d.target, d.unit),
                measured_display: measured.map(|m| format_sig(m, d.unit)),
                note: match measured {
                    Some(_) => None,
                    None => Some(d.missing.clone().unwrap_or_else(|| unmeasured(d.kind).to_string())),
                },
            }
        })
        .collect()
}

/// What a check needs simulated.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Need {
    Ac { lo: f64, hi: f64 },
    Tran { t_stop: f64, t_step: f64 },
    Nothing,
}

pub fn need(ch: &CheckDef, target: f64) -> Need {
    if let Some(w) = ch.tran {
        return Need::Tran { t_stop: w.stop, t_step: w.step };
    }
    match ch.kind {
        CheckKind::AcCorner | CheckKind::AcCenter => Need::Ac { lo: target / 100.0, hi: target * 100.0 },
        CheckKind::AcGain => {
            let at = ch.at_hz.unwrap_or(DEFAULT_GAIN_HZ);
            Need::Ac { lo: at / 10.0, hi: at * 10.0 }
        }
        CheckKind::TranFreq => {
            Need::Tran { t_stop: TRAN_PERIODS / target, t_step: 1.0 / (TRAN_STEPS_PER_PERIOD * target) }
        }
        // Q and duty ride on their block's frequency checks (their targets are not frequencies);
        // levels and thresholds use the editor's default transient (five periods of the slowest
        // source).
        CheckKind::AcQ
        | CheckKind::AcBandQ
        | CheckKind::TranDuty
        | CheckKind::TranAmplitude
        | CheckKind::DcLevel
        | CheckKind::TranThreshold => Need::Nothing,
    }
}

fn decade(x: f64, up: bool) -> f64 {
    let e = if up { x.log10().ceil() } else { x.log10().floor() };
    format!("1e{}", e as i32).parse().expect("decade parses")
}

/// The circuit's analyses widened to cover `needs`: one AC sweep spanning every requested band
/// (whole decades, at least [`AC_POINTS_PER_DECADE`]), one transient long and fine enough for
/// every oscillator (at most [`MAX_TRAN_STEPS`]). `None` when nothing has to change.
pub fn merge_analyses(existing: &[Analysis], needs: impl IntoIterator<Item = Need>) -> Option<Vec<Analysis>> {
    let (mut lo, mut hi, mut t_stop, mut t_step) = (f64::INFINITY, 0.0f64, 0.0f64, f64::INFINITY);
    for n in needs {
        match n {
            Need::Ac { lo: a, hi: b } => (lo, hi) = (lo.min(a), hi.max(b)),
            Need::Tran { t_stop: s, t_step: d } => (t_stop, t_step) = (t_stop.max(s), t_step.min(d)),
            Need::Nothing => {}
        }
    }
    let mut out = existing.to_vec();
    if hi > 0.0 {
        let (lo, hi) = (decade(lo, false).max(0.1), decade(hi, true).min(1e9));
        match out.iter_mut().find(|a| matches!(a, Analysis::Ac { .. })) {
            Some(Analysis::Ac { points_per_decade, f_start, f_stop }) => {
                *points_per_decade = (*points_per_decade).max(AC_POINTS_PER_DECADE);
                *f_start = f_start.min(lo);
                *f_stop = f_stop.max(hi);
            }
            _ => out.push(Analysis::Ac { points_per_decade: AC_POINTS_PER_DECADE, f_start: lo, f_stop: hi }),
        }
    }
    if t_stop > 0.0 {
        let (stop, step) = match out.iter().find_map(|a| match a {
            Analysis::Tran { t_step, t_stop } => Some((*t_stop, *t_step)),
            _ => None,
        }) {
            Some((s, d)) => (s.max(t_stop), d.min(t_step)),
            None => (t_stop, t_step),
        };
        let step = step.max(stop / MAX_TRAN_STEPS);
        match out.iter_mut().find(|a| matches!(a, Analysis::Tran { .. })) {
            Some(a) => *a = Analysis::Tran { t_step: step, t_stop: stop },
            None => out.push(Analysis::Tran { t_step: step, t_stop: stop }),
        }
    }
    (out != existing).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(kind: CheckKind, target: f64, meas: &[&str]) -> SpecCheckDef {
        SpecCheckDef {
            block: "b1".into(),
            name: "x".into(),
            label: "X".into(),
            symbol: "x".into(),
            kind,
            unit: kind.unit(),
            target,
            tol_pct: 10.0,
            meas: meas.iter().map(|s| s.to_string()).collect(),
            missing: None,
        }
    }

    #[test]
    fn combines_primitive_measurements() {
        let m: BTreeMap<String, f64> =
            [("r", -0.01), ("f0", 980.0), ("g0", -3.39), ("o", 20.0), ("i", 0.0), ("a", 1e-3), ("b", 3e-3)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
        let q = &evaluate_checks(&[def(CheckKind::AcQ, 0.707, &["f0", "r", "g0"])], &m)[0];
        assert!((q.measured.unwrap() - 0.6773).abs() < 1e-3 && q.pass, "{q:?}");
        assert_eq!(q.measured_display.as_deref(), Some("0.678"));
        let g = &evaluate_checks(&[def(CheckKind::AcGain, 10.0, &["o", "i"])], &m)[0];
        assert!((g.measured.unwrap() - 10.0).abs() < 1e-9 && g.pass);
        let f = &evaluate_checks(&[def(CheckKind::TranFreq, 1500.0, &["r", "r", "a", "b"])], &m)[0];
        assert_eq!(f.measured, Some(1000.0));
        assert!(!f.pass);
        assert_eq!((f.target_display.as_str(), f.measured_display.as_deref()), ("1.5kHz", Some("1kHz")));

        let absent = &evaluate_checks(&[def(CheckKind::AcCorner, 1e3, &["r", "nope"])], &m)[0];
        assert_eq!((absent.measured, absent.pass), (None, false));
        assert_eq!(absent.note.as_deref(), Some("no −3 dB point in the AC sweep"));
        let mut missing = def(CheckKind::AcCorner, 1e3, &[]);
        missing.missing = Some("needs an AC analysis".into());
        assert_eq!(evaluate_checks(&[missing], &m)[0].note.as_deref(), Some("needs an AC analysis"));
    }

    #[test]
    fn merges_analyses() {
        let ac = |lo, hi| Need::Ac { lo, hi };
        assert_eq!(
            merge_analyses(&[Analysis::Op], [ac(10.0, 1e5), ac(3.0, 2e4)]),
            Some(vec![Analysis::Op, Analysis::Ac { points_per_decade: 50, f_start: 1.0, f_stop: 1e5 }])
        );
        let have = [Analysis::Ac { points_per_decade: 100, f_start: 1.0, f_stop: 1e6 }];
        assert_eq!(merge_analyses(&have, [ac(10.0, 1e5)]), None, "already covered");
        assert_eq!(merge_analyses(&have, [Need::Nothing]), None);
        let tran = merge_analyses(&[], [Need::Tran { t_stop: 8.0, t_step: 1e-6 }]).unwrap();
        assert_eq!(tran, [Analysis::Tran { t_step: 8e-5, t_stop: 8.0 }], "capped at 100,000 steps");
        let both = [Analysis::Tran { t_step: 1e-5, t_stop: 1e-2 }];
        assert_eq!(
            merge_analyses(&both, [Need::Tran { t_stop: 8e-3, t_step: 5e-6 }]),
            Some(vec![Analysis::Tran { t_step: 5e-6, t_stop: 1e-2 }])
        );
    }
}
