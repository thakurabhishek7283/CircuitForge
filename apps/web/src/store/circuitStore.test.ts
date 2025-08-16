// The store against the real core (Node build of @tutor/core): after any sequence of edits, undos
// and redos, the mirror built from patches equals the core's own snapshot.
import { describe, expect, it } from "vitest";
import type { Circuit, Op } from "../gen/contract.ts";
import type { CoreSessionLike } from "../core/types.ts";
import { bundleJson, demoJson, loadCore, missingArtifacts } from "../test/artifacts.ts";
import { type CircuitState, createCircuitStore } from "./circuitStore.ts";

const missing = missingArtifacts();

function setup(snapshot: string | null = demoJson()) {
  const core = loadCore();
  const session = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), snapshot);
  return { session, store: createCircuitStore(session) };
}

function expectMirror(state: CircuitState, session: CoreSessionLike) {
  const snap = JSON.parse(session.snapshot()) as Circuit;
  expect(state.rev).toBe(snap.rev);
  expect(state.parts).toEqual(snap.parts);
  expect(state.nets).toEqual(snap.nets);
  expect(state.blocks).toEqual(snap.blocks);
  expect(state.analyses).toEqual(snap.analyses);
  expect(state.hints).toEqual(snap.hints);
  // Parts and blocks keep the core's order (layout follows it); nets are order-free.
  expect(Object.keys(state.parts)).toEqual(Object.keys(snap.parts));
  expect(Object.keys(state.blocks)).toEqual(Object.keys(snap.blocks));
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomOp(state: CircuitState, rand: () => number, n: number): Op {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const parts = Object.values(state.parts);
  const nets = Object.values(state.nets);
  const pinsOf = (refdes: string) => (state.parts[refdes]!.part === "opamp_tl072" ? ["OUT_B", "INP_B", "INM_B"] : refdes.startsWith("V") ? ["P", "N"] : ["1", "2"]);
  switch (Math.floor(rand() * 7)) {
    case 0:
      return { op: "part.add", body: { refdes: `R${100 + n}`, part: "resistor_th", params: { resistance: pick(["1k", "4k7", "22k"]) } } };
    case 1:
      return { op: "part.remove", body: { refdes: pick(parts).refdes } };
    case 2: {
      const r = parts.filter((p) => p.part === "resistor_th");
      return { op: "part.set_param", body: { refdes: r.length ? pick(r).refdes : "R1", key: "resistance", value: pick(["1k", "2.2k", "47k"]) } };
    }
    case 3: {
      const p = pick(parts);
      return { op: "net.connect", body: { net: rand() < 0.5 ? pick(nets).id : `N_X${n}`, pins: [`${p.refdes}.${pick(pinsOf(p.refdes))}`] } };
    }
    case 4: {
      const net = pick(nets);
      return { op: "net.disconnect", body: { net: net.id, pins: net.pins.length ? [pick(net.pins)] : [] } };
    }
    case 5:
      return { op: "net.rename", body: { from: pick(nets).id, to: `N_R${n}` } };
    default:
      return { op: "part.pin", body: { refdes: pick(parts).refdes, placement: rand() < 0.5 ? null : { x: n * 10, y: 20, rot: 90, flip: false } } };
  }
}

describe.skipIf(missing.length > 0)("circuitStore", () => {
  it("loads a snapshot", () => {
    const { store, session } = setup();
    expectMirror(store.getState(), session);
    expect(Object.keys(store.getState().parts)).toHaveLength(8);
  });

  it("mirrors the core through any sequence of edits, undos and redos", () => {
    for (const seed of [1, 2, 3]) {
      const { store, session } = setup();
      const rand = rng(seed);
      const initial = session.snapshot();
      let applied = 0;
      for (let n = 0; n < 120; n++) {
        const s = store.getState();
        const roll = rand();
        if (roll < 0.15) s.undo();
        else if (roll < 0.2) s.redo();
        else if (s.apply(randomOp(s, rand, n)).ok) applied++;
        expectMirror(store.getState(), session);
      }
      expect(applied).toBeGreaterThan(30);
      const final = session.snapshot();
      while (store.getState().undo()) expectMirror(store.getState(), session);
      expect(stripRev(session.snapshot())).toEqual(stripRev(initial));
      while (store.getState().redo()) expectMirror(store.getState(), session);
      expect(stripRev(session.snapshot())).toEqual(stripRev(final));
    }
  });

  it("refuses a bad op without changing anything", () => {
    const { store, session } = setup();
    const before = store.getState();
    const r = before.apply({ op: "part.add", body: { refdes: "R1", part: "resistor_th" } });
    expect(r.err?.code).toBe("refdes_conflict");
    expect(store.getState().lastError?.code).toBe("refdes_conflict");
    expect(store.getState().parts).toBe(before.parts);
    expect(store.getState().history.undo).toHaveLength(0);
    expectMirror(store.getState(), session);
  });

  it("makes a batch one undo step and clears redo on a new edit", () => {
    const { store } = setup();
    const s = store.getState();
    s.applyBatch(
      [
        { op: "part.add", body: { refdes: "R9", part: "resistor_th" } },
        { op: "net.connect", body: { net: "N_OUT", pins: ["R9.1"] } },
        { op: "net.connect", body: { net: "GND", pins: ["R9.2"] } },
      ],
      "add load",
    );
    expect(store.getState().history.undo.map((t) => t.label)).toEqual(["add load"]);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().parts.R9).toBeUndefined();
    expect(store.getState().nets.N_OUT!.pins).not.toContain("R9.1");
    expect(store.getState().history.redo).toHaveLength(1);
    store.getState().apply({ op: "part.set_param", body: { refdes: "R1", key: "resistance", value: "1k" } });
    expect(store.getState().history.redo).toHaveLength(0);
  });

  it("drops the selection when its target goes away, and is read-only while generating", () => {
    const { store } = setup();
    store.getState().select({ kind: "part", refdes: "C2" });
    store.getState().apply({ op: "part.remove", body: { refdes: "C2" } });
    expect(store.getState().selection).toBeNull();

    store.setState({ mode: "generating" });
    const r = store.getState().apply({ op: "part.remove", body: { refdes: "R1" } });
    expect(r.err?.code).toBe("forbidden");
    expect(store.getState().undo()).toBe(false);
    expect(store.getState().parts.R1).toBeDefined();
  });
});

/** Undo restores content; `rev` keeps counting (every undo is an applied op). */
function stripRev(snapshot: string) {
  const c = JSON.parse(snapshot) as Circuit;
  return { ...c, rev: 0, nets: Object.fromEntries(Object.entries(c.nets).sort(([a], [b]) => (a < b ? -1 : 1))) };
}
