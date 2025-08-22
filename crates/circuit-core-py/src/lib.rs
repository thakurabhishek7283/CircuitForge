//! Python facade over circuit-core, imported as `circuit_core._native` and re-exported by the
//! `circuit_core` package. Same JSON-string API as the WASM build (both wrap
//! `circuit_core::session::json_api`), so the API server and the browser cannot disagree.
//!
//! Heavy calls release the GIL so the FastAPI event loop keeps serving while a trial batch,
//! ERC or compile runs (LLD §6).

use std::sync::Arc;

use circuit_core::Registry as CoreRegistry;
use circuit_core::session::{Session as CoreSession, json_api as api};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

/// A loaded, validated part registry. Load once per process and share across sessions.
#[pyclass(frozen, module = "circuit_core")]
struct Registry {
    inner: Arc<CoreRegistry>,
}

#[pymethods]
impl Registry {
    /// Load the compiled JSON bundle. Raises ValueError (JSON list of problems) if invalid.
    #[staticmethod]
    fn from_json(bundle: &str) -> PyResult<Registry> {
        api::load_registry(bundle).map(|inner| Registry { inner }).map_err(PyValueError::new_err)
    }

    /// Load YAML part sources and SVG symbol sources: `[(file_name, text), ...]` each, symbols
    /// named `<id>.svg`. The caller reads the files; circuit-core never touches the filesystem.
    #[staticmethod]
    fn from_yaml_docs(
        version: &str,
        docs: Vec<(String, String)>,
        symbols: Vec<(String, String)>,
    ) -> PyResult<Registry> {
        CoreRegistry::from_yaml_docs(
            version,
            docs.iter().map(|(n, t)| (n.as_str(), t.as_str())),
            symbols.iter().map(|(n, t)| (n.as_str(), t.as_str())),
        )
        .map(|r| Registry { inner: Arc::new(r) })
        .map_err(|errs| PyValueError::new_err(errs.iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n")))
    }

    #[getter]
    fn version(&self) -> String {
        self.inner.version.clone()
    }

    /// The JSON bundle the browser loads.
    fn to_json(&self) -> String {
        serde_json_string(&*self.inner)
    }

    /// Ids of every part, in registry order.
    fn part_ids(&self) -> Vec<String> {
        self.inner.parts.keys().cloned().collect()
    }
}

fn serde_json_string<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("core types always serialize")
}

/// The authoritative circuit for one job or project. Results are JSON strings shaped
/// `{"ok": ...}` or `{"err": ...}`; see `contract/schema/`.
#[pyclass(module = "circuit_core")]
struct Session {
    inner: CoreSession,
}

#[pymethods]
impl Session {
    /// Empty circuit, or a snapshot (`Circuit` JSON). Raises ValueError (JSON list of
    /// `OpError`) if the snapshot breaks an invariant.
    #[new]
    #[pyo3(signature = (registry, snapshot=None))]
    fn new(registry: &Registry, snapshot: Option<&str>) -> PyResult<Session> {
        api::new_session(registry.inner.clone(), snapshot).map(|inner| Session { inner }).map_err(PyValueError::new_err)
    }

    /// Apply one `OpEnvelope` → `{"ok": ApplyOk} | {"err": OpError}`.
    fn apply(&mut self, py: Python<'_>, envelope: &str) -> String {
        let inner = &mut self.inner;
        py.detach(|| api::apply(inner, envelope))
    }

    /// Apply bare `Op[]` atomically (undo/redo) → `{"ok": ApplyOk} | {"err": OpError}`.
    fn apply_ops(&mut self, py: Python<'_>, ops: &str, author: &str) -> String {
        let inner = &mut self.inner;
        py.detach(|| api::apply_ops(inner, ops, author))
    }

    /// Trial a batch without changing this session → `{"ok": Trial} | {"err": OpError}`.
    fn apply_all(&self, py: Python<'_>, envelopes: &str) -> String {
        let inner = &self.inner;
        py.detach(|| api::apply_all(inner, envelopes))
    }

    /// `ctx`: `"llm_block"` or `"user_edit"` → `{"ok": [ErcIssue]} | {"err": OpError}`.
    #[pyo3(signature = (ctx, scope=None))]
    fn erc(&self, py: Python<'_>, ctx: &str, scope: Option<&str>) -> String {
        let inner = &self.inner;
        py.detach(|| api::erc(inner, ctx, scope))
    }

    /// `opts`: `CompileOpts` JSON → `{"ok": Netlist} | {"err": CompileError}`.
    #[pyo3(signature = (opts="{}"))]
    fn compile(&self, py: Python<'_>, opts: &str) -> String {
        let inner = &self.inner;
        py.detach(|| api::compile(inner, opts))
    }

    /// The current data behind a `Patch` from an `ApplyOk` → `{"ok": PatchData} | {"err": OpError}`.
    fn changes(&self, patch: &str) -> String {
        api::changes(&self.inner, patch)
    }

    /// The refdes a new instance of registry part `part` gets → `{"ok": str} | {"err": OpError}`.
    fn next_refdes(&self, part: &str) -> String {
        api::next_refdes(&self.inner, part)
    }

    /// Ops for a wire from pin `from_pin` to `to` (`WireEnd` JSON) → `{"ok": [Op]} | {"err": OpError}`.
    fn connect(&self, from_pin: &str, to: &str) -> String {
        api::connect(&self.inner, from_pin, to)
    }

    /// The full `Circuit` JSON.
    fn snapshot(&self) -> String {
        api::snapshot(&self.inner)
    }

    /// Compact netlist text for LLM prompts (LLD §6).
    fn circuit_text(&self) -> String {
        self.inner.circuit_text()
    }

    #[getter]
    fn rev(&self) -> u64 {
        self.inner.circuit().rev
    }

    /// An independent copy sharing the registry (trial edits).
    fn fork(&self) -> Session {
        Session { inner: self.inner.fork() }
    }
}

/// `parse_quantity("4k7", "ohm")` → `{"ok": Quantity} | {"err": str}`.
#[pyfunction]
fn parse_quantity(text: &str, unit: &str) -> String {
    api::parse_quantity(text, unit)
}

/// circuit-core version, for client/server skew checks.
#[pyfunction]
fn core_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[pymodule]
#[pyo3(name = "_native")]
fn native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Registry>()?;
    m.add_class::<Session>()?;
    m.add_function(wrap_pyfunction!(parse_quantity, m)?)?;
    m.add_function(wrap_pyfunction!(core_version, m)?)?;
    Ok(())
}
