//! Wire protocol (LLD §5): REST bodies and the generation job's event stream. Pure types; the API
//! (generated Pydantic models) and the browser (generated TS) both speak them, so a change here
//! is a contract change that codegen and CI see.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ir::{BlockId, BlockRole, Circuit, PortDirection};
use crate::ops::OpEnvelope;
use crate::template::CheckResult;

/// A generation job's state (LLD §6). `failed` and `cancelled` can follow any other state.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Planning,
    Composing,
    Verifying,
    Repairing,
    Fallback,
    Committing,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn is_final(self) -> bool {
        matches!(self, JobState::Done | JobState::Failed | JobState::Cancelled)
    }
}

/// One event on `GET /v1/jobs/{id}/events`. On the wire, `event` is the SSE event name, `data`
/// its JSON, and the event's sequence number its SSE `id`, which a reconnect resumes from.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "event", content = "data")]
pub enum JobEvent {
    #[serde(rename = "job.state")]
    State(JobStateData),
    #[serde(rename = "narration.delta")]
    Narration(NarrationData),
    /// A dashed placeholder for a planned block.
    #[serde(rename = "block.ghost")]
    Ghost(GhostData),
    /// One op of a verified block: validate locally, then animate.
    #[serde(rename = "op")]
    Op(OpEnvelope),
    #[serde(rename = "block.repair")]
    Repair(RepairData),
    /// Spec checks of a committed block, measured in its verification bench.
    #[serde(rename = "sim.summary")]
    SimSummary(SimSummaryData),
    #[serde(rename = "error")]
    Error(ApiError),
    /// The job finished: the editor unlocks.
    #[serde(rename = "done")]
    Done(DoneData),
    /// Every 15 s while the job runs; resets the client's stall timer.
    #[serde(rename = "heartbeat")]
    Heartbeat,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct JobStateData {
    pub state: JobState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockId>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct NarrationData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockId>,
    pub text: String,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct GhostData {
    pub id: BlockId,
    pub title: String,
    pub role: BlockRole,
    pub ports: Vec<GhostPort>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct GhostPort {
    pub name: String,
    pub direction: PortDirection,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct RepairData {
    pub id: BlockId,
    /// The attempt that failed, from 1.
    pub attempt: u8,
    /// Its problem codes (`pin_not_found`, `floating_pin`, `spec_miss`, ...).
    pub errors: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct SimSummaryData {
    pub block: BlockId,
    pub checks: Vec<CheckResult>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct DoneData {
    pub rev: u64,
    pub usage: Usage,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub in_tokens: u64,
    pub out_tokens: u64,
}

/// Every error body and the stream's `error` event: `code` is stable (`stale_rev`,
/// `not_found`, `rate_limited`, ...), `message` is for people.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

// ---------------------------------------------------------------- REST

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct AnonymousSession {
    /// Bearer token for `Authorization`.
    pub token: String,
    pub user_id: String,
    /// Seconds until the token expires.
    pub expires_in: u64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CreateProject {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct Project {
    pub id: String,
    pub title: String,
    /// Fixed for the project's life: symbols, pin maps and models never change silently.
    pub registry_version: String,
    pub head_rev: u64,
    /// RFC 3339.
    pub created_at: String,
    pub updated_at: String,
}

/// `GET /v1/projects/{id}`: everything an editor opens.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct ProjectSnapshot {
    pub project: Project,
    /// At `project.head_rev`.
    pub circuit: Circuit,
    pub lesson: Vec<LessonEntry>,
    /// A generation job still running on this project, if any (the editor stays read-only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_job: Option<String>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LessonKind {
    Narration,
    Note,
    Repair,
}

/// One line of a project's lesson track: narration and notes, replayable with their blocks.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct LessonEntry {
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<BlockId>,
    pub kind: LessonKind,
    pub text: String,
    #[serde(default)]
    pub refs: Vec<String>,
}

/// `POST /v1/projects/{id}/ops`: user ops since `base_rev`, applied in order. A mismatched
/// `base_rev` is 409 `stale_rev`, and the client reloads the snapshot.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppendOps {
    pub base_rev: u64,
    pub ops: Vec<OpEnvelope>,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq)]
pub struct AppendOk {
    pub rev: u64,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LearnerLevel {
    #[default]
    Beginner,
    Intermediate,
    Advanced,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GenerateMode {
    /// Blocks are composed by the model and fall back to templates.
    #[default]
    Compose,
    /// Every block is a template at targets: what the spend breaker switches to (LLD §13).
    Templates,
}

/// `POST /v1/projects/{id}/generate`.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct GenerateRequest {
    pub prompt: String,
    #[serde(default)]
    pub mode: GenerateMode,
    #[serde(default)]
    pub level: LearnerLevel,
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
pub struct JobAccepted {
    pub job_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_adjacently_tagged() {
        let e = JobEvent::State(JobStateData { state: JobState::Planning, block: None });
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"event":"job.state","data":{"state":"planning"}}"#);
        assert_eq!(serde_json::to_string(&JobEvent::Heartbeat).unwrap(), r#"{"event":"heartbeat"}"#);
        let back: JobEvent =
            serde_json::from_str(r#"{"event":"done","data":{"rev":7,"usage":{"in_tokens":1,"out_tokens":2}}}"#)
                .unwrap();
        assert_eq!(back, JobEvent::Done(DoneData { rev: 7, usage: Usage { in_tokens: 1, out_tokens: 2 } }));
    }
}
