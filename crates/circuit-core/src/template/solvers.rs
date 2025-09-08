//! Value solvers (LLD §12): targets and supply volts in, E-series part values out.
//!
//! They live in circuit-core rather than in the API, so the browser instantiates templates
//! offline from the static bundle and the server gets byte-identical ops. Rounding each value
//! to its series separately can stack two ±5% errors; instead each solver searches the series
//! (E12 capacitors × E24 resistors) for the combination closest to the targets.
//!
//! Scores use only `+ − × ÷ √` (exact in IEEE 754 on every runtime) where they can, and
//! [`best`] keeps the first of two candidates whose scores differ by under 1e-9, so a last-bit
//! difference between libm builds cannot change which part values a template gets.

use std::collections::BTreeMap;
use std::f64::consts::{LN_2, PI};

use crate::units::ESeries::{E12, E24};

pub struct Input<'a> {
    pub targets: &'a BTreeMap<String, f64>,
    /// Supply volts by power port name.
    pub rails: &'a BTreeMap<String, f64>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Output {
    /// Local refdes -> param -> SI value.
    pub values: BTreeMap<String, BTreeMap<String, f64>>,
    /// Spec targets the solver derives (a follower's gain of 1, a regulator's 5 V).
    pub spec: BTreeMap<String, f64>,
}

impl Output {
    fn set(mut self, local: &str, key: &str, v: f64) -> Output {
        self.values.entry(local.to_string()).or_default().insert(key.to_string(), v);
        self
    }
    fn r(self, local: &str, ohms: f64) -> Output {
        self.set(local, "resistance", ohms)
    }
    fn c(self, local: &str, farads: f64) -> Output {
        self.set(local, "capacitance", farads)
    }
    fn spec(mut self, name: &str, v: f64) -> Output {
        self.spec.insert(name.to_string(), v);
        self
    }
}

pub type Solver = fn(&Input) -> Result<Output, String>;

pub const NAMES: [&str; 19] = [
    "rc_first_order",
    "sallen_key_lp",
    "sallen_key_hp",
    "mfb_bandpass",
    "inverting_amp",
    "noninverting_amp",
    "difference_amp",
    "ce_amp",
    "voltage_follower",
    "emitter_follower",
    "astable_555",
    "square_555",
    "led_flasher",
    "reg_7805",
    "zener_regulator",
    "comparator",
    "schmitt_trigger",
    "divider_bias",
    "sine_source",
];

pub fn solver(name: &str) -> Option<Solver> {
    Some(match name {
        "rc_first_order" => rc_first_order,
        "sallen_key_lp" => sallen_key_lp,
        "sallen_key_hp" => sallen_key_hp,
        "mfb_bandpass" => mfb_bandpass,
        "inverting_amp" => inverting_amp,
        "noninverting_amp" => noninverting_amp,
        "difference_amp" => difference_amp,
        "ce_amp" => ce_amp,
        "voltage_follower" => voltage_follower,
        "emitter_follower" => emitter_follower,
        "astable_555" => astable_555,
        "square_555" => square_555,
        "led_flasher" => led_flasher,
        "reg_7805" => reg_7805,
        "zener_regulator" => zener_regulator,
        "comparator" => comparator,
        "schmitt_trigger" => schmitt_trigger,
        "divider_bias" => divider_bias,
        "sine_source" => sine_source,
        _ => return None,
    })
}

// ---------------------------------------------------------------- helpers

fn target(i: &Input, name: &str) -> Result<f64, String> {
    i.targets.get(name).copied().ok_or_else(|| format!("missing target {name}"))
}

fn rail(i: &Input, name: &str) -> Result<f64, String> {
    i.rails.get(name).copied().ok_or_else(|| format!("missing rail {name}"))
}

/// The lowest-scoring candidate; a later one must beat it by more than 1e-9 to replace it.
fn best<T>(cands: impl IntoIterator<Item = (f64, T)>) -> Option<T> {
    let mut out: Option<(f64, T)> = None;
    for (score, c) in cands {
        if !score.is_finite() {
            continue;
        }
        if out.as_ref().is_none_or(|(s, _)| score < s - 1e-9) {
            out = Some((score, c));
        }
    }
    out.map(|(_, c)| c)
}

fn none_found(what: &str) -> String {
    format!("no {what} in the part series meets the targets")
}

/// Relative error, squared.
fn e2(actual: f64, wanted: f64) -> f64 {
    let e = actual / wanted - 1.0;
    e * e
}

/// A tie-breaker that prefers values near `nominal` (zero there, growing either way).
fn near(x: f64, nominal: f64) -> f64 {
    1e-6 * (x / nominal + nominal / x - 2.0)
}

/// Nearest E24 resistor, if it lies in `[lo, hi]`.
fn r24(x: f64, lo: f64, hi: f64) -> Option<f64> {
    let r = E24.nearest(x);
    (r >= lo && r <= hi).then_some(r)
}

/// −3 dB frequency of a 2nd-order low-pass relative to its natural frequency (a high-pass: the
/// inverse). Solves |H|² = ½: u² − (2 − 1/Q²)u − 1 = 0 for u = (f/f0)².
fn corner_ratio(q: f64) -> f64 {
    let b = 2.0 - 1.0 / (q * q);
    ((b + (b * b + 4.0).sqrt()) / 2.0).sqrt()
}

const CAPS: (f64, f64) = (100e-12, 10e-6);

// ---------------------------------------------------------------- filters

/// RC low- or high-pass: fc = 1/(2πRC).
fn rc_first_order(i: &Input) -> Result<Output, String> {
    let fc = target(i, "fc_hz")?;
    let tau = 1.0 / (2.0 * PI * fc);
    let (r, c) = best(E12.values(CAPS.0, CAPS.1).into_iter().filter_map(|c| {
        let r = r24(tau / c, 1e3, 100e3)?;
        Some((e2(r * c, tau) + near(r, 10e3), (r, c)))
    }))
    .ok_or_else(|| none_found("R and C"))?;
    Ok(Output::default().r("R1", r).c("C1", c))
}

/// Unity-gain Sallen-Key low-pass: R1, R2 in series to the + input, C1 from their junction to the
/// output, C2 from the + input to ground. ω0 = 1/√(R1R2C1C2), Q = √(R1R2C1C2)/(C2(R1+R2)).
/// `fc_hz` is the −3 dB frequency.
fn sallen_key_lp(i: &Input) -> Result<Output, String> {
    let (fc, q) = (target(i, "fc_hz")?, target(i, "q")?);
    let w0 = 2.0 * PI * fc / corner_ratio(q);
    let mut cands = Vec::new();
    for c2 in E12.values(100e-12, 1e-6) {
        let ratio = 4.0 * q * q; // C1/C2 for equal resistors
        for c1 in E12.values(c2 * ratio / 1.5, (c2 * ratio * 1.5).min(CAPS.1)) {
            let r = 1.0 / (w0 * (c1 * c2).sqrt());
            for r1 in E24.values(r / 1.3, r * 1.3).into_iter().filter(|r| (1e3..=330e3).contains(r)) {
                let Some(r2) = r24(1.0 / (w0 * w0 * r1 * c1 * c2), 1e3, 330e3) else { continue };
                let rc = (r1 * r2 * c1 * c2).sqrt();
                let (f0a, qa) = (1.0 / (2.0 * PI * rc), rc / (c2 * (r1 + r2)));
                let score = e2(f0a * corner_ratio(qa), fc) + e2(qa, q) + near(r1, 10e3) + near(r2, 10e3);
                cands.push((score, (r1, r2, c1, c2)));
            }
        }
    }
    let (r1, r2, c1, c2) = best(cands).ok_or_else(|| none_found("R/C set"))?;
    Ok(Output::default().r("R1", r1).r("R2", r2).c("C1", c1).c("C2", c2))
}

/// Unity-gain Sallen-Key high-pass: C1, C2 (equal) in series to the + input, R1 from their
/// junction to the output, R2 from the + input to ground. ω0 = 1/(C√(R1R2)), Q = ½√(R2/R1).
fn sallen_key_hp(i: &Input) -> Result<Output, String> {
    let (fc, q) = (target(i, "fc_hz")?, target(i, "q")?);
    let w0 = 2.0 * PI * fc * corner_ratio(q);
    let mut cands = Vec::new();
    for c in E12.values(100e-12, 1e-6) {
        let r = 1.0 / (2.0 * q * w0 * c);
        for r1 in E24.values(r / 1.3, r * 1.3).into_iter().filter(|r| (1e3..=330e3).contains(r)) {
            let Some(r2) = r24(1.0 / (w0 * w0 * r1 * c * c), 1e3, 1e6) else { continue };
            let rc = (r1 * r2).sqrt() * c;
            let (f0a, qa) = (1.0 / (2.0 * PI * rc), 0.5 * (r2 / r1).sqrt());
            let score = e2(f0a / corner_ratio(qa), fc) + e2(qa, q) + near(r1, 10e3);
            cands.push((score, (r1, r2, c)));
        }
    }
    let (r1, r2, c) = best(cands).ok_or_else(|| none_found("R/C set"))?;
    Ok(Output::default().r("R1", r1).r("R2", r2).c("C1", c).c("C2", c))
}

/// Multiple-feedback band-pass, equal capacitors, unity gain at f0: R1 in, R2 to ground, R3
/// feedback. f0 = √((R1+R2)/(R1R2R3)) / (2πC), Q = ½√(R3(R1+R2)/(R1R2)), gain −R3/(2R1).
fn mfb_bandpass(i: &Input) -> Result<Output, String> {
    let (f0, q) = (target(i, "f0_hz")?, target(i, "q")?);
    let w0 = 2.0 * PI * f0;
    let mut cands = Vec::new();
    for c in E12.values(1e-9, 1e-6) {
        let r = q / (w0 * c);
        for r1 in E24.values(r / 1.3, r * 1.3).into_iter().filter(|r| (1e3..=330e3).contains(r)) {
            let Some(r2) = r24(r1 / (2.0 * q * q - 1.0), 100.0, 330e3) else { continue };
            let Some(r3) = r24((r1 + r2) / (r1 * r2 * w0 * w0 * c * c), 1e3, 1e6) else { continue };
            let g = (r1 + r2) / (r1 * r2 * r3);
            let (f0a, qa) = (g.sqrt() / (2.0 * PI * c), 0.5 * (r3 * (r1 + r2) / (r1 * r2)).sqrt());
            cands.push((e2(f0a, f0) + e2(qa, q) + near(r1, 10e3), (r1, r2, r3, c)));
        }
    }
    let (r1, r2, r3, c) = best(cands).ok_or_else(|| none_found("R/C set"))?;
    Ok(Output::default().r("R1", r1).r("R2", r2).r("R3", r3).c("C1", c).c("C2", c))
}

// ---------------------------------------------------------------- amplifiers and buffers

/// A resistor pair with `ratio` = b/a, a in `[1k, 100k]`, preferring a near 10k.
fn ratio_pair(ratio: f64, b_range: (f64, f64)) -> Result<(f64, f64), String> {
    best(E24.values(1e3, 100e3).into_iter().filter_map(|a| {
        let b = r24(a * ratio, b_range.0, b_range.1)?;
        Some((e2(b / a, ratio) + near(a, 10e3), (a, b)))
    }))
    .ok_or_else(|| none_found("resistor pair"))
}

/// Gain −R2/R1 (R1 from the input, R2 feedback); `gain` is the magnitude.
fn inverting_amp(i: &Input) -> Result<Output, String> {
    let (r1, r2) = ratio_pair(target(i, "gain")?, (1e3, 1e6))?;
    Ok(Output::default().r("R1", r1).r("R2", r2))
}

/// Gain 1 + R2/R1 (R1 to ground, R2 feedback).
fn noninverting_amp(i: &Input) -> Result<Output, String> {
    let (r1, r2) = ratio_pair(target(i, "gain")? - 1.0, (100.0, 1e6))?;
    Ok(Output::default().r("R1", r1).r("R2", r2))
}

/// Gain R2/R1 = R4/R3 on V(in_p) − V(in_n).
fn difference_amp(i: &Input) -> Result<Output, String> {
    let (r1, r2) = ratio_pair(target(i, "gain")?, (1e3, 1e6))?;
    Ok(Output::default().r("R1", r1).r("R2", r2).r("R3", r1).r("R4", r2))
}

const VBE: f64 = 0.65;
const VT: f64 = 0.026;
const BETA: f64 = 150.0;

/// Divider (R1 from the supply, R2 to ground) holding a base at `vb` with `i_div` flowing, the
/// top resistor also feeding the base current.
fn base_divider(vcc: f64, vb: f64, i_div: f64, i_b: f64) -> Result<(f64, f64), String> {
    let r2 = r24(vb / i_div, 100.0, 1e6).ok_or_else(|| none_found("bias divider"))?;
    let r1 = r24((vcc - vb) / (i_div + i_b), 100.0, 1e6).ok_or_else(|| none_found("bias divider"))?;
    Ok((r1, r2))
}

/// Common-emitter stage, divider bias, unbypassed emitter resistor: |gain| ≈ RC/(RE + re) with
/// IC ≈ 1 mA and the collector at half the supply. C1/C2 couple in and out.
fn ce_amp(i: &Input) -> Result<Output, String> {
    let (g, vcc) = (target(i, "gain")?, rail(i, "vcc")?);
    let ic = 1e-3;
    let re_int = VT / ic;
    let rc0 = vcc / 2.0 / ic;
    let (rc, re) = best(E24.values(rc0 / 1.25, rc0 * 1.25).into_iter().filter_map(|rc| {
        let re = r24(rc / g - re_int, 10.0, 100e3)?;
        Some((e2(rc / (re + re_int), g) + near(rc, rc0), (rc, re)))
    }))
    .ok_or_else(|| none_found("RC/RE pair"))?;
    let (r1, r2) = base_divider(vcc, ic * re + VBE, ic / 10.0, ic / BETA)?;
    Ok(Output::default().r("R1", r1).r("R2", r2).r("R3", rc).r("R4", re).c("C1", 10e-6).c("C2", 10e-6))
}

fn voltage_follower(_: &Input) -> Result<Output, String> {
    Ok(Output::default().spec("gain", 1.0))
}

/// Emitter follower biased at half the supply, IE ≈ 2 mA: gain RE/(RE + re), just under 1.
fn emitter_follower(i: &Input) -> Result<Output, String> {
    let vcc = rail(i, "vcc")?;
    let ie = 2e-3;
    let re = r24(vcc / 2.0 / ie, 100.0, 100e3).ok_or_else(|| none_found("emitter resistor"))?;
    let (r1, r2) = base_divider(vcc, vcc / 2.0 + VBE, ie / 5.0, ie / BETA)?;
    let gain = re / (re + VT / ie);
    Ok(Output::default().r("R1", r1).r("R2", r2).r("R3", re).c("C1", 10e-6).c("C2", 10e-6).spec("gain", gain))
}

// ---------------------------------------------------------------- oscillators

/// 555 astable timing (RA, RB, C): high for ln2·(RA+RB)·C, low for ln2·RB·C (duty above ½).
fn astable(f: f64, d: f64) -> Result<(f64, f64, f64), String> {
    best(E12.values(1e-9, CAPS.1).into_iter().filter_map(|c| {
        let s = 1.0 / (f * c * LN_2); // RA + 2RB
        let ra = r24(s * (2.0 * d - 1.0), 1e3, 1e6)?;
        let rb = r24(s * (1.0 - d), 1e3, 1e6)?;
        let (fa, da) = (1.0 / (LN_2 * (ra + 2.0 * rb) * c), (ra + rb) / (ra + 2.0 * rb));
        Some((e2(fa, f) + e2(da, d) + near(ra + rb, 50e3), (ra, rb, c)))
    }))
    .ok_or_else(|| none_found("RA/RB/C set"))
}

fn astable_555(i: &Input) -> Result<Output, String> {
    let (ra, rb, c) = astable(target(i, "freq_hz")?, target(i, "duty")?)?;
    Ok(Output::default().r("R1", ra).r("R2", rb).c("C1", c).c("C2", 10e-9))
}

const LED_DUTY: f64 = 0.6;
const LED_VF: f64 = 1.9;
const LED_MA: f64 = 10e-3;
/// A 555's output sits about 1.7 V below its supply when high.
const NE555_DROP: f64 = 1.7;

/// A 555 astable blinking an LED (on 60% of the time) through R3, set for about 10 mA.
fn led_flasher(i: &Input) -> Result<Output, String> {
    let (f, v) = (target(i, "freq_hz")?, rail(i, "vcc")?);
    let (ra, rb, c) = astable(f, LED_DUTY)?;
    let rl = r24((v - NE555_DROP - LED_VF) / LED_MA, 47.0, 10e3).ok_or_else(|| none_found("LED resistor"))?;
    let duty = (ra + rb) / (ra + 2.0 * rb);
    Ok(Output::default().r("R1", ra).r("R2", rb).r("R3", rl).c("C1", c).c("C2", 10e-9).spec("duty", duty))
}

/// 555 timed from its own output through R1: C1 charges toward the high output level (about
/// 1.7 V under the supply) from 1/3 to 2/3 Vcc, then discharges toward 0 V. Needs Vcc >= 9 V so
/// the high level clears 2/3 Vcc. High: RC·ln((Voh − V/3)/(Voh − 2V/3)); low: RC·ln2.
fn square_555(i: &Input) -> Result<Output, String> {
    let (f, v) = (target(i, "freq_hz")?, rail(i, "vcc")?);
    let voh = v - NE555_DROP;
    let k_hi = ((voh - v / 3.0) / (voh - 2.0 * v / 3.0)).ln();
    let rc = 1.0 / (f * (k_hi + LN_2));
    let (r, c) = best(E12.values(1e-9, CAPS.1).into_iter().filter_map(|c| {
        let r = r24(rc / c, 1e3, 1e6)?;
        Some((e2(r * c, rc) + near(r, 47e3), (r, c)))
    }))
    .ok_or_else(|| none_found("R and C"))?;
    Ok(Output::default().r("R1", r).c("C1", c).c("C2", 10e-9).spec("duty", k_hi / (k_hi + LN_2)))
}

/// LM358 high and low output levels into a light load.
fn lm358_levels(vcc: f64) -> (f64, f64) {
    (vcc - 1.5, 0.05)
}

// ---------------------------------------------------------------- supplies, comparators, bias

fn reg_7805(_: &Input) -> Result<Output, String> {
    Ok(Output::default().c("C1", 330e-9).c("C2", 100e-9).spec("vout_v", 5.0))
}

const VZ: f64 = 5.1;
const IZ_MIN: f64 = 5e-3;

/// Zener shunt regulator: the series resistor passes the largest load current plus 5 mA of
/// zener current at the supply voltage it is bound to.
fn zener_regulator(i: &Input) -> Result<Output, String> {
    let (il, vin) = (target(i, "i_load_max")?, rail(i, "vin")?);
    let r = r24((vin - VZ) / (il + IZ_MIN), 10.0, 100e3).ok_or_else(|| none_found("series resistor"))?;
    Ok(Output::default().r("R1", r).spec("vout_v", VZ))
}

/// A divider ratio b/(a+b) from E24 pairs, b in `[1k, b_max]`.
fn divider(ratio: f64, b_max: f64) -> Result<(f64, f64), String> {
    best(E24.values(1e3, b_max).into_iter().filter_map(|b| {
        let a = r24(b * (1.0 - ratio) / ratio, 100.0, 1e6)?;
        Some((e2(b / (a + b), ratio) + near(a + b, 2.0 * b_max), (a, b)))
    }))
    .ok_or_else(|| none_found("divider"))
}

/// Comparator: input on +, a divider (R1 from the supply, R2 to ground) sets the threshold on −.
fn comparator(i: &Input) -> Result<Output, String> {
    let (vth, v) = (target(i, "vth_v")?, rail(i, "vcc")?);
    let (r1, r2) = divider(vth / v, 100e3)?;
    Ok(Output::default().r("R1", r1).r("R2", r2))
}

/// Inverting Schmitt trigger: input on −; + is fed by R1 from the supply, R2 to ground and R3
/// from the output, so the threshold moves with the output: hysteresis (Voh − Vol)·G3/ΣG.
fn schmitt_trigger(i: &Input) -> Result<Output, String> {
    let (center, hyst, v) = (target(i, "center_v")?, target(i, "hyst_v")?, rail(i, "vcc")?);
    let (voh, vol) = lm358_levels(v);
    let (hi, lo) = (center + hyst / 2.0, center - hyst / 2.0);
    let a = hyst / (voh - vol); // G3 / ΣG
    let b = center - a * (voh + vol) / 2.0; // Vcc·G1/ΣG
    if b <= 0.0 || 1.0 - a - b / v <= 0.0 {
        return Err(format!("thresholds {lo:.2}–{hi:.2} V cannot be reached from a {v} V supply"));
    }
    let (r1, r2, r3) = best(E24.values(10e3, 1e6).into_iter().filter_map(|r3| {
        let gs = 1.0 / (r3 * a);
        let r1 = r24(v / (b * gs), 1e3, 10e6)?;
        let r2 = r24(1.0 / (gs * (1.0 - a - b / v)), 1e3, 10e6)?;
        let (g1, g2, g3) = (1.0 / r1, 1.0 / r2, 1.0 / r3);
        let s = g1 + g2 + g3;
        let (ha, la) = ((v * g1 + voh * g3) / s, (v * g1 + vol * g3) / s);
        Some((e2(ha, hi) + e2(la, lo) + near(r3, 100e3), (r1, r2, r3)))
    }))
    .ok_or_else(|| none_found("resistor set"))?;
    Ok(Output::default().r("R1", r1).r("R2", r2).r("R3", r3).spec("vth_hi_v", hi).spec("vth_lo_v", lo))
}

/// Unloaded divider from the supply; kept under 20 kΩ so a 1 MΩ load moves it < 1%.
fn divider_bias(i: &Input) -> Result<Output, String> {
    let (vout, v) = (target(i, "vout_v")?, rail(i, "vcc")?);
    if vout >= v {
        return Err(format!("a divider cannot reach {vout} V from a {v} V supply"));
    }
    let (r1, r2) = divider(vout / v, 10e3)?;
    Ok(Output::default().r("R1", r1).r("R2", r2))
}

/// A sine source block: the values are the targets themselves.
fn sine_source(i: &Input) -> Result<Output, String> {
    Ok(Output::default().set("V1", "offset", 0.0).set("V1", "amplitude", target(i, "amplitude_v")?).set(
        "V1",
        "frequency",
        target(i, "freq_hz")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(name: &str, targets: &[(&str, f64)], rails: &[(&str, f64)]) -> Output {
        let t = targets.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        let r = rails.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        solver(name).unwrap()(&Input { targets: &t, rails: &r }).unwrap()
    }

    fn v(o: &Output, local: &str, key: &str) -> f64 {
        o.values[local][key]
    }

    #[test]
    fn every_name_resolves() {
        for n in NAMES {
            assert!(solver(n).is_some(), "{n}");
        }
        assert!(solver("flux").is_none());
    }

    #[test]
    fn rc_corner_within_two_percent() {
        for fc in [10.0, 159.0, 1e3, 33e3, 100e3] {
            let o = run("rc_first_order", &[("fc_hz", fc)], &[]);
            let got = 1.0 / (2.0 * PI * v(&o, "R1", "resistance") * v(&o, "C1", "capacitance"));
            assert!((got / fc - 1.0).abs() < 0.02, "{fc}: {got}");
        }
    }

    #[test]
    fn sallen_key_lp_matches_lld_example() {
        let o = run("sallen_key_lp", &[("fc_hz", 1e3), ("q", 0.707)], &[]);
        let (r1, r2) = (v(&o, "R1", "resistance"), v(&o, "R2", "resistance"));
        let (c1, c2) = (v(&o, "C1", "capacitance"), v(&o, "C2", "capacitance"));
        let rc = (r1 * r2 * c1 * c2).sqrt();
        let q = rc / (c2 * (r1 + r2));
        let fc = corner_ratio(q) / (2.0 * PI * rc);
        assert!((fc / 1e3 - 1.0).abs() < 0.02 && (q / 0.707 - 1.0).abs() < 0.03, "fc {fc} q {q}");
    }

    #[test]
    fn corner_ratio_is_one_for_butterworth() {
        assert!((corner_ratio(std::f64::consts::FRAC_1_SQRT_2) - 1.0).abs() < 1e-12);
        assert!(corner_ratio(2.0) > 1.4 && corner_ratio(0.5) < 0.7);
    }

    #[test]
    fn schmitt_rejects_unreachable_thresholds() {
        let t: BTreeMap<String, f64> = [("center_v", 0.5), ("hyst_v", 1.5)].map(|(k, v)| (k.to_string(), v)).into();
        let r: BTreeMap<String, f64> = [("vcc".to_string(), 9.0)].into();
        assert!(schmitt_trigger(&Input { targets: &t, rails: &r }).is_err());
    }
}
