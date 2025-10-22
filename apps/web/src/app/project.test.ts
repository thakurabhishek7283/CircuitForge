// A project session against the real core and a scripted API: unsaved edits from an earlier visit
// replayed or dropped, and Generate sending every edit before the job starts.
import { describe, expect, it, vi } from "vitest";
import { type ApiClient, ApiFailure } from "../api/client.ts";
import type { AppendOps, GenerateRequest, ProjectSnapshot } from "../gen/contract.ts";
import { createCircuitStore } from "../store/circuitStore.ts";
import { createGenerationStore } from "../store/generationStore.ts";
import { memoryPendingStore } from "../store/pending.ts";
import { bundleJson, loadCore, missingArtifacts } from "../test/artifacts.ts";
import { envelopes } from "../test/jobs.ts";
import { openProject } from "./project.ts";

const missing = missingArtifacts();

function snapshot(headRev = 0): ProjectSnapshot {
  const core = loadCore();
  const s = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), null);
  const circuit = JSON.parse(s.snapshot()) as ProjectSnapshot["circuit"];
  return {
    project: { id: "p1", title: "t", registry_version: circuit.registry_version, head_rev: headRev, created_at: "", updated_at: "" },
    circuit,
    lesson: [{ seq: 1, kind: "narration", text: "Hello." }],
  };
}

function setup(snap: ProjectSnapshot, generate: (req: GenerateRequest) => Promise<{ job_id: string }>) {
  const core = loadCore();
  const session = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), JSON.stringify(snap.circuit));
  const store = createCircuitStore(session);
  const gen = createGenerationStore();
  const calls: string[] = [];
  const api = {
    appendOps: async (_: string, body: AppendOps) => {
      calls.push(`ops ${body.base_rev}+${body.ops.length}`);
      return { rev: body.base_rev + body.ops.length };
    },
    generate: async (_: string, req: GenerateRequest) => {
      calls.push(`generate ${req.prompt}`);
      return generate(req);
    },
    getProject: async () => snap,
    cancel: async () => {},
    eventsUrl: (id: string) => `/v1/jobs/${id}/events`,
    authHeaders: async () => ({}),
  } as unknown as ApiClient;
  const notices: string[] = [];
  const reloads: string[] = [];
  return { store, gen, api, calls, notices, reloads, pending: memoryPendingStore() };
}

const placeR1 = () => envelopes([{ op: "part.add", body: { refdes: "R1", part: "resistor_th" } }], 0, "", "user").map(({ job: _, block: __, ...e }) => e);

describe.skipIf(missing.length > 0)("openProject", () => {
  it("replays edits saved while offline when the project has not moved, then sends them", async () => {
    const t = setup(snapshot(0), async () => ({ job_id: "j" }));
    await t.pending.put("p1", { baseRev: 0, envelopes: placeR1() });
    const p = await openProject({ ...t, snapshot: snapshot(0), reload: (n) => t.reloads.push(n), notify: (n) => t.notices.push(n) });
    expect(Object.keys(t.store.getState().parts)).toEqual(["R1"]);
    expect(t.gen.getState().lesson).toHaveLength(1);
    await vi.waitFor(() => expect(t.calls).toEqual(["ops 0+1"]));
    p.dispose();
  });

  it("drops saved edits when the project changed on the server since", async () => {
    const t = setup(snapshot(3), async () => ({ job_id: "j" }));
    await t.pending.put("p1", { baseRev: 0, envelopes: placeR1() });
    const p = await openProject({ ...t, snapshot: snapshot(3), reload: (n) => t.reloads.push(n), notify: (n) => t.notices.push(n) });
    expect(t.store.getState().parts).toEqual({});
    expect(t.notices).toEqual(["1 unsaved edit was dropped: the project changed on the server since."]);
    expect(await t.pending.get("p1")).toBeNull();
    p.dispose();
  });

  it("sends pending edits before starting a job, and unlocks the editor when the start is refused", async () => {
    const t = setup(snapshot(0), async () => {
      throw new ApiFailure(503, { code: "generation_unavailable", message: "no", retryable: true });
    });
    const p = await openProject({ ...t, snapshot: snapshot(0), reload: (n) => t.reloads.push(n), notify: (n) => t.notices.push(n) });
    t.store.getState().apply({ op: "part.add", body: { refdes: "R1", part: "resistor_th" } });
    const started = p.generate({ prompt: "a filter" });
    expect(t.store.getState().mode).toBe("generating"); // no edits between the flush and the job
    await started;
    expect(t.calls).toEqual(["ops 0+1", "generate a filter"]);
    expect(t.store.getState().mode).toBe("idle");
    expect(t.gen.getState().phase).toBe("failed");
    expect(t.gen.getState().error).toMatchObject({ code: "generation_unavailable", retryable: true });
    p.dispose();
  });
});
