// What the generate UI shows (LLD §5, §10): the job's progress, its ghosts (planned blocks not yet
// committed), the narration as it streams and the project's lesson, and the playback controls.
// The AnimationDirector writes it in the order the events play; components read it.
import { createStore, type StoreApi } from "zustand/vanilla";
import { immer } from "zustand/middleware/immer";
import type { ApiError, GenerateRequest, GhostData, JobState, LessonEntry, RepairData } from "../gen/contract.ts";
import type { StreamStatus } from "../stream/jobStream.ts";

export interface GhostView extends GhostData {
  /** The job's state for this block (composing, verifying, repairing, fallback, committing). */
  state: JobState | null;
  repairs: RepairData[];
}

export interface PlanItem {
  id: string;
  title: string;
  status: "waiting" | "building" | "committed" | "discarded";
  repairs: number;
}

export interface NarrationLine {
  block: string | null;
  text: string;
}

export type Phase = "idle" | "starting" | "running" | "done" | "failed" | "cancelled";

export interface GenerationState {
  job: { id: string; request: GenerateRequest } | null;
  phase: Phase;
  /** The last `job.state` and its block. */
  state: JobState | null;
  block: string | null;
  ghosts: Record<string, GhostView>;
  plan: PlanItem[];
  /** This job's narration, as it arrives. */
  narration: NarrationLine[];
  /** The project's saved lesson track. */
  lesson: LessonEntry[];
  error: ApiError | null;
  stream: StreamStatus | null;
  speed: number;
  paused: boolean;
  /** Skip to end: the rest of this job is applied without animation. */
  skipping: boolean;
  /** The block whose narration is playing (highlighted on the schematic). */
  speaking: string | null;

  start(request: GenerateRequest): void;
  started(jobId: string, request: GenerateRequest | null): void;
  setState(state: JobState, block: string | null): void;
  narrate(block: string | null, text: string): void;
  addGhost(g: GhostData): void;
  repair(r: RepairData): void;
  /** The block's ops have been applied: its ghost gives way to the real frame. */
  committed(block: string, title: string): void;
  /** The job ended: uncommitted ghosts are discarded. */
  finish(phase: "done" | "failed" | "cancelled", error?: ApiError | null): void;
  /** A request that never became a job (refused, offline). */
  refused(error: ApiError): void;
  setLesson(lesson: LessonEntry[]): void;
  setStream(s: StreamStatus | null): void;
  setSpeed(speed: number): void;
  setPaused(paused: boolean): void;
  setSkipping(skipping: boolean): void;
  setSpeaking(block: string | null): void;
  dismiss(): void;
}

export type GenerationStore = StoreApi<GenerationState>;

export const SPEEDS = [0.5, 1, 2, 4] as const;

export function createGenerationStore(): GenerationStore {
  return createStore<GenerationState>()(
    immer((set) => ({
      job: null,
      phase: "idle",
      state: null,
      block: null,
      ghosts: {},
      plan: [],
      narration: [],
      lesson: [],
      error: null,
      stream: null,
      speed: 1,
      paused: false,
      skipping: false,
      speaking: null,

      start: (request) =>
        set((s) => {
          s.job = { id: "", request };
          s.phase = "starting";
          s.state = null;
          s.block = null;
          s.ghosts = {};
          s.plan = [];
          s.narration = [];
          s.error = null;
          s.skipping = false;
          s.paused = false;
        }),

      started: (jobId, request) =>
        set((s) => {
          if (!s.job || s.phase !== "starting") {
            // Joining a job that was already running (a reload): nothing of it is shown yet.
            s.ghosts = {};
            s.plan = [];
            s.narration = [];
            s.error = null;
            s.skipping = false;
          }
          s.job = { id: jobId, request: request ?? s.job?.request ?? { prompt: "" } };
          s.phase = "running";
        }),

      setState: (state, block) =>
        set((s) => {
          s.state = state;
          s.block = block;
          const g = block ? s.ghosts[block] : undefined;
          if (g) g.state = state;
          const item = s.plan.find((p) => p.id === block);
          if (item && item.status === "waiting") item.status = "building";
        }),

      narrate: (block, text) =>
        set((s) => {
          const last = s.narration.at(-1);
          if (last && last.block === block) last.text += text;
          else s.narration.push({ block, text });
        }),

      addGhost: (g) =>
        set((s) => {
          s.ghosts[g.id] = { ...g, state: null, repairs: [] };
          if (!s.plan.some((p) => p.id === g.id)) s.plan.push({ id: g.id, title: g.title, status: "waiting", repairs: 0 });
        }),

      repair: (r) =>
        set((s) => {
          s.ghosts[r.id]?.repairs.push(r);
          const item = s.plan.find((p) => p.id === r.id);
          if (item) item.repairs = r.attempt;
        }),

      committed: (block, title) =>
        set((s) => {
          delete s.ghosts[block];
          const item = s.plan.find((p) => p.id === block);
          if (item) item.status = "committed";
          else s.plan.push({ id: block, title, status: "committed", repairs: 0 });
        }),

      finish: (phase, error = null) =>
        set((s) => {
          s.phase = phase;
          s.error = error;
          s.ghosts = {};
          for (const p of s.plan) if (p.status !== "committed") p.status = "discarded";
          s.paused = false;
          s.speaking = null;
        }),

      refused: (error) =>
        set((s) => {
          s.phase = "failed";
          s.error = error;
        }),

      setLesson: (lesson) =>
        set((s) => {
          s.lesson = lesson;
        }),
      setStream: (stream) =>
        set((s) => {
          s.stream = stream;
        }),
      setSpeed: (speed) =>
        set((s) => {
          s.speed = speed;
        }),
      setPaused: (paused) =>
        set((s) => {
          s.paused = paused;
        }),
      setSkipping: (skipping) =>
        set((s) => {
          s.skipping = skipping;
        }),
      setSpeaking: (speaking) =>
        set((s) => {
          s.speaking = speaking;
        }),
      dismiss: () =>
        set((s) => {
          if (s.phase === "running" || s.phase === "starting") return;
          s.phase = "idle";
          s.error = null;
          s.plan = [];
          s.narration = [];
        }),
    })),
  );
}
