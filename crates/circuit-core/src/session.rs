//! A circuit held next to its registry, plus a JSON-string API over it. The WASM and PyO3
//! facades are thin wrappers around [`json_api`], so both runtimes share one implementation of
//! every boundary detail (parsing, error shapes, result shapes) and cannot drift apart.

use std::sync::Arc;

use indexmap::IndexMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::apply::{Patch, apply, apply_ops, validate};
use crate::edit::{self, WireEnd};
use crate::erc::{ErcContext, ErcIssue, erc};
use crate::error::{ErrorCode, OpError};
use crate::ir::{Analysis, Block, BlockId, Circuit, LayoutHint, Net, NetId, PartInstance, PinRef, RefDes};
use crate::ops::{Author, Op, OpEnvelope};
use crate::registry::Registry;
use crate::spice::{CompileError, CompileOpts, Netlist, compile};
use crate::template::{self, InsertBlock, Inserted, Preview};

/// What a successful `apply` reports to the UI: only what changed (LLD §10).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ApplyOk {
    pub rev: u64,
    pub patch: Patch,
    /// Ops that undo this change, in the order they must be applied.
    pub inverse: Vec<Op>,
}

/// The current state of everything a [`Patch`] names, so a UI mirror can update itself without
/// reading the whole circuit (LLD §10). Removed ids are in the patch itself.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
pub struct PatchData {
    pub rev: u64,
    pub parts: IndexMap<RefDes, PartInstance>,
    pub nets: IndexMap<NetId, Net>,
    pub blocks: IndexMap<BlockId, Block>,
    /// Present when `patch.analyses_changed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyses: Option<Vec<Analysis>>,
    /// Present when `patch.hints_changed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hints: Option<Vec<LayoutHint>>,
}

/// The authoritative circuit for one editor (browser) or one job (server).
#[derive(Clone, Debug)]
pub struct Session {
    reg: Arc<Registry>,
    circuit: Circuit,
}

impl Session {
    /// Start empty, or from a snapshot, which must pass every structural invariant.
    pub fn new(reg: Arc<Registry>, snapshot: Option<Circuit>) -> Result<Session, Vec<OpError>> {
        let circuit = snapshot.unwrap_or_else(|| Circuit::new(reg.version.clone()));
        let errs = validate(&circuit, &reg);
        if errs.is_empty() { Ok(Session { reg, circuit }) } else { Err(errs) }
    }

    pub fn circuit(&self) -> &Circuit {
        &self.circuit
    }

    pub fn registry(&self) -> &Arc<Registry> {
        &self.reg
    }

    pub fn apply(&mut self, env: &OpEnvelope) -> Result<ApplyOk, OpError> {
        let a = apply(&self.circuit, &self.reg, env)?;
        self.circuit = a.circuit;
        Ok(ApplyOk { rev: self.circuit.rev, patch: a.patch, inverse: a.inverse })
    }

    /// Apply bare ops atomically, e.g. an undo or redo step.
    pub fn apply_ops(&mut self, ops: &[Op], author: Author) -> Result<ApplyOk, OpError> {
        let (next, inverse) = apply_ops(&self.circuit, &self.reg, ops, author, None)?;
        let patch = Patch::diff(&self.circuit, &next);
        self.circuit = next;
        Ok(ApplyOk { rev: self.circuit.rev, patch, inverse })
    }

    /// The current parts, nets and blocks a patch upserted (ids no longer present are skipped).
    pub fn changes(&self, patch: &Patch) -> PatchData {
        fn pick<V: Clone>(map: &IndexMap<String, V>, ids: &[String]) -> IndexMap<String, V> {
            ids.iter().filter_map(|id| map.get(id).map(|v| (id.clone(), v.clone()))).collect()
        }
        let c = &self.circuit;
        PatchData {
            rev: c.rev,
            parts: pick(&c.parts, &patch.parts_upserted),
            nets: pick(&c.nets, &patch.nets_upserted),
            blocks: pick(&c.blocks, &patch.blocks_upserted),
            analyses: patch.analyses_changed.then(|| c.analyses.clone()),
            hints: patch.hints_changed.then(|| c.hints.clone()),
        }
    }

    /// A scratch copy sharing the registry (scrubbing, trial edits).
    pub fn fork(&self) -> Session {
        self.clone()
    }

    pub fn erc(&self, ctx: ErcContext, scope: Option<&str>) -> Vec<ErcIssue> {
        erc(&self.circuit, &self.reg, ctx, scope)
    }

    pub fn compile(&self, opts: &CompileOpts) -> Result<Netlist, CompileError> {
        compile(&self.circuit, &self.reg, opts)
    }

    pub fn circuit_text(&self) -> String {
        crate::describe::circuit_text(&self.circuit, &self.reg)
    }

    /// The refdes a new `part` gets ([`edit::next_refdes`]).
    pub fn next_refdes(&self, part: &str) -> Result<RefDes, OpError> {
        edit::next_refdes(&self.circuit, &self.reg, part)
    }

    /// Ops for a wire from `from` to `to` ([`edit::connect`]); apply them as one batch.
    pub fn connect(&self, from: &PinRef, to: &WireEnd) -> Result<Vec<Op>, OpError> {
        edit::connect(&self.circuit, &self.reg, from, to)
    }

    /// Solved values and spec for inserting a template block ([`template::preview`]).
    pub fn preview_block(&self, req: &InsertBlock) -> Result<Preview, OpError> {
        template::preview(&self.circuit, &self.reg, req)
    }

    /// Ops that insert a template block ([`template::instantiate`]); apply them as one batch with
    /// author `template`.
    pub fn insert_block(&self, req: &InsertBlock) -> Result<Inserted, OpError> {
        template::instantiate(&self.circuit, &self.reg, req)
    }
}

/// JSON-in, JSON-out API used by the language bindings. Every fallible call returns
/// `{"ok": …}` or `{"err": …}`: a rejected op is an expected outcome, not an exception.
pub mod json_api {
    use super::*;
    use crate::apply::apply_all as core_apply_all;
    use crate::ops::envelope_from_value;
    use crate::units::{Unit, parse_quantity as core_parse_quantity};

    #[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
    #[serde(rename_all = "lowercase")]
    pub enum Outcome<T, E> {
        Ok(T),
        Err(E),
    }

    fn to_json<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).expect("core types always serialize")
    }

    fn outcome<T: Serialize, E: Serialize>(r: Result<T, E>) -> String {
        to_json(&match r {
            Ok(v) => Outcome::Ok(v),
            Err(e) => Outcome::Err(e),
        })
    }

    fn schema_err(what: &str, e: impl std::fmt::Display) -> OpError {
        OpError::new(ErrorCode::SchemaError, format!("{what}: {e}"))
    }

    fn parse<T: serde::de::DeserializeOwned>(what: &str, json: &str) -> Result<T, OpError> {
        serde_json::from_str(json).map_err(|e| schema_err(what, e))
    }

    /// Load a registry bundle. Err is a list of `RegistryError` messages.
    pub fn load_registry(bundle_json: &str) -> Result<Arc<Registry>, String> {
        Registry::from_json(bundle_json)
            .map(Arc::new)
            .map_err(|errs| to_json(&errs.iter().map(|e| e.to_string()).collect::<Vec<_>>()))
    }

    /// New session from an optional snapshot. Err is a JSON list of `OpError`.
    pub fn new_session(reg: Arc<Registry>, snapshot_json: Option<&str>) -> Result<Session, String> {
        let snapshot = match snapshot_json {
            Some(s) => Some(parse::<Circuit>("snapshot", s).map_err(|e| to_json(&vec![e]))?),
            None => None,
        };
        Session::new(reg, snapshot).map_err(|errs| to_json(&errs))
    }

    /// One envelope → `Outcome<ApplyOk, OpError>`.
    pub fn apply(s: &mut Session, envelope_json: &str) -> String {
        let r = serde_json::from_str::<serde_json::Value>(envelope_json)
            .map_err(|e| schema_err("envelope", e))
            .and_then(envelope_from_value)
            .and_then(|env| s.apply(&env));
        outcome(r)
    }

    /// Bare ops (`[Op]`) applied atomically by `author` → `Outcome<ApplyOk, OpError>`.
    pub fn apply_ops(s: &mut Session, ops_json: &str, author: &str) -> String {
        let r = parse::<Vec<Op>>("ops", ops_json).and_then(|ops| {
            let author: Author = parse("author", &to_json(&author))?;
            s.apply_ops(&ops, author)
        });
        outcome(r)
    }

    /// Trial batch for the orchestrator: `[OpEnvelope]` against the session's circuit, which is
    /// left untouched → `Outcome<Trial, OpError>`. Every rejected op — malformed ones included —
    /// is listed in `trial.errors` with its `op_index`, so one repair round sees all mistakes.
    pub fn apply_all(s: &Session, envelopes_json: &str) -> String {
        let r = parse::<Vec<serde_json::Value>>("envelopes", envelopes_json).map(|vals| {
            let mut envs = Vec::new();
            let mut index = Vec::new(); // position in `envs` -> position in the batch
            let mut errors = Vec::new();
            for (i, v) in vals.into_iter().enumerate() {
                match envelope_from_value(v) {
                    Ok(e) => {
                        envs.push(e);
                        index.push(i);
                    }
                    Err(mut e) => {
                        e.op_index = Some(i);
                        errors.push(e);
                    }
                }
            }
            let mut trial = core_apply_all(s.circuit(), s.registry(), &envs);
            for e in &mut trial.errors {
                e.op_index = e.op_index.map(|k| index[k]);
            }
            trial.errors.extend(errors);
            trial.errors.sort_by_key(|e| e.op_index);
            trial
        });
        outcome(r)
    }

    /// `ctx` is `"llm_block"` or `"user_edit"` → `Outcome<[ErcIssue], OpError>`.
    pub fn erc(s: &Session, ctx: &str, scope: Option<&str>) -> String {
        let r = parse::<ErcContext>("erc context", &to_json(&ctx)).map(|ctx| s.erc(ctx, scope));
        outcome(r)
    }

    /// `opts_json` is a `CompileOpts` (`{}` for defaults) → `Outcome<Netlist, CompileError>`.
    pub fn compile(s: &Session, opts_json: &str) -> String {
        let r = serde_json::from_str::<CompileOpts>(opts_json)
            .map_err(|e| CompileError { refdes: None, message: format!("compile options: {e}") })
            .and_then(|opts| s.compile(&opts));
        outcome(r)
    }

    /// `part` is a registry id → `Outcome<RefDes, OpError>`.
    pub fn next_refdes(s: &Session, part: &str) -> String {
        outcome(s.next_refdes(part))
    }

    /// `from` is a `PinRef` string, `to_json` a `WireEnd` → `Outcome<[Op], OpError>`.
    pub fn connect(s: &Session, from: &str, to_json: &str) -> String {
        let r = from
            .parse::<PinRef>()
            .map_err(|e| schema_err("from", e))
            .and_then(|from| s.connect(&from, &parse::<WireEnd>("to", to_json)?));
        outcome(r)
    }

    /// `req_json` is an `InsertBlock` → `Outcome<Preview, OpError>`.
    pub fn preview_block(s: &Session, req_json: &str) -> String {
        outcome(parse::<InsertBlock>("insert block", req_json).and_then(|r| s.preview_block(&r)))
    }

    /// `req_json` is an `InsertBlock` → `Outcome<Inserted, OpError>`.
    pub fn insert_block(s: &Session, req_json: &str) -> String {
        outcome(parse::<InsertBlock>("insert block", req_json).and_then(|r| s.insert_block(&r)))
    }

    /// `checks_json` is `Netlist.checks`, `meas_json` the result's `meas` (name -> value)
    /// → `Outcome<[CheckResult], OpError>`.
    pub fn evaluate_checks(checks_json: &str, meas_json: &str) -> String {
        let r = parse::<Vec<template::SpecCheckDef>>("checks", checks_json).and_then(|defs| {
            let meas: std::collections::BTreeMap<String, f64> = parse("meas", meas_json)?;
            Ok(template::evaluate_checks(&defs, &meas))
        });
        outcome(r)
    }

    /// The 5 points CI verifies a template at → `Outcome<[VerifyPoint], OpError>`.
    pub fn verify_points(reg: &Registry, template_id: &str) -> String {
        let r = reg
            .templates
            .get(template_id)
            .map(template::verify_points)
            .ok_or_else(|| OpError::new(ErrorCode::TemplateNotFound, format!("no block template {template_id}")));
        outcome(r)
    }

    pub fn snapshot(s: &Session) -> String {
        to_json(s.circuit())
    }

    /// `patch_json` is a `Patch` (from an `ApplyOk`) → `Outcome<PatchData, OpError>`.
    pub fn changes(s: &Session, patch_json: &str) -> String {
        outcome(parse::<Patch>("patch", patch_json).map(|p| s.changes(&p)))
    }

    /// For value fields in the editor: `unit` is e.g. `"ohm"` → `Outcome<Quantity, String>`.
    pub fn parse_quantity(text: &str, unit: &str) -> String {
        let r = serde_json::from_str::<Unit>(&to_json(&unit))
            .map_err(|e| format!("unit: {e}"))
            .and_then(|u| core_parse_quantity(text, u).map_err(|e| e.to_string()));
        outcome(r)
    }
}

#[cfg(test)]
mod tests {
    use super::json_api::*;
    use super::{Arc, Registry};

    fn reg() -> Arc<Registry> {
        let r: Registry = serde_json::from_value(serde_json::json!({
            "version": "t",
            "parts": {"resistor_th": {
                "id": "resistor_th", "category": "R", "title": "R",
                "pins": [{"name": "1", "num": 1, "type": "passive"}, {"name": "2", "num": 2, "type": "passive"}],
                "params": {"resistance": {"unit": "ohm", "default": "10k", "min": 0.1, "max": 1e9}},
                "spice": {"line": "{refdes} {1} {2} {resistance}"},
                "symbol": "symbols/resistor.svg"}},
            "symbols": {
                "resistor": {"width": 60, "height": 20, "pins": {
                    "1": {"x": 0, "y": 10, "side": "left"}, "2": {"x": 60, "y": 10, "side": "right"}}},
                "flag_ground": {"width": 20, "height": 20, "pins": {"P": {"x": 10, "y": 0, "side": "top"}}},
                "flag_power": {"width": 20, "height": 20, "pins": {"P": {"x": 10, "y": 20, "side": "bottom"}}}
            }
        }))
        .unwrap();
        load_registry(&serde_json::to_string(&r).unwrap()).unwrap()
    }

    #[test]
    fn json_round_trip() {
        let mut s = new_session(reg(), None).unwrap();
        let ok = apply(
            &mut s,
            r#"{"v":1,"seq":1,"op":"part.add","author":"user","base_rev":0,"body":{"refdes":"R1","part":"resistor_th"}}"#,
        );
        let v: serde_json::Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["ok"]["rev"], 1);
        assert_eq!(v["ok"]["patch"]["parts_upserted"][0], "R1");
        let data: serde_json::Value = serde_json::from_str(&changes(&s, &v["ok"]["patch"].to_string())).unwrap();
        assert_eq!(data["ok"]["rev"], 1);
        assert_eq!(data["ok"]["parts"]["R1"]["params"]["resistance"]["display"], "10kΩ");
        assert!(data["ok"]["nets"].as_object().unwrap().is_empty());
        assert!(data["ok"].get("analyses").is_none());
        assert!(changes(&s, "{}").contains("schema_error"));

        let err = apply(&mut s, r#"{"v":1,"seq":2,"op":"part.add","author":"user","base_rev":0,"body":{}}"#);
        assert!(err.starts_with(r#"{"err":{"code":"schema_error""#), "{err}");
        let stale =
            apply(&mut s, r#"{"v":1,"seq":2,"op":"part.remove","author":"user","base_rev":0,"body":{"refdes":"R1"}}"#);
        assert!(stale.contains(r#""code":"stale_rev""#));

        let inverse = v["ok"]["inverse"].to_string();
        let undo: serde_json::Value = serde_json::from_str(&apply_ops(&mut s, &inverse, "user")).unwrap();
        assert_eq!(undo["ok"]["patch"]["parts_removed"][0], "R1");
        assert!(apply_ops(&mut s, "[]", "robot").contains("schema_error"));

        let restored = new_session(reg(), Some(&snapshot(&s))).unwrap();
        assert_eq!(restored.circuit(), s.circuit());
        assert!(erc(&s, "user_edit", None).starts_with(r#"{"ok":[]"#));
        assert!(erc(&s, "nope", None).contains("schema_error"));
        assert!(compile(&s, "{}").contains(".op"));
        assert!(parse_quantity("4k7", "ohm").contains(r#""display":"4.7kΩ""#));
        assert!(parse_quantity("4k7", "parsec").starts_with(r#"{"err""#));

        assert_eq!(next_refdes(&s, "resistor_th"), r#"{"ok":"R1"}"#);
        assert!(next_refdes(&s, "flux_capacitor").contains("part_not_in_registry"));
        assert!(connect(&s, "R1", r#"{"pin":"R2.1"}"#).contains("schema_error"));
        assert!(connect(&s, "R1.1", r#"{"wire":"x"}"#).contains("schema_error"));
    }

    #[test]
    fn apply_all_reports_malformed_ops_in_place() {
        let s = new_session(reg(), None).unwrap();
        let add = |seq: u32| {
            format!(
                r#"{{"v":1,"seq":{seq},"op":"part.add","author":"llm","base_rev":0,"body":{{"refdes":"R2","part":"resistor_th"}}}}"#
            )
        };
        let batch = format!(
            r#"[{{"v":1,"seq":1,"op":"part.explode","author":"llm","base_rev":0,"body":{{}}}},{},{}]"#,
            add(2),
            add(3)
        );
        let v: serde_json::Value = serde_json::from_str(&apply_all(&s, &batch)).unwrap();
        let errs: Vec<(u64, &str)> = v["ok"]["errors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e["op_index"].as_u64().unwrap(), e["code"].as_str().unwrap()))
            .collect();
        assert_eq!(errs, [(0, "unknown_op"), (2, "refdes_conflict")]);
        assert!(v["ok"]["circuit"]["parts"]["R2"].is_object());
        assert_eq!(s.circuit().rev, 0, "the session itself is untouched");
    }
}
