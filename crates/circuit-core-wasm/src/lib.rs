//! Browser facade over circuit-core (LLD §10). The authoritative circuit lives in a
//! `CoreSession` in WASM memory; JS only ever receives small JSON results (patches, inverses).
//!
//! Every fallible call returns a JSON string `{"ok": …}` or `{"err": …}` (see
//! `contract/schema/apply_result.schema.json`); a rejected op is an expected outcome, not a throw.
//! Only constructing from a bad registry bundle or snapshot throws.

use std::sync::Arc;

use circuit_core::Registry;
use circuit_core::session::{Session, json_api as api};
use wasm_bindgen::prelude::*;

/// A loaded, validated registry bundle. Load once, share across sessions.
#[wasm_bindgen]
pub struct CoreRegistry {
    inner: Arc<Registry>,
}

#[wasm_bindgen]
impl CoreRegistry {
    /// Throws with a JSON list of problems if the bundle is invalid.
    #[wasm_bindgen(js_name = fromJson)]
    pub fn from_json(bundle: &str) -> Result<CoreRegistry, JsError> {
        api::load_registry(bundle).map(|inner| CoreRegistry { inner }).map_err(|e| JsError::new(&e))
    }

    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        self.inner.version.clone()
    }
}

#[wasm_bindgen]
pub struct CoreSession {
    inner: Session,
}

#[wasm_bindgen]
impl CoreSession {
    /// Empty circuit, or a server snapshot (`Circuit` JSON). Throws with a JSON list of
    /// `OpError` if the snapshot breaks an invariant.
    #[wasm_bindgen(constructor)]
    pub fn new(registry: &CoreRegistry, snapshot: Option<String>) -> Result<CoreSession, JsError> {
        api::new_session(registry.inner.clone(), snapshot.as_deref())
            .map(|inner| CoreSession { inner })
            .map_err(|e| JsError::new(&e))
    }

    /// Apply one `OpEnvelope` → `{"ok": ApplyOk} | {"err": OpError}`.
    pub fn apply(&mut self, envelope: &str) -> String {
        api::apply(&mut self.inner, envelope)
    }

    /// Apply bare `Op[]` atomically (undo/redo) → `{"ok": ApplyOk} | {"err": OpError}`.
    #[wasm_bindgen(js_name = applyOps)]
    pub fn apply_ops(&mut self, ops: &str, author: &str) -> String {
        api::apply_ops(&mut self.inner, ops, author)
    }

    /// Trial a batch without changing this session → `{"ok": Trial} | {"err": OpError}`.
    #[wasm_bindgen(js_name = applyAll)]
    pub fn apply_all(&self, envelopes: &str) -> String {
        api::apply_all(&self.inner, envelopes)
    }

    /// `ctx`: `"llm_block"` or `"user_edit"` → `{"ok": ErcIssue[]} | {"err": OpError}`.
    pub fn erc(&self, ctx: &str, scope: Option<String>) -> String {
        api::erc(&self.inner, ctx, scope.as_deref())
    }

    /// `opts`: `CompileOpts` JSON (`"{}"` for defaults) → `{"ok": Netlist} | {"err": CompileError}`.
    pub fn compile(&self, opts: &str) -> String {
        api::compile(&self.inner, opts)
    }

    /// The current data behind a `Patch` from an `ApplyOk` → `{"ok": PatchData} | {"err": OpError}`.
    /// The store mirrors the core through this: never the whole circuit per op (LLD §10).
    pub fn changes(&self, patch: &str) -> String {
        api::changes(&self.inner, patch)
    }

    /// The refdes a new instance of registry part `part` gets (lowest free number)
    /// → `{"ok": RefDes} | {"err": OpError}`.
    #[wasm_bindgen(js_name = nextRefdes)]
    pub fn next_refdes(&self, part: &str) -> String {
        api::next_refdes(&self.inner, part)
    }

    /// Ops for a wire from pin `from` (`"R1.2"`) to `to` (`WireEnd` JSON: `{"pin": "C1.1"}` or
    /// `{"net": "GND"}`) → `{"ok": Op[]} | {"err": OpError}`. Apply them as one batch.
    pub fn connect(&self, from: &str, to: &str) -> String {
        api::connect(&self.inner, from, to)
    }

    /// The full `Circuit` JSON.
    pub fn snapshot(&self) -> String {
        api::snapshot(&self.inner)
    }

    /// Compact netlist text, as used in LLM prompts.
    #[wasm_bindgen(js_name = circuitText)]
    pub fn circuit_text(&self) -> String {
        self.inner.circuit_text()
    }

    /// Current revision (a JS number; revisions stay far below 2^53).
    #[wasm_bindgen(getter)]
    pub fn rev(&self) -> f64 {
        self.inner.circuit().rev as f64
    }

    /// A scratch copy sharing the registry, for scrubbing and previews.
    pub fn fork(&self) -> CoreSession {
        CoreSession { inner: self.inner.fork() }
    }
}

/// Parse an editor value field: `parseQuantity("4k7", "ohm")` → `{"ok": Quantity} | {"err": string}`.
#[wasm_bindgen(js_name = parseQuantity)]
pub fn parse_quantity(text: &str, unit: &str) -> String {
    api::parse_quantity(text, unit)
}

/// circuit-core version, for the `X-Min-Client` skew check (LLD §14).
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
