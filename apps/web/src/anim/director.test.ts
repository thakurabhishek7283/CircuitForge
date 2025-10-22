// The AnimationDirector against the real core: a job's events play in order through apply(), each
// block is one undo step and one reveal sequence, a reload's replay skips what the snapshot holds,
// and a gap or a refused op asks for a resync instead of drawing a wrong circuit.
import { describe, expect, it } from "vitest";
import type { Circuit, JobEvent } from "../gen/contract.ts";
import { createCircuitStore } from "../store/circuitStore.ts";
import { createGenerationStore } from "../store/generationStore.ts";
import { bundleJson, loadCore, missingArtifacts } from "../test/artifacts.ts";
import { envelopes, jobScript } from "../test/jobs.ts";
import { AnimationDirector, type RevealItem, type Stage, revealItems } from "./director.ts";

const missing = missingArtifacts();

const FILTER = [
  { template: "sine_source", targets: { freq_hz: "300" } },
  { template: "rc_lowpass", targets: { fc_hz: "2k" }, ports: { in: { net: "B1_OUT" } } },
];

class RecordingStage implements Stage {
  calls: string[] = [];
  hide(items: RevealItem[]) {
    this.calls.push(`hide ${items.map(name).join(" ")}`);
  }
  async reveal(item: RevealItem) {
    this.calls.push(`reveal ${name(item)}`);
  }
  revealAll() {
    this.calls.push("revealAll");
  }
  building(block: string, on: boolean) {
    this.calls.push(`building ${block} ${on}`);
  }
  setSpeed(s: number) {
    this.calls.push(`speed ${s}`);
  }
  setPaused(p: boolean) {
    this.calls.push(`paused ${p}`);
  }
}

const name = (i: RevealItem) => (i.kind === "part" ? i.refdes : i.kind === "net" ? `net:${i.id}` : `block:${i.id}`);

function setup(snapshot: string | null = null) {
  const core = loadCore();
  const session = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), snapshot);
  const store = createCircuitStore(session);
  const gen = createGenerationStore();
  const resyncs: string[] = [];
  const applied: number[] = [];
  const finished: JobEvent[] = [];
  const director = new AnimationDirector({
    store,
    gen,
    waitForLayout: async () => {},
    onResync: (why) => resyncs.push(why),
    onApplied: (rev) => applied.push(rev),
    onFinished: (e) => finished.push(e),
  });
  const stage = new RecordingStage();
  director.setStage(stage);
  stage.calls = [];
  return { core, session, store, gen, director, stage, resyncs, applied, finished };
}

describe.skipIf(missing.length > 0)("AnimationDirector", () => {
  it("plays a two-block job: one undo step and one reveal per block, in op order", async () => {
    const { core, session, store, gen, director, stage, resyncs, applied, finished } = setup();
    const job = jobScript(core, FILTER);
    store.getState().setMode("generating");
    gen.getState().started("j", { prompt: "a filter" });
    for (const e of job.events) director.push(e);
    await director.idle();

    expect(resyncs).toEqual([]);
    const snap = JSON.parse(session.snapshot()) as Circuit;
    expect(Object.keys(snap.blocks)).toEqual(["b1", "b2"]);
    expect(store.getState().rev).toBe(job.rev);
    expect(applied).toEqual([job.blocks[0]!.envelopes.length, job.rev]);
    expect(store.getState().history.undo.map((t) => t.label)).toEqual(["Generate Sine signal source", "Generate RC low-pass filter"]);
    expect(Object.keys(store.getState().bench)).toEqual(["b1", "b2"]);
    // Parts are origin llm: the job built them.
    expect(snap.parts.R1?.origin).toEqual({ kind: "llm", job_id: expect.any(String) });

    // B1_OUT already existed when b2 joined it: redrawn, never hidden.
    expect(stage.calls).toEqual([
      "hide block:b1 V1 net:B1_OUT net:GND",
      "building b1 true",
      "reveal block:b1",
      "reveal V1",
      "reveal net:B1_OUT",
      "reveal net:GND",
      "revealAll",
      "building b1 false",
      "hide block:b2 R1 C1 net:B2_OUT",
      "building b2 true",
      "reveal block:b2",
      "reveal R1",
      "reveal C1",
      "reveal net:B1_OUT",
      "reveal net:B2_OUT",
      "reveal net:GND",
      "revealAll",
      "building b2 false",
      "revealAll",
    ]);

    const g = gen.getState();
    expect(g.phase).toBe("done");
    expect(g.ghosts).toEqual({});
    expect(g.plan.map((p) => [p.id, p.status])).toEqual([
      ["b1", "committed"],
      ["b2", "committed"],
    ]);
    expect(g.narration).toEqual([
      { block: null, text: "An introduction. " },
      { block: "b1", text: "What b1 does. " },
      { block: "b2", text: "What b2 does. " },
    ]);
    expect(finished.map((e) => e.event)).toEqual(["done"]);

    // One undo removes the whole last block.
    store.getState().setMode("idle");
    expect(store.getState().undo()).toBe(true);
    expect(Object.keys(store.getState().blocks)).toEqual(["b1"]);
    expect(Object.keys(store.getState().parts)).toEqual(["V1"]);
  });

  it("replays a stream after a reload: blocks the snapshot holds are skipped, not applied twice", async () => {
    const first = setup();
    const job = jobScript(first.core, FILTER);
    // The snapshot a reload opens: the first block is already in it.
    const scratch = new first.core.CoreSession(first.core.CoreRegistry.fromJson(bundleJson()), null);
    for (const env of job.blocks[0]!.envelopes) scratch.apply(JSON.stringify(env));
    const { store, gen, director, resyncs } = setup(scratch.snapshot());
    gen.getState().started("j", null);
    for (const e of job.events) director.push(e);
    await director.idle();

    expect(resyncs).toEqual([]);
    expect(store.getState().rev).toBe(job.rev);
    expect(Object.keys(store.getState().blocks)).toEqual(["b1", "b2"]);
    expect(store.getState().history.undo.map((t) => t.label)).toEqual(["Generate RC low-pass filter"]);
    expect(gen.getState().plan.map((p) => [p.id, p.status])).toEqual([
      ["b1", "committed"],
      ["b2", "committed"],
    ]);
  });

  it("asks for a resync on a gap or an op the core refuses, and draws nothing of it", async () => {
    const { core, store, director, resyncs, stage } = setup();
    const job = jobScript(core, FILTER);
    // The second block without the first: its base_rev is ahead of the editor.
    for (const env of job.blocks[1]!.envelopes) director.push({ event: "op", data: env });
    await director.idle();
    expect(resyncs).toHaveLength(1);
    expect(resyncs[0]).toBe(`ops from rev ${job.blocks[0]!.envelopes.length} reached an editor at rev 0`);
    expect(store.getState().rev).toBe(0);

    const bad = envelopes(
      [
        { op: "block.begin", body: { id: "b1", role: "filter", title: "Broken", spec: {}, ports: [] } },
        { op: "part.add", body: { refdes: "R1", part: "no_such_part" } },
        { op: "block.commit", body: { id: "b1" } },
      ],
      0,
      "b1",
    );
    for (const data of bad) director.push({ event: "op", data });
    await director.idle();
    expect(resyncs).toHaveLength(2);
    expect(resyncs[1]).toMatch(/refused a server op: part_not_in_registry/);
    expect(stage.calls.at(-1)).toBe("revealAll");
  });

  it("holds events while paused, and skips the animation to the end", async () => {
    const { core, store, gen, director, stage } = setup();
    const job = jobScript(core, FILTER);
    gen.getState().setPaused(true);
    for (const e of job.events) director.push(e);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().rev).toBe(0);
    gen.getState().setSkipping(true);
    gen.getState().setPaused(false);
    await director.idle();
    expect(store.getState().rev).toBe(job.rev);
    expect(stage.calls.filter((c) => c.startsWith("reveal ") || c.startsWith("hide"))).toEqual([]);
  });

  it("discards uncommitted ghosts when a job is cancelled or fails", async () => {
    const { core, gen, director, finished } = setup();
    const job = jobScript(core, FILTER);
    const firstBlockEnd = job.events.findIndex((e) => e.event === "sim.summary");
    for (const e of job.events.slice(0, firstBlockEnd + 2)) director.push(e);
    director.push(job.events.find((e) => e.event === "block.ghost" && e.data.id === "b2")!);
    await director.idle();
    expect(Object.keys(gen.getState().ghosts)).toEqual(["b2"]);
    director.push({ event: "job.state", data: { state: "cancelled" } });
    director.push({ event: "done", data: { rev: job.blocks[0]!.envelopes.length, usage: { in_tokens: 1, out_tokens: 1 } } });
    await director.idle();
    expect(gen.getState().phase).toBe("cancelled");
    expect(gen.getState().ghosts).toEqual({});
    expect(gen.getState().plan.map((p) => p.status)).toEqual(["committed", "discarded"]);

    gen.getState().started("j2", { prompt: "again" });
    director.push(job.events.find((e) => e.event === "block.ghost")!);
    director.push({ event: "error", data: { code: "llm_unavailable", message: "down", retryable: true } });
    await director.idle();
    expect(gen.getState().phase).toBe("failed");
    expect(gen.getState().error?.code).toBe("llm_unavailable");
    expect(gen.getState().ghosts).toEqual({});
    expect(finished.map((e) => e.event)).toEqual(["done", "error"]);
  });

  it("lists what a block reveals, parts and nets in op order", () => {
    const { core } = setup();
    const job = jobScript(core, FILTER);
    expect(revealItems(job.blocks[1]!.envelopes).map(name)).toEqual(["R1", "C1", "net:B1_OUT", "net:B2_OUT", "net:GND"]);
  });
});
