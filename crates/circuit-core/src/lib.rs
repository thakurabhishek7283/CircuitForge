//! circuit-core: the single source of truth for the circuit IR, the op protocol, `apply()`,
//! ERC and the SPICE compiler (LLD §2–§4, §7, §8). Shared by the browser (WASM) and the API
//! (PyO3). Pure: no I/O, no clock, no randomness — same input, same output, on every runtime.

pub mod apply;
pub mod describe;
pub mod edit;
pub mod erc;
pub mod error;
pub mod ir;
pub mod ops;
pub mod registry;
pub mod schema;
pub mod session;
pub mod spice;
pub mod symbol;
pub mod units;

pub use apply::{Applied, Patch, Trial, apply, apply_all, apply_ops, validate};
pub use describe::circuit_text;
pub use erc::{ErcContext, ErcIssue, erc};
pub use error::{ErrorCode, OpError};
pub use ir::Circuit;
pub use ops::{Op, OpEnvelope, parse_envelope};
pub use registry::Registry;
pub use session::{ApplyOk, PatchData, Session};
pub use spice::{CompileOpts, Netlist, compile, interactive_analyses};
