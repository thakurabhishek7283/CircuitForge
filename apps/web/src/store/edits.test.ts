// Editing gestures against the real core: building a circuit from nothing, each gesture one undo
// step, the store mirror always equal to the core's snapshot.
import { describe, expect, it } from "vitest";
import type { Circuit } from "../gen/contract.ts";
import { bundleJson, loadCore, missingArtifacts } from "../test/artifacts.ts";
import { createCircuitStore } from "./circuitStore.ts";
import { createEdits } from "./edits.ts";

const missing = missingArtifacts();

function setup() {
  const core = loadCore();
  const session = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), null);
  const store = createCircuitStore(session);
  return { session, store, edits: createEdits(store, session) };
}

describe.skipIf(missing.length > 0)("edits", () => {
  it("builds an RC low-pass from nothing, one undo step per gesture", () => {
    const { session, store, edits } = setup();
    const snapshot = () => JSON.parse(session.snapshot()) as Circuit;

    expect(edits.place("vsource_sine").ok).toBeTruthy();
    expect(store.getState().selection).toEqual({ kind: "part", refdes: "V1" });
    edits.place("resistor_th");
    edits.place("cap_film");
    expect(Object.keys(store.getState().parts)).toEqual(["V1", "R1", "C1"]);

    expect(edits.wire("V1.P", { pin: "R1.1" }).ok).toBeTruthy();
    expect(edits.wire("R1.2", { pin: "C1.1" }).ok).toBeTruthy();
    expect(edits.wire("V1.N", { rail: { net: "GND", kind: { kind: "ground" } } }).ok).toBeTruthy();
    expect(edits.wire("C1.2", { net: "GND" }).ok).toBeTruthy();
    const nets = store.getState().nets;
    expect(nets.N1?.pins).toEqual(["R1.1", "V1.P"]);
    expect(nets.N2?.pins).toEqual(["C1.1", "R1.2"]);
    expect(nets.GND?.pins).toEqual(["C1.2", "V1.N"]);
    expect(store.getState().erc).toEqual([]);

    expect(edits.setParam("R1", "resistance", "4k7").ok).toBeTruthy();
    expect(store.getState().parts.R1?.params.resistance?.display).toBe("4.7kΩ");
    expect(edits.setParam("R1", "resistance", "4.7k").ok).toBeTruthy();
    expect(store.getState().parts.R1?.params.resistance?.si).toBe(4700);
    expect(edits.setParam("R1", "resistance", "lots").err?.code).toBe("bad_value");
    expect(store.getState().lastError?.code).toBe("bad_value");

    // Every gesture is one undo step: nine undos reach the empty circuit, nine redos return.
    const built = snapshot();
    expect(store.getState().history.undo.map((t) => t.label)).toEqual([
      "Place V1",
      "Place R1",
      "Place C1",
      "Wire V1.P to R1.1",
      "Wire R1.2 to C1.1",
      "Wire V1.N to GND",
      "Wire C1.2 to GND",
      "R1 resistance = 4k7",
      "R1 resistance = 4.7k",
    ]);
    while (store.getState().undo());
    expect(snapshot().parts).toEqual({});
    expect(store.getState().parts).toEqual({});
    while (store.getState().redo());
    const back = snapshot();
    expect({ ...back, rev: 0 }).toEqual({ ...built, rev: 0 });
    expect(store.getState().nets).toEqual(back.nets);
  });

  it("explains a refused wire without changing anything, and deletes parts, nets and pins", () => {
    const { store, edits } = setup();
    edits.place("resistor_th");
    edits.place("resistor_th");
    edits.wire("R1.2", { pin: "R2.1" });
    const rev = store.getState().rev;
    const r = edits.wire("R2.1", { pin: "R1.2" });
    expect(r.err?.code).toBe("pin_already_connected");
    expect(store.getState().lastError?.message).toMatch(/already connected/);
    expect(store.getState().rev).toBe(rev);

    // A floating pin shows up in ERC, as a warning a learner may build through.
    expect(store.getState().erc.map((i) => i.code)).toContain("floating_pin");

    expect(edits.disconnect("R2.1")?.ok).toBeTruthy();
    expect(store.getState().nets.N1?.pins).toEqual(["R1.2"]);
    expect(store.getState().erc.map((i) => i.code)).toContain("dangling_net");
    store.getState().undo();
    expect(edits.remove({ kind: "net", id: "N1" })?.ok).toBeTruthy();
    expect(store.getState().nets).toEqual({});
    expect(edits.remove({ kind: "part", refdes: "R1" })?.ok).toBeTruthy();
    expect(Object.keys(store.getState().parts)).toEqual(["R2"]);
    expect(edits.place("resistor_th").ok).toBeTruthy();
    expect(Object.keys(store.getState().parts)).toEqual(["R2", "R1"]); // R1 is free again
  });

  it("pins a dragged part and hands it back to the layout", () => {
    const { store, edits } = setup();
    edits.place("cap_film");
    expect(edits.pin("C1", { x: 120, y: 40, rot: 90, flip: false }).ok).toBeTruthy();
    expect(store.getState().parts.C1?.pinned).toEqual({ x: 120, y: 40, rot: 90, flip: false });
    expect(edits.pin("C1", null).ok).toBeTruthy();
    expect(store.getState().parts.C1?.pinned).toBeUndefined();
    expect(store.getState().history.undo.at(-1)?.label).toBe("Auto-place C1");
  });

  it("sets the requested analyses as an undoable edit", () => {
    const { store, edits } = setup();
    edits.place("vsource_sine");
    const ac = { type: "ac" as const, points_per_decade: 20, f_start: 10, f_stop: 1e6 };
    expect(edits.setAnalyses([ac], "Run AC sweep").ok).toBeTruthy();
    expect(store.getState().analyses).toEqual([ac]);
    store.getState().undo();
    expect(store.getState().analyses).toEqual([]);
  });
});
