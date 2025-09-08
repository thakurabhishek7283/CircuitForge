//! Unit parsing and formatting. This is the only place values like "4.7u", "4k7" or "2.2meg"
//! are parsed, so the browser and the server can never disagree about a value (LLD §3, inv. 6).
//!
//! Prefixes are case-sensitive: `m` is milli, `M` is mega; `meg` (any case) is also mega,
//! as in SPICE. `display` is canonical engineering notation and always re-parses to the
//! exact same `si` value, so inverse ops can carry it as a string without losing precision.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Ohm,
    Farad,
    Henry,
    Volt,
    Ampere,
    Hertz,
    Second,
    Watt,
    Unitless,
}

impl Unit {
    pub const ALL: [Unit; 9] = [
        Unit::Ohm,
        Unit::Farad,
        Unit::Henry,
        Unit::Volt,
        Unit::Ampere,
        Unit::Hertz,
        Unit::Second,
        Unit::Watt,
        Unit::Unitless,
    ];

    pub fn symbol(self) -> &'static str {
        match self {
            Unit::Ohm => "Ω",
            Unit::Farad => "F",
            Unit::Henry => "H",
            Unit::Volt => "V",
            Unit::Ampere => "A",
            Unit::Hertz => "Hz",
            Unit::Second => "s",
            Unit::Watt => "W",
            Unit::Unitless => "",
        }
    }

    /// Accepted written suffixes, longest first. Single letters that collide with a prefix
    /// (`f` femto, `m` milli) are deliberately absent.
    fn suffixes(self) -> &'static [&'static str] {
        match self {
            Unit::Ohm => &["ohms", "Ohms", "OHMS", "ohm", "Ohm", "OHM", "Ω", "\u{2126}"],
            Unit::Farad => &["F"],
            Unit::Henry => &["H"],
            Unit::Volt => &["V", "v"],
            Unit::Ampere => &["A"],
            Unit::Hertz => &["Hz", "hz", "HZ"],
            Unit::Second => &["sec", "s"],
            Unit::Watt => &["W"],
            Unit::Unitless => &[],
        }
    }
}

/// A parsed physical value. `display` is canonical and round-trips exactly through [`parse_quantity`].
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Quantity {
    pub si: f64,
    pub unit: Unit,
    pub display: String,
}

impl Quantity {
    pub fn new(si: f64, unit: Unit) -> Quantity {
        Quantity { si, unit, display: format_eng(si, unit) }
    }

    /// Deterministic SPICE literal: Rust's shortest round-trip exponent form, e.g. `1e4`, `4.7e-6`.
    pub fn to_spice(&self) -> String {
        spice_number(self.si)
    }
}

pub fn spice_number(x: f64) -> String {
    format!("{x:e}")
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum UnitError {
    #[error("empty value")]
    Empty,
    #[error("cannot parse \"{0}\" as a value")]
    Malformed(String),
    #[error("\"{text}\" is in {found:?}, expected {expected:?}")]
    WrongUnit { text: String, expected: Unit, found: Unit },
    #[error("\"{0}\" is not a finite number")]
    NotFinite(String),
}

/// Parse a learner/LLM-written value such as `"10k"`, `"4k7"`, `"4.7 µF"`, `"2.2meg"`, `"100mV"`.
pub fn parse_quantity(text: &str, unit: Unit) -> Result<Quantity, UnitError> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.is_empty() {
        return Err(UnitError::Empty);
    }
    let body = match strip_unit_suffix(&compact, unit) {
        Some(b) => b,
        None => {
            // A suffix belonging to another unit ("1F" for a resistor) is a unit error, not a parse error.
            for other in Unit::ALL {
                if other != unit
                    && let Some(b) = strip_unit_suffix(&compact, other)
                    && b != compact
                    && parse_number(b).is_ok()
                {
                    return Err(UnitError::WrongUnit { text: text.to_string(), expected: unit, found: other });
                }
            }
            &compact
        }
    };
    let si = parse_number(body).map_err(|_| UnitError::Malformed(text.to_string()))?;
    if !si.is_finite() {
        return Err(UnitError::NotFinite(text.to_string()));
    }
    Ok(Quantity::new(si, unit))
}

fn strip_unit_suffix(s: &str, unit: Unit) -> Option<&str> {
    unit.suffixes().iter().find_map(|suf| s.strip_suffix(suf)).filter(|b| !b.is_empty())
}

fn prefix_exponent(p: &str) -> Option<i32> {
    Some(match p {
        "" => 0,
        "f" => -15,
        "p" => -12,
        "n" => -9,
        "u" | "µ" | "μ" => -6,
        "m" => -3,
        "k" | "K" => 3,
        "M" => 6,
        "G" => 9,
        "T" => 12,
        _ if p.eq_ignore_ascii_case("meg") => 6,
        _ => return None,
    })
}

/// Number with optional exponent and optional SI prefix, or RKM form (`4k7`, `4R7`, `2u2`).
/// The result is built as a decimal string and parsed once, so it is correctly rounded.
fn parse_number(s: &str) -> Result<f64, ()> {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut sign = "";
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        if bytes[i] == b'-' {
            sign = "-";
        }
        i += 1;
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = &s[int_start..i];
    let mut frac_digits = "";
    let mut has_point = false;
    if i < bytes.len() && bytes[i] == b'.' {
        has_point = true;
        i += 1;
        let fs = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = &s[fs..i];
    }
    if int_digits.is_empty() && frac_digits.is_empty() {
        return Err(());
    }
    let mut exp: i32 = 0;
    let mut has_exp = false;
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let ds = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > ds {
            exp = s[i + 1..j].parse::<i32>().map_err(|_| ())?;
            has_exp = true;
            i = j;
        }
    }
    let rest = &s[i..];

    // RKM: digits, prefix letter (or R), digits — only when no point or exponent was written.
    if !has_point && !has_exp && !rest.is_empty() {
        let split = rest.find(|c: char| c.is_ascii_digit());
        if let Some(k) = split {
            let (letter, tail) = rest.split_at(k);
            if !tail.bytes().all(|b| b.is_ascii_digit()) || int_digits.is_empty() {
                return Err(());
            }
            let pexp = if letter == "R" || letter == "r" { 0 } else { prefix_exponent(letter).ok_or(())? };
            if letter.eq_ignore_ascii_case("meg") {
                return Err(());
            }
            let text = format!("{sign}{int_digits}.{tail}e{pexp}");
            return text.parse::<f64>().map_err(|_| ());
        }
    }

    let pexp = prefix_exponent(rest).ok_or(())?;
    let int_part = if int_digits.is_empty() { "0" } else { int_digits };
    let frac_part = if frac_digits.is_empty() { "0" } else { frac_digits };
    let total = exp.checked_add(pexp).ok_or(())?;
    let text = format!("{sign}{int_part}.{frac_part}e{total}");
    text.parse::<f64>().map_err(|_| ())
}

const PREFIXES: [(i32, &str); 10] =
    [(-15, "f"), (-12, "p"), (-9, "n"), (-6, "µ"), (-3, "m"), (0, ""), (3, "k"), (6, "M"), (9, "G"), (12, "T")];

/// Canonical engineering notation (`10kΩ`, `4.7µF`, `-1.5V`). Works on the decimal digit string
/// of the shortest round-trip representation, so re-parsing yields the identical f64.
pub fn format_eng(si: f64, unit: Unit) -> String {
    let sym = unit.symbol();
    if si == 0.0 || !si.is_finite() {
        let n = if si.is_finite() { "0".to_string() } else { format!("{si}") };
        return format!("{n}{sym}");
    }
    let sign = if si < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", si.abs()); // e.g. "1.59155e3"
    let (mant, exp) = sci.split_once('e').expect("{:e} always has an exponent");
    let exp: i32 = exp.parse().expect("valid exponent");
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();

    let eng = (exp.div_euclid(3) * 3).clamp(-15, 12);
    let prefix = PREFIXES.iter().find(|(e, _)| *e == eng).map(|(_, p)| *p).unwrap_or("");
    // Position of the decimal point within `digits` once scaled by 10^-eng.
    let point = 1 + exp - eng;
    let number = if point <= 0 {
        format!("0.{}{}", "0".repeat((-point) as usize), digits)
    } else if (point as usize) >= digits.len() {
        format!("{}{}", digits, "0".repeat(point as usize - digits.len()))
    } else {
        let (a, b) = digits.split_at(point as usize);
        format!("{a}.{b}")
    };
    let number =
        if number.contains('.') { number.trim_end_matches('0').trim_end_matches('.').to_string() } else { number };
    format!("{sign}{number}{prefix}{sym}")
}

/// A value rounded to 3 significant digits for reading (spec checks): engineering notation with
/// the unit's symbol, or a plain number for unitless values (`0.707`, not `707m`).
pub fn format_sig(x: f64, unit: Unit) -> String {
    if x == 0.0 || !x.is_finite() {
        return format_eng(x, unit);
    }
    let r: f64 = format!("{x:.2e}").parse().expect("{:.2e} re-parses");
    if unit != Unit::Unitless {
        return format_eng(r, unit);
    }
    let mag = r.abs().log10().floor() as i32;
    if !(-3..6).contains(&mag) {
        return format!("{r:.2e}");
    }
    format!("{r:.*}", (2 - mag).max(0) as usize)
}

/// Preferred-number series (IEC 60063): the values parts are actually sold in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ESeries {
    E6,
    E12,
    E24,
}

const E24: [&str; 24] = [
    "1.0", "1.1", "1.2", "1.3", "1.5", "1.6", "1.8", "2.0", "2.2", "2.4", "2.7", "3.0", "3.3", "3.6", "3.9", "4.3",
    "4.7", "5.1", "5.6", "6.2", "6.8", "7.5", "8.2", "9.1",
];

impl ESeries {
    fn mantissas(self) -> impl Iterator<Item = &'static str> {
        let step = match self {
            ESeries::E6 => 4,
            ESeries::E12 => 2,
            ESeries::E24 => 1,
        };
        E24.iter().step_by(step).copied()
    }

    /// Every value of the series in `[lo, hi]`, ascending. Built from decimal text, so `4.7k` is
    /// exactly the double nearest 4700 on every runtime.
    pub fn values(self, lo: f64, hi: f64) -> Vec<f64> {
        let mut out = Vec::new();
        let (first, last) = (lo.log10().floor() as i32 - 1, hi.log10().ceil() as i32);
        for exp in first..=last {
            for m in self.mantissas() {
                let v: f64 = format!("{m}e{exp}").parse().expect("series values parse");
                if v >= lo * (1.0 - 1e-12) && v <= hi * (1.0 + 1e-12) {
                    out.push(v);
                }
            }
        }
        out
    }

    /// The series value nearest to `x` in log terms (the smallest relative error).
    pub fn nearest(self, x: f64) -> f64 {
        self.values(x / 1.5, x * 1.5)
            .into_iter()
            .min_by(|a, b| (a / x).ln().abs().total_cmp(&(b / x).ln().abs()))
            .expect("a series value lies within ±50% of any positive x")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn e_series() {
        assert_eq!(ESeries::E12.values(1e3, 2.7e3), [1e3, 1.2e3, 1.5e3, 1.8e3, 2.2e3, 2.7e3]);
        assert_eq!(ESeries::E6.values(1e-9, 3.3e-9).len(), 4);
        assert_eq!(ESeries::E24.nearest(1591.5), 1.6e3);
        assert_eq!(ESeries::E12.nearest(5.3e-9), 5.6e-9);
        assert_eq!(ESeries::E24.nearest(4.7e3), 4.7e3);
        assert_eq!(format_eng(ESeries::E24.nearest(4.7e3), Unit::Ohm), "4.7kΩ");
    }

    #[test]
    fn three_significant_digits() {
        assert_eq!(format_sig(1003.47, Unit::Hertz), "1kHz");
        assert_eq!(format_sig(1591.55, Unit::Hertz), "1.59kHz");
        assert_eq!(format_sig(0.70712, Unit::Unitless), "0.707");
        assert_eq!(format_sig(12.345, Unit::Unitless), "12.3");
        assert_eq!(format_sig(100.2, Unit::Unitless), "100");
        assert_eq!(format_sig(-2.5004, Unit::Volt), "-2.5V");
    }

    fn si(text: &str, unit: Unit) -> f64 {
        parse_quantity(text, unit).unwrap().si
    }

    #[test]
    fn parses_common_forms() {
        assert_eq!(si("10k", Unit::Ohm), 10e3);
        assert_eq!(si("4k7", Unit::Ohm), 4.7e3);
        assert_eq!(si("4.7k", Unit::Ohm), 4.7e3);
        assert_eq!(si("4R7", Unit::Ohm), 4.7);
        assert_eq!(si("2.2meg", Unit::Ohm), 2.2e6);
        assert_eq!(si("2.2MEG", Unit::Ohm), 2.2e6);
        assert_eq!(si("1M", Unit::Ohm), 1e6);
        assert_eq!(si("10 kΩ", Unit::Ohm), 10e3);
        assert_eq!(si("10kohm", Unit::Ohm), 10e3);
        assert_eq!(si("4.7u", Unit::Farad), 4.7e-6);
        assert_eq!(si("4.7µF", Unit::Farad), 4.7e-6);
        assert_eq!(si("2u2", Unit::Farad), 2.2e-6);
        assert_eq!(si("100n", Unit::Farad), 100e-9);
        assert_eq!(si("1f", Unit::Farad), 1e-15);
        assert_eq!(si("1F", Unit::Farad), 1.0);
        assert_eq!(si("100mV", Unit::Volt), 0.1);
        assert_eq!(si("-12", Unit::Volt), -12.0);
        assert_eq!(si("1e-3", Unit::Second), 1e-3);
        assert_eq!(si("1.5e3k", Unit::Hertz), 1.5e6);
        assert_eq!(si("1kHz", Unit::Hertz), 1e3);
        assert_eq!(si("1mHz", Unit::Hertz), 1e-3);
        assert_eq!(si("10ms", Unit::Second), 10e-3);
        assert_eq!(si(".5", Unit::Unitless), 0.5);
    }

    #[test]
    fn rejects_bad_values() {
        assert!(matches!(parse_quantity("", Unit::Ohm), Err(UnitError::Empty)));
        assert!(matches!(parse_quantity("abc", Unit::Ohm), Err(UnitError::Malformed(_))));
        assert!(matches!(parse_quantity("10x", Unit::Ohm), Err(UnitError::Malformed(_))));
        assert!(matches!(parse_quantity("4k7k", Unit::Ohm), Err(UnitError::Malformed(_))));
        assert!(matches!(parse_quantity("1e999", Unit::Ohm), Err(UnitError::NotFinite(_))));
        assert!(matches!(parse_quantity("10uF", Unit::Ohm), Err(UnitError::WrongUnit { found: Unit::Farad, .. })));
        assert!(matches!(parse_quantity("5V", Unit::Hertz), Err(UnitError::WrongUnit { .. })));
    }

    #[test]
    fn formats_engineering() {
        assert_eq!(format_eng(10e3, Unit::Ohm), "10kΩ");
        assert_eq!(format_eng(4.7e-6, Unit::Farad), "4.7µF");
        assert_eq!(format_eng(2.2e6, Unit::Ohm), "2.2MΩ");
        assert_eq!(format_eng(0.1, Unit::Volt), "100mV");
        assert_eq!(format_eng(-12.0, Unit::Volt), "-12V");
        assert_eq!(format_eng(1591.55, Unit::Hertz), "1.59155kHz");
        assert_eq!(format_eng(0.0, Unit::Volt), "0V");
        assert_eq!(format_eng(1e-18, Unit::Farad), "0.001fF");
        assert_eq!(format_eng(1e15, Unit::Hertz), "1000THz");
        assert_eq!(format_eng(0.707, Unit::Unitless), "707m");
    }

    #[test]
    fn spice_literals() {
        assert_eq!(spice_number(10e3), "1e4");
        assert_eq!(spice_number(4.7e-6), "4.7e-6");
        assert_eq!(spice_number(-5.0), "-5e0");
    }
}
