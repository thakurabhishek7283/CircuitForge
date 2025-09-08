mod common;

use circuit_core::Registry;
use common::*;

/// CI step 1 (LLD §12): every YAML part loads with its symbol, and every model file it names exists.
#[test]
fn shipped_registry_loads_and_its_files_exist() {
    let reg = registry();
    assert!(reg.parts.len() >= 10);
    for p in reg.parts.values() {
        if let Some(inc) = p.spice.as_ref().and_then(|s| s.include.as_ref()) {
            assert!(registry_root().join(inc).is_file(), "{}: missing model file {inc}", p.id);
        }
    }
}

/// The sprite sheet is part of the bundle; review drawing changes like netlist changes.
#[test]
fn sprite_sheet_is_stable() {
    let loaded = registry_sources();
    assert_eq!(loaded.sprite_sheet.matches("<symbol ").count(), loaded.registry.symbols.len());
    insta::assert_snapshot!(loaded.sprite_sheet);
}

#[test]
fn json_bundle_round_trips() {
    let reg = registry();
    let json = serde_json::to_string(&reg).unwrap();
    assert_eq!(Registry::from_json(&json).unwrap(), reg);
}

const TWO_PIN: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 20"><path d="M0 10H60"/><circle data-pin="1" cx="0" cy="10"/><circle data-pin="2" cx="60" cy="10"/></svg>"#;
const GROUND: &str =
    r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle data-pin="P" cx="10" cy="0"/></svg>"#;
const POWER: &str =
    r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle data-pin="P" cx="10" cy="20"/></svg>"#;

fn load_with(yaml: &str, symbols: &[(&str, &str)]) -> String {
    let errs = Registry::from_yaml_docs("t", [("bad.yaml", yaml)], symbols.iter().copied(), []).unwrap_err();
    errs.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n")
}

fn load_err(yaml: &str) -> String {
    load_with(yaml, &[("two.svg", TWO_PIN), ("flag_ground.svg", GROUND), ("flag_power.svg", POWER)])
}

#[test]
fn rejects_broken_parts() {
    let base = |extra: &str| {
        format!(
            "id: r\ncategory: R\ntitle: t\nsymbol: symbols/two.svg\npins:\n  - {{name: \"1\", num: 1, type: passive}}\n  - {{name: \"2\", num: 2, type: passive}}\n{extra}"
        )
    };
    assert!(load_err(&base("spice: {line: \"{refdes} {1} {3} 1k\"}")).contains("unknown placeholder {3}"));
    assert!(load_err(&base("params:\n  resistance: {unit: ohm, default: abc}")).contains("default"));
    assert!(load_err(&base("params:\n  resistance: {unit: ohm, default: 1, min: 10}")).contains("outside min/max"));
    assert!(load_err(&base("params:\n  resistance: {unit: ohm}")).contains("default"));
    assert!(load_err(&base("bogus: 1")).contains("unknown field"));
    assert!(load_err(&base("dc_param: x")).contains("only valid on voltage sources"));
    let dup = "id: r\ncategory: R\ntitle: t\nsymbol: symbols/two.svg\npins:\n  - {name: A, num: 1, type: passive}\n  - {name: A, num: 2, type: passive}\n";
    assert!(load_err(dup).contains("duplicate pin name"));
    let unit = "id: u\ncategory: U\ntitle: t\nsymbol: symbols/two.svg\nunits: [A]\npins:\n  - {name: OUT, num: 1, type: output, unit: A}\n";
    assert!(load_err(unit).contains("must end with _A"));
    let vsrc = "id: v\ncategory: V\ntitle: t\nsymbol: symbols/two.svg\npins:\n  - {name: P, num: 1, type: passive}\n  - {name: M, num: 2, type: passive}\nparams:\n  voltage: {unit: volt, default: \"1\"}\ndc_param: voltage\n";
    assert!(load_err(vsrc).contains("must have pin N"));
}

/// LLD §12 step 1: missing symbols and unknown or missing pin anchors fail the build.
#[test]
fn rejects_symbol_mismatches() {
    let part = |symbol: &str, pins: &str| format!("id: p\ncategory: R\ntitle: t\nsymbol: {symbol}\npins:\n{pins}");
    let two = "  - {name: \"1\", num: 1, type: passive}\n  - {name: \"2\", num: 2, type: passive}\n";
    let symbols = [("two.svg", TWO_PIN), ("flag_ground.svg", GROUND), ("flag_power.svg", POWER)];
    let ok = Registry::from_sources("t", [("p.yaml", part("symbols/two.svg", two).as_str())], symbols, []).unwrap();
    assert_eq!(ok.registry.symbols.len(), 3);
    assert!(ok.sprite_sheet.contains(r#"<symbol id="sym-two" viewBox="0 0 60 20""#));

    assert!(load_err(&part("symbols/nope.svg", two)).contains("symbol symbols/nope.svg is missing"));
    assert!(load_err(&part("two.svg", two)).contains("must be symbols/<id>.svg"));
    assert!(load_err("id: p\ncategory: R\ntitle: t\npins: []\n").contains("missing field `symbol`"));
    let three = format!("{two}  - {{name: \"3\", num: 3, type: passive}}\n");
    assert!(load_err(&part("symbols/two.svg", &three)).contains("pin 3 has no anchor 3 in symbols/two.svg"));
    let one = "  - {name: \"1\", num: 1, type: passive}\n";
    assert!(load_err(&part("symbols/two.svg", one)).contains("anchor 2 in symbols/two.svg matches no pin"));

    let no_flags = load_with(&part("symbols/two.svg", two), &[("two.svg", TWO_PIN)]);
    assert!(no_flags.contains("symbols/flag_ground.svg: required flag symbol is missing"), "{no_flags}");
    let spare = load_with(
        &part("symbols/two.svg", two),
        &[("two.svg", TWO_PIN), ("spare.svg", TWO_PIN), ("flag_ground.svg", GROUND), ("flag_power.svg", POWER)],
    );
    assert!(spare.contains("symbols/spare.svg: no part uses this symbol"), "{spare}");
    let bad_svg = load_with(&part("symbols/two.svg", two), &[("two.svg", "<svg/>")]);
    assert!(bad_svg.contains("symbols/two.svg: root element"), "{bad_svg}");
}

/// A multi-unit part's symbol draws one unit: unit pins anchor by base name, shared pins by name.
#[test]
fn multi_unit_symbols_anchor_by_base_name() {
    let reg = registry();
    let tl072 = &reg.parts["opamp_tl072"];
    assert_eq!(tl072.symbol, "symbols/opamp.svg");
    let anchors: Vec<&str> = tl072.pins.iter().map(|p| tl072.anchor_name(p)).collect();
    assert_eq!(anchors, ["OUT", "INM", "INP", "VEE", "INP", "INM", "OUT", "VCC"]);
    let sym = &reg.symbols["opamp"];
    assert_eq!(sym.pins.keys().collect::<Vec<_>>(), ["INM", "INP", "OUT", "VCC", "VEE"]);
}

#[test]
fn prefixed_limits_are_parsed() {
    let reg = registry();
    let cap = &reg.parts["cap_film"].params["capacitance"];
    assert_eq!(cap.min, Some(1e-12));
    assert_eq!(cap.max, Some(10e-6));
    assert_eq!(reg.parts["vsource_sine"].params["frequency"].max, Some(100e6));
}
/// Every SPICE template must agree with its model file: a `.model` of that name exists, or a
/// `.subckt` of that name takes exactly as many nodes as the template passes it.
#[test]
fn spice_templates_match_their_model_files() {
    let reg = registry();
    for p in reg.parts.values() {
        let Some(sp) = &p.spice else { continue };
        let Some(inc) = &sp.include else { continue };
        let lib = std::fs::read_to_string(registry_root().join(inc)).unwrap().to_ascii_lowercase();
        let line = sp.line.as_ref().or(sp.unit_line.as_ref()).unwrap();
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let model = tokens.last().unwrap().to_ascii_lowercase();
        if line.starts_with('X') {
            let nodes = tokens.len() - 2;
            let header = lib
                .lines()
                .find(|l| l.split_whitespace().take(2).eq([".subckt", model.as_str()]))
                .unwrap_or_else(|| panic!("{}: no .subckt {model} in {inc}", p.id));
            let pins = header.split_whitespace().count() - 2;
            assert_eq!(nodes, pins, "{}: template passes {nodes} nodes, .subckt {model} takes {pins}", p.id);
        } else {
            assert!(
                lib.lines().any(|l| l.split_whitespace().nth(1) == Some(model.as_str()) && l.starts_with(".model")),
                "{}: no .model {model} in {inc}",
                p.id
            );
        }
    }
}
