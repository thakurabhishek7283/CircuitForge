// Generate (LLD §5, §6): the learner describes a circuit; the job's progress follows its blocks as
// they are planned, composed, checked, repaired and committed, with cancel, retry on errors that
// are worth retrying, and the animation's speed, pause and skip.
import { useState } from "react";
import type { GenerateMode, JobState, LearnerLevel } from "../gen/contract.ts";
import { type PlanItem, SPEEDS } from "../store/generationStore.ts";
import { useEditor, useGen } from "./editorContext.ts";

const STATE_TEXT: Partial<Record<JobState, string>> = {
  queued: "Starting…",
  planning: "Planning the blocks…",
  composing: "Designing",
  verifying: "Checking",
  repairing: "Fixing a wiring issue in",
  fallback: "Using the standard design for",
  committing: "Adding",
};

const ERROR_TEXT: Record<string, string> = {
  offline: "The server cannot be reached.",
  generation_unavailable: "Generation is not available on this server right now.",
  job_running: "A generation is already running on this circuit.",
  unsupported_request: "That needs something the block library cannot build yet.",
  plan_invalid: "No workable plan came out this time.",
  llm_unavailable: "The model is not answering.",
  job_timeout: "Generation took too long.",
  job_lost: "The server running this generation stopped.",
  server_shutdown: "The server restarted during generation.",
  sim_unavailable: "The simulator is not available.",
};

const STATUS_MARK: Record<PlanItem["status"], string> = { waiting: "○", building: "◐", committed: "●", discarded: "✕" };

export function GeneratePanel() {
  const { project, gen } = useEditor();
  const phase = useGen((s) => s.phase);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<GenerateMode>("compose");
  const [level, setLevel] = useState<LearnerLevel>("beginner");
  const busy = phase === "starting" || phase === "running";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (text && project && !busy) void project.generate({ prompt: text, mode, level });
  };

  return (
    <section className="generate" aria-label="Generate a circuit">
      <form onSubmit={submit}>
        <input
          type="text"
          className="prompt"
          aria-label="Describe a circuit"
          placeholder={project ? "Describe a circuit, e.g. a 1 kHz low-pass filter driven by a sine source" : "Generation needs a saved project: press New"}
          value={prompt}
          maxLength={2000}
          disabled={!project || busy}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <select aria-label="How blocks are built" value={mode} disabled={!project || busy} onChange={(e) => setMode(e.target.value as GenerateMode)}>
          <option value="compose">Design each block</option>
          <option value="templates">Standard blocks only</option>
        </select>
        <select aria-label="Level" value={level} disabled={!project || busy} onChange={(e) => setLevel(e.target.value as LearnerLevel)}>
          <option value="beginner">Beginner</option>
          <option value="intermediate">Intermediate</option>
          <option value="advanced">Advanced</option>
        </select>
        <button type="submit" className="primary" disabled={!project || busy || !prompt.trim()}>
          Generate
        </button>
      </form>
      {phase !== "idle" && <Progress onDismiss={() => gen.getState().dismiss()} />}
    </section>
  );
}

function Progress({ onDismiss }: { onDismiss: () => void }) {
  const { project, gen } = useEditor();
  const phase = useGen((s) => s.phase);
  const state = useGen((s) => s.state);
  const block = useGen((s) => s.block);
  const plan = useGen((s) => s.plan);
  const error = useGen((s) => s.error);
  const stream = useGen((s) => s.stream);
  const speed = useGen((s) => s.speed);
  const paused = useGen((s) => s.paused);
  const skipping = useGen((s) => s.skipping);
  const running = phase === "running" || phase === "starting";
  const retryable = useGen((s) => !!s.job?.request.prompt);
  const title = plan.find((p) => p.id === block)?.title;

  let status: string;
  if (phase === "starting") status = "Starting…";
  else if (phase === "running") status = state && STATE_TEXT[state] ? `${STATE_TEXT[state]}${title && state !== "planning" && state !== "queued" ? ` ${title}…` : ""}` : "Working…";
  else if (phase === "done") status = `Done: ${plan.filter((p) => p.status === "committed").length} block(s) added.`;
  else if (phase === "cancelled") status = "Cancelled. The blocks already added stay.";
  else status = error ? (ERROR_TEXT[error.code] ?? "Generation failed.") : "Generation failed.";

  // The server's message often starts with what the status already says: show only the rest.
  const lead = status.replace(/.$/, "");
  const detail = error?.message.startsWith(lead) ? error.message.slice(lead.length).replace(/^[:.]s*/, "") : error?.message;

  return (
    <div className="progress" data-phase={phase} data-state={state ?? ""}>
      <div className="progress-row">
        <span className="status" role="status">
          {status}
          {stream === "reconnecting" && <span className="muted"> (reconnecting…)</span>}
        </span>
        {phase === "failed" && detail && (
          <span className="error-detail" title={error!.message}>
            {detail}
          </span>
        )}
        <span className="spacer" />
        {running && (
          <>
            <span className="speed" role="group" aria-label="Animation speed">
              {SPEEDS.map((s) => (
                <button key={s} type="button" aria-pressed={speed === s} onClick={() => gen.getState().setSpeed(s)}>
                  {s}×
                </button>
              ))}
            </span>
            <button type="button" aria-pressed={paused} disabled={skipping} onClick={() => gen.getState().setPaused(!paused)}>
              {paused ? "Resume" : "Pause"}
            </button>
            <button type="button" disabled={skipping} onClick={() => gen.getState().setSkipping(true)} title="Show the rest without animating">
              Skip
            </button>
            <button type="button" className="danger" disabled={phase !== "running"} onClick={() => void project?.cancel()}>
              Cancel
            </button>
          </>
        )}
        {/* A job joined after a reload has no prompt here to send again. */}
        {phase === "failed" && error?.retryable && retryable && (
          <button type="button" className="primary" onClick={() => void project?.retry()}>
            Retry
          </button>
        )}
        {!running && (
          <button type="button" className="link" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      {plan.length > 0 && (
        <ol className="plan">
          {plan.map((p) => (
            <li key={p.id} data-block={p.id} data-status={p.status}>
              <span className="mark" aria-hidden="true">
                {STATUS_MARK[p.status]}
              </span>
              {p.title}
              {p.repairs > 0 && <span className="repairs"> · {p.repairs} fix{p.repairs === 1 ? "" : "es"}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
