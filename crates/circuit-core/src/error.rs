use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Error codes returned by `apply()`. These go back to the LLM verbatim during repair and are
/// shown to users as friendly text (LLD §4). Additive only within a protocol major version.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    // LLD §4
    PartNotInRegistry,
    PinNotFound,
    PinAlreadyConnected,
    ParamOutOfRange,
    RefdesConflict,
    BlockNotOpen,
    StaleRev,
    UnknownOp,
    LimitExceeded,
    // Additions needed to make every rejection specific.
    /// Envelope or body does not match the schema.
    SchemaError,
    /// Envelope `v` is not the current or previous protocol version.
    UnsupportedVersion,
    /// Circuit and registry versions differ.
    RegistryMismatch,
    /// Refdes is malformed or its prefix does not match the part category.
    RefdesInvalid,
    PartNotFound,
    ParamUnknown,
    /// A value string could not be parsed in the param's unit.
    BadValue,
    /// Swap target is in a different category.
    CategoryMismatch,
    NetNotFound,
    /// Malformed net id, ground misuse, or a kind/label that disagrees with the existing net.
    NetInvalid,
    /// Net id already exists (case-insensitive, since SPICE node names are).
    NetConflict,
    BlockNotFound,
    BlockConflict,
    /// Block still has parts or hints referring to it.
    BlockNotEmpty,
    HintNotFound,
    /// Analysis parameters are invalid.
    AnalysisInvalid,
    /// The author is not allowed to emit this op (e.g. `part.pin` is user-only).
    Forbidden,
    /// No block template with this id in the registry.
    TemplateNotFound,
    /// A template target or rail voltage is malformed or outside the template's range.
    TargetOutOfRange,
    /// A port binding names a net that cannot carry that port (wrong kind, missing, ground misuse).
    PortInvalid,
    /// The compiler refused a circuit that `apply()` accepted (a generated block's bench).
    CompileFailed,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct OpError {
    pub code: ErrorCode,
    pub message: String,
    /// Index of the failing op within a batch (`apply_all`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op_index: Option<usize>,
}

impl OpError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> OpError {
        OpError { code, message: message.into(), op_index: None }
    }
}

pub(crate) fn err<T>(code: ErrorCode, message: impl Into<String>) -> Result<T, OpError> {
    Err(OpError::new(code, message))
}
