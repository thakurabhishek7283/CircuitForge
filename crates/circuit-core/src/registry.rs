//! Component registry: the only source of pin maps, param schemas and SPICE templates (LLD §12).
//! Loading is pure: callers pass file contents in; this module never touches the filesystem.

use std::collections::{BTreeMap, BTreeSet};

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ir::PartId;
use crate::symbol::{FLAG_GROUND, FLAG_PIN, FLAG_POWER, SymbolDef, symbol_id};
use crate::template::TemplateDef;
use crate::units::{Unit, parse_quantity};

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Registry {
    pub version: String,
    pub parts: IndexMap<PartId, PartDef>,
    /// Schematic symbols by id (`symbols/<id>.svg`): geometry only; the drawings ship in the
    /// bundle's sprite sheet.
    pub symbols: BTreeMap<String, SymbolDef>,
    /// Block templates by id (`templates/<id>.yaml`), each checked against the parts at load.
    #[serde(default)]
    pub templates: IndexMap<String, TemplateDef>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Category {
    R,
    C,
    L,
    D,
    Q,
    U,
    V,
    J,
}

impl Category {
    pub fn letter(self) -> char {
        match self {
            Category::R => 'R',
            Category::C => 'C',
            Category::L => 'L',
            Category::D => 'D',
            Category::Q => 'Q',
            Category::U => 'U',
            Category::V => 'V',
            Category::J => 'J',
        }
    }

    pub fn from_letter(c: char) -> Option<Category> {
        Some(match c {
            'R' => Category::R,
            'C' => Category::C,
            'L' => Category::L,
            'D' => Category::D,
            'Q' => Category::Q,
            'U' => Category::U,
            'V' => Category::V,
            'J' => Category::J,
            _ => return None,
        })
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PartDef {
    pub id: PartId,
    pub category: Category,
    pub title: String,
    #[serde(default)]
    pub role_tags: Vec<String>,
    /// Units of a multi-unit IC (e.g. `[A, B]` for a dual op-amp). Empty for single-unit parts.
    #[serde(default)]
    pub units: Vec<String>,
    pub pins: Vec<PinDef>,
    /// Every param must declare a default, so instances always carry a full param set.
    #[serde(default)]
    pub params: IndexMap<String, ParamDef>,
    /// Ratings used by ERC, e.g. `v_supply_max`, `i_max`, `p_max`.
    #[serde(default)]
    pub limits: BTreeMap<String, f64>,
    /// For voltage sources: the param holding V(P) − V(N) at DC (used by ERC007).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dc_param: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spice: Option<SpiceDef>,
    /// Schematic symbol, `symbols/<id>.svg`; its pin anchors are matched by pin name.
    pub symbol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breadboard: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teach: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hazard: Option<Hazard>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PinDef {
    pub name: String,
    pub num: u16,
    #[serde(rename = "type")]
    pub kind: PinType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum PinType {
    Input,
    Output,
    Passive,
    PowerPos,
    PowerNeg,
    /// Not connected internally; exempt from ERC001.
    Nc,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ParamDef {
    pub unit: Unit,
    pub default: String,
    /// In SI units. YAML sources may write a prefixed number such as `1p` or `100meg`.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "num_or_eng")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "num_or_eng")]
    pub max: Option<f64>,
}

fn num_or_eng<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        Num(f64),
        Str(String),
    }
    match Option::<NumOrStr>::deserialize(d)? {
        None => Ok(None),
        Some(NumOrStr::Num(x)) => Ok(Some(x)),
        Some(NumOrStr::Str(s)) => {
            parse_quantity(&s, Unit::Unitless).map(|q| Some(q.si)).map_err(serde::de::Error::custom)
        }
    }
}

/// SPICE emission template. `line` is for single-unit parts; `unit_line` is emitted once per
/// used unit of a multi-unit part. Placeholders: `{refdes}`, `{unit}`, pin names, param names.
/// In `unit_line`, a unit pin is named without its `_<unit>` suffix (`{OUT}` → `OUT_A`).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SpiceDef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_line: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Hazard {
    Mains,
}

/// A registry loaded from its sources, with the sprite sheet the bundle ships (LLD §12 step 3).
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub registry: Registry,
    pub sprite_sheet: String,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{source_name}: {message}")]
pub struct RegistryError {
    pub source_name: String,
    pub message: String,
}

impl PartDef {
    pub fn pin(&self, name: &str) -> Option<&PinDef> {
        self.pins.iter().find(|p| p.name == name)
    }

    /// Pins of one unit of a multi-unit part.
    pub fn unit_pins<'a>(&'a self, unit: &'a str) -> impl Iterator<Item = &'a PinDef> + 'a {
        self.pins.iter().filter(move |p| p.unit.as_deref() == Some(unit))
    }

    /// The symbol anchor a pin is drawn at: unit pins by their base name (`OUT_A` → `OUT`).
    pub fn anchor_name<'a>(&self, pin: &'a PinDef) -> &'a str {
        match &pin.unit {
            Some(u) => pin.name.strip_suffix(u.as_str()).and_then(|s| s.strip_suffix('_')).unwrap_or(&pin.name),
            None => &pin.name,
        }
    }

    /// Pin anchors must match the symbol's exactly: none missing, none unknown.
    fn check_symbol(&self, symbols: &BTreeMap<String, SymbolDef>) -> Vec<String> {
        let Some(id) = symbol_id(&self.symbol) else {
            return vec![format!("symbol \"{}\" must be symbols/<id>.svg with a lowercase [a-z0-9_] id", self.symbol)];
        };
        let Some(sym) = symbols.get(id) else {
            return vec![format!("symbol {} is missing", self.symbol)];
        };
        let mut errs = Vec::new();
        // anchor -> first pin drawn there. Only unit pins of different units may share one.
        let mut wanted: BTreeMap<&str, &PinDef> = BTreeMap::new();
        for p in &self.pins {
            let a = self.anchor_name(p);
            match wanted.get(a) {
                Some(q) if p.unit.is_none() || q.unit.is_none() => {
                    errs.push(format!("pins {} and {} would share anchor {a}", q.name, p.name))
                }
                Some(_) => {}
                None => {
                    wanted.insert(a, p);
                }
            }
            if !sym.pins.contains_key(a) {
                errs.push(format!("pin {} has no anchor {a} in {}", p.name, self.symbol));
            }
        }
        for a in sym.pins.keys() {
            if !wanted.contains_key(a.as_str()) {
                errs.push(format!("anchor {a} in {} matches no pin", self.symbol));
            }
        }
        errs
    }

    /// Resolve a `unit_line` placeholder for `unit`: the unit's own pin first, then a shared pin.
    pub fn resolve_unit_pin(&self, unit: &str, base: &str) -> Option<&PinDef> {
        let suffixed = format!("{base}_{unit}");
        self.pins
            .iter()
            .find(|p| p.unit.as_deref() == Some(unit) && p.name == suffixed)
            .or_else(|| self.pins.iter().find(|p| p.unit.is_none() && p.name == base))
    }

    fn validate(&self) -> Vec<String> {
        let mut errs = Vec::new();
        let ident = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !(ident(&self.id) && self.id.bytes().all(|b| !b.is_ascii_uppercase())) {
            errs.push(format!("id \"{}\" must be lowercase [a-z0-9_]", self.id));
        }
        if self.pins.is_empty() {
            errs.push("part has no pins".into());
        }
        let mut names = BTreeSet::new();
        let mut nums = BTreeSet::new();
        for p in &self.pins {
            if !ident(&p.name) {
                errs.push(format!("pin name \"{}\" must be [A-Za-z0-9_]", p.name));
            }
            if !names.insert(p.name.as_str()) {
                errs.push(format!("duplicate pin name {}", p.name));
            }
            if !nums.insert(p.num) {
                errs.push(format!("duplicate pin number {}", p.num));
            }
            match &p.unit {
                Some(u) if !self.units.contains(u) => errs.push(format!("pin {} names unknown unit {u}", p.name)),
                Some(u) if !p.name.ends_with(&format!("_{u}")) => {
                    errs.push(format!("unit pin {} must end with _{u}", p.name))
                }
                _ => {}
            }
        }
        for (name, def) in &self.params {
            if !ident(name) {
                errs.push(format!("param name \"{name}\" must be [A-Za-z0-9_]"));
            }
            if names.contains(name.as_str()) {
                errs.push(format!("param {name} has the same name as a pin"));
            }
            if let (Some(lo), Some(hi)) = (def.min, def.max)
                && lo > hi
            {
                errs.push(format!("param {name}: min > max"));
            }
            match parse_quantity(&def.default, def.unit) {
                Ok(q) => {
                    if def.min.is_some_and(|lo| q.si < lo) || def.max.is_some_and(|hi| q.si > hi) {
                        errs.push(format!("param {name}: default {} outside min/max", def.default));
                    }
                }
                Err(e) => errs.push(format!("param {name}: default: {e}")),
            }
        }
        if self.category == Category::V {
            for n in ["P", "N"] {
                if self.pin(n).is_none() {
                    errs.push(format!("voltage source must have pin {n}"));
                }
            }
            match self.dc_param.as_deref().map(|p| self.params.get(p)) {
                Some(Some(def)) if def.unit == Unit::Volt => {}
                _ => errs.push("voltage source needs dc_param naming a volt param".into()),
            }
        } else if self.dc_param.is_some() {
            errs.push("dc_param is only valid on voltage sources".into());
        }
        if let Some(sp) = &self.spice {
            match (&sp.line, &sp.unit_line) {
                (Some(line), None) => {
                    let known = |n: &str| n == "refdes" || self.pin(n).is_some() || self.params.contains_key(n);
                    errs.extend(check_placeholders(line, known));
                }
                (None, Some(line)) if !self.units.is_empty() => {
                    for unit in &self.units {
                        let known = |n: &str| {
                            n == "refdes"
                                || n == "unit"
                                || self.resolve_unit_pin(unit, n).is_some()
                                || self.params.contains_key(n)
                        };
                        errs.extend(check_placeholders(line, known));
                    }
                }
                (None, Some(_)) => errs.push("unit_line requires units".into()),
                _ => errs.push("spice needs exactly one of line / unit_line".into()),
            }
        }
        errs
    }
}

/// Every `{name}` in a template must be known; braces must balance.
fn check_placeholders(line: &str, known: impl Fn(&str) -> bool) -> Vec<String> {
    let mut errs = Vec::new();
    let mut rest = line;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else {
            errs.push(format!("unbalanced brace in \"{line}\""));
            break;
        };
        let name = &rest[open + 1..open + close];
        if !known(name) {
            errs.push(format!("unknown placeholder {{{name}}} in \"{line}\""));
        }
        rest = &rest[open + close + 1..];
    }
    if rest.contains('}') {
        errs.push(format!("unbalanced brace in \"{line}\""));
    }
    errs
}

impl Registry {
    /// Build and validate a registry. Each part and template is paired with a source name for
    /// error messages. Every part needs a symbol whose anchors match its pins, and the flag
    /// symbols must exist; every template must name known parts, pins, ports and a solver that
    /// solves it.
    pub fn new(
        version: impl Into<String>,
        parts: impl IntoIterator<Item = (String, PartDef)>,
        symbols: BTreeMap<String, SymbolDef>,
        templates: impl IntoIterator<Item = (String, TemplateDef)>,
    ) -> Result<Registry, Vec<RegistryError>> {
        let mut errs = Vec::new();
        let mut map = IndexMap::new();
        for (source_name, def) in parts {
            for message in def.validate() {
                errs.push(RegistryError { source_name: source_name.clone(), message });
            }
            if map.contains_key(&def.id) {
                errs.push(RegistryError { source_name, message: format!("duplicate part id {}", def.id) });
                continue;
            }
            map.insert(def.id.clone(), def);
        }
        for (id, sym) in &symbols {
            let source_name = format!("symbols/{id}.svg");
            for message in sym.validate() {
                errs.push(RegistryError { source_name: source_name.clone(), message });
            }
            let used = map.values().any(|p| symbol_id(&p.symbol) == Some(id.as_str()));
            let flag = id == FLAG_GROUND || id == FLAG_POWER;
            if flag && !sym.pins.keys().eq([FLAG_PIN]) {
                errs.push(RegistryError { source_name, message: format!("a flag has exactly one anchor, {FLAG_PIN}") });
            } else if !used && !flag {
                errs.push(RegistryError { source_name, message: "no part uses this symbol".into() });
            }
        }
        for flag in [FLAG_GROUND, FLAG_POWER] {
            if !symbols.contains_key(flag) {
                errs.push(RegistryError {
                    source_name: format!("symbols/{flag}.svg"),
                    message: "required flag symbol is missing".into(),
                });
            }
        }
        for p in map.values() {
            for message in p.check_symbol(&symbols) {
                errs.push(RegistryError { source_name: p.id.clone(), message });
            }
        }
        let mut tmap = IndexMap::new();
        for (source_name, t) in templates {
            for message in t.validate(&map) {
                errs.push(RegistryError { source_name: source_name.clone(), message });
            }
            if tmap.contains_key(&t.id) {
                errs.push(RegistryError { source_name, message: format!("duplicate template id {}", t.id) });
                continue;
            }
            tmap.insert(t.id.clone(), t);
        }
        if errs.is_empty() {
            Ok(Registry { version: version.into(), parts: map, symbols, templates: tmap })
        } else {
            Err(errs)
        }
    }

    /// Load the compiled JSON bundle (what the browser and API receive).
    pub fn from_json(json: &str) -> Result<Registry, Vec<RegistryError>> {
        let raw: Registry = serde_json::from_str(json)
            .map_err(|e| vec![RegistryError { source_name: "bundle".into(), message: e.to_string() }])?;
        Registry::new(
            raw.version,
            raw.parts.into_values().map(|p| (p.id.clone(), p)),
            raw.symbols,
            raw.templates.into_values().map(|t| (t.id.clone(), t)),
        )
    }

    /// Load YAML part sources, SVG symbol sources and YAML template sources: `(file_name, text)`
    /// each, symbols named `<id>.svg`. Returns the registry and the sprite sheet of its symbols
    /// (LLD §12 step 1).
    #[cfg(feature = "sources")]
    pub fn from_sources<'a>(
        version: impl Into<String>,
        part_docs: impl IntoIterator<Item = (&'a str, &'a str)>,
        symbol_docs: impl IntoIterator<Item = (&'a str, &'a str)>,
        template_docs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Loaded, Vec<RegistryError>> {
        let mut errs = Vec::new();
        let mut parts = Vec::new();
        for (name, text) in part_docs {
            match serde_norway::from_str::<PartDef>(text) {
                Ok(p) => parts.push((name.to_string(), p)),
                Err(e) => errs.push(RegistryError { source_name: name.to_string(), message: e.to_string() }),
            }
        }
        let mut parsed = BTreeMap::new();
        for (name, text) in symbol_docs {
            let source_name = format!("symbols/{name}");
            let Some(id) = symbol_id(&source_name) else {
                errs.push(RegistryError { source_name, message: "symbol files are named <id>.svg".into() });
                continue;
            };
            match crate::symbol::parse_svg(text) {
                Ok(s) => {
                    parsed.insert(id.to_string(), s);
                }
                Err(es) => errs
                    .extend(es.into_iter().map(|message| RegistryError { source_name: source_name.clone(), message })),
            }
        }
        let mut templates = Vec::new();
        for (name, text) in template_docs {
            let source_name = format!("templates/{name}");
            match serde_norway::from_str::<TemplateDef>(text) {
                Ok(t) if format!("{}.yaml", t.id) == name => templates.push((source_name, t)),
                Ok(t) => errs.push(RegistryError {
                    source_name,
                    message: format!("template {} must be in {}.yaml", t.id, t.id),
                }),
                Err(e) => errs.push(RegistryError { source_name, message: e.to_string() }),
            }
        }
        let symbols = parsed.iter().map(|(id, s)| (id.clone(), s.def.clone())).collect();
        let built = Registry::new(version, parts, symbols, templates);
        match built {
            Ok(registry) if errs.is_empty() => {
                let sprite_sheet = crate::symbol::sprite_sheet(parsed.iter().map(|(id, s)| (id.as_str(), s)));
                Ok(Loaded { registry, sprite_sheet })
            }
            Ok(_) => Err(errs),
            Err(more) => {
                errs.extend(more);
                Err(errs)
            }
        }
    }

    /// [`Registry::from_sources`] without the sprite sheet.
    #[cfg(feature = "sources")]
    pub fn from_yaml_docs<'a>(
        version: impl Into<String>,
        part_docs: impl IntoIterator<Item = (&'a str, &'a str)>,
        symbol_docs: impl IntoIterator<Item = (&'a str, &'a str)>,
        template_docs: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Result<Registry, Vec<RegistryError>> {
        Registry::from_sources(version, part_docs, symbol_docs, template_docs).map(|l| l.registry)
    }

    pub fn part(&self, id: &str) -> Option<&PartDef> {
        self.parts.get(id)
    }
}
