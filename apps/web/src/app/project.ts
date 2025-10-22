// One server project open in the editor (LLD §5, §10): user ops synced to its op log, generation
// jobs started, streamed and played by the AnimationDirector, cancelled and retried. The editor is
// read-only while a job runs, including after a reload (`ProjectSnapshot.active_job`). Anything
// that shows this editor and the server disagree reloads the project from the server.
import { createStore, type StoreApi } from "zustand/vanilla";
import { AnimationDirector } from "../anim/director.ts";
import { type ApiClient, ApiFailure } from "../api/client.ts";
import type { ApiError, GenerateRequest, JobEvent, OpEnvelope, ProjectSnapshot } from "../gen/contract.ts";
import type { CircuitStore } from "../store/circuitStore.ts";
import type { GenerationStore } from "../store/generationStore.ts";
import type { PendingStore } from "../store/pending.ts";
import { Sync, type SyncStatus } from "../store/sync.ts";
import { type JobStream, openJobStream } from "../stream/jobStream.ts";

export interface ProjectState {
  id: string;
  title: string;
  sync: SyncStatus;
}

export interface ProjectSession {
  readonly id: string;
  readonly state: StoreApi<ProjectState>;
  readonly director: AnimationDirector;
  generate(req: GenerateRequest): Promise<void>;
  cancel(): Promise<void>;
  /** Run the last request again (after a retryable error). */
  retry(): Promise<void>;
  dispose(): void;
}

export interface OpenProjectOptions {
  api: ApiClient;
  store: CircuitStore;
  gen: GenerationStore;
  snapshot: ProjectSnapshot;
  pending: PendingStore;
  /** Reopen the project from the server, telling the learner why. */
  reload: (notice: string) => void;
  /** Tell the learner something without reloading. */
  notify: (notice: string) => void;
  /** Resolves once the drawing shows `rev`. */
  waitForLayout?: (rev: number) => Promise<void>;
}

/** Resolves when the layout has caught up with `rev`, or after `timeoutMs` (a layout failure must
 * not stall the job's playback). */
export function layoutReached(store: CircuitStore, rev: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (store.getState().layoutRev >= rev) return resolve();
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = store.subscribe((s) => {
      if (s.layoutRev >= rev) done();
    });
  });
}

export async function openProject(opts: OpenProjectOptions): Promise<ProjectSession> {
  const { api, store, gen, snapshot, pending, reload, notify } = opts;
  const id = snapshot.project.id;
  const headRev = snapshot.project.head_rev;

  // Edits made while the server could not be reached, replayed if the project has not moved since.
  let unsent: OpEnvelope[] = [];
  const stored = await pending.get(id);
  if (stored?.envelopes.length) {
    const n = stored.envelopes.length;
    if (stored.baseRev !== headRev || snapshot.active_job) {
      notify(`${n} unsaved edit${n === 1 ? " was" : "s were"} dropped: the project changed on the server since.`);
    } else if (store.getState().applyRemote(stored.envelopes, null).err) {
      // Some may have applied: start again from the server's circuit alone.
      await pending.put(id, { baseRev: headRev, envelopes: [] });
      reload(`${n} unsaved edit${n === 1 ? "" : "s"} could not be applied and were dropped.`);
    } else {
      unsent = stored.envelopes;
    }
    if (!unsent.length) await pending.put(id, { baseRev: headRev, envelopes: [] });
  }

  const state = createStore<ProjectState>()(() => ({
    id,
    title: snapshot.project.title,
    sync: { state: "saved", unsent: 0 },
  }));
  let disposed = false;
  let stream: JobStream | null = null;
  const resync = (why: string) => {
    if (disposed) return;
    console.warn(`resync: ${why}`);
    reload("This circuit was reloaded from the server to stay in step with it.");
  };

  const sync = new Sync({
    store,
    api,
    project: id,
    pending,
    serverRev: headRev,
    unsent,
    onStale: (e) => resync(`sync: ${e.code}: ${e.message}`),
    onStatus: (s) => state.setState({ sync: s }),
  });

  const finished = async (e: Extract<JobEvent, { event: "done" | "error" }>) => {
    stream?.close();
    stream = null;
    gen.getState().setStream(null);
    store.getState().setMode("idle");
    if (e.event === "done") sync.advance(e.data.rev);
    try {
      // The lesson the job wrote, and a check that both sides hold the same circuit.
      const snap = await api.getProject(id);
      if (disposed) return;
      gen.getState().setLesson(snap.lesson);
      if (snap.project.head_rev !== store.getState().rev && !sync.unsent) resync(`server at rev ${snap.project.head_rev}`);
    } catch {
      // offline: the lesson updates on the next load
    }
  };

  const director = new AnimationDirector({
    store,
    gen,
    waitForLayout: opts.waitForLayout ?? ((rev) => layoutReached(store, rev)),
    onResync: resync,
    onApplied: (rev) => sync.advance(rev),
    onFinished: (e) => void finished(e),
  });

  const attach = (jobId: string, request: GenerateRequest | null) => {
    store.getState().setMode("generating");
    gen.getState().started(jobId, request);
    const s = openJobStream({
      url: api.eventsUrl(jobId),
      headers: () => api.authHeaders(),
      onEvent: (e) => director.push(e),
      onStatus: (st) => gen.getState().setStream(st),
    });
    stream = s;
    s.finished.catch((err: unknown) => {
      if (disposed || stream !== s) return;
      // The job (or the session) is gone: end it as failed so the editor unlocks.
      const error: ApiError = err instanceof ApiFailure ? err.error : { code: "internal", message: String(err) };
      director.push({ event: "error", data: error });
    });
  };

  gen.getState().setLesson(snapshot.lesson);
  if (snapshot.active_job) attach(snapshot.active_job, null);

  const generate = async (req: GenerateRequest) => {
    if (store.getState().mode === "generating") return;
    gen.getState().start(req);
    store.getState().setMode("generating"); // no edits between the flush and the job's first read
    try {
      await sync.flush(); // the job plans against the server's circuit: it must have every edit
      const { job_id } = await api.generate(id, req);
      if (disposed) return;
      attach(job_id, req);
    } catch (e) {
      store.getState().setMode("idle");
      gen.getState().refused(e instanceof ApiFailure ? e.error : { code: "internal", message: String(e) });
    }
  };

  return {
    id,
    state,
    director,
    generate,
    async cancel() {
      const job = gen.getState().job;
      if (!job?.id || gen.getState().phase !== "running") return;
      try {
        await api.cancel(job.id); // the stream then ends with job.state cancelled and done
      } catch (e) {
        notify(`Could not cancel: ${e instanceof ApiFailure ? e.message : String(e)}`);
      }
    },
    async retry() {
      const job = gen.getState().job;
      if (job) await generate(job.request);
    },
    dispose() {
      disposed = true;
      stream?.close();
      director.dispose();
      sync.dispose();
    },
  };
}
