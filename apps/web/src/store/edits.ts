// The editor's gestures as ops (LLD §10). Each gesture is one `apply`/`applyBatch`, so one undo
// step; the core decides refdes and how a wire joins nets (circuit-core `edit`), so the editor
// never re-implements IR rules.
import type { Analysis, ApplyOk, InsertBlock, Inserted, Op, OpError, Placement, Preview, WireEnd } from "../gen/contract.ts";
import { type CoreSessionLike, outcome, type Outcome } from "../core/types.ts";
import type { CircuitStore, Selection } from "./circuitStore.ts";

export type EditResult = Outcome<ApplyOk, OpError>;

export interface Edits {
  /** Add a registry part (auto-placed by the layout) and select it. */
  place(part: string): EditResult;
  /** A wire from a pin to a pin, a net or a rail. */
  wire(from: string, to: WireEnd): EditResult;
  /** Delete a part, or a whole net (its wires and flags). */
  remove(selection: Selection): EditResult | null;
  /** Take one pin off its net. */
  disconnect(pin: string): EditResult | null;
  /** A value as typed: the core parses it ("4k7" and "4.7k" are the same). */
  setParam(refdes: string, key: string, text: string): EditResult;
  /** Fix a part where the user dropped it, or hand it back to the layout (null). */
  pin(refdes: string, placement: Placement | null, label?: string): EditResult;
  /** The circuit's requested analyses (the scope's AC sweep and transient settings). */
  setAnalyses(analyses: Analysis[], label: string): EditResult;
  /** What inserting a template block would give (part values, spec), without applying it. */
  previewBlock(req: InsertBlock): Outcome<Preview, OpError>;
  /** Insert a template block as one undo step and select it. */
  insertBlock(req: InsertBlock): Outcome<Inserted, OpError>;
}

export function createEdits(store: CircuitStore, core: CoreSessionLike): Edits {
  const state = () => store.getState();
  const label = (end: WireEnd) => ("pin" in end ? end.pin : "net" in end ? end.net : end.rail.net);

  return {
    place(part) {
      const refdes = outcome<string, OpError>(core.nextRefdes(part));
      if (refdes.err) return state().refuse(refdes.err);
      const r = state().apply({ op: "part.add", body: { refdes: refdes.ok, part } }, `Place ${refdes.ok}`);
      if (r.ok) state().select({ kind: "part", refdes: refdes.ok });
      return r;
    },

    wire(from, to) {
      const ops = outcome<Op[], OpError>(core.connect(from, JSON.stringify(to)));
      if (ops.err) return state().refuse(ops.err);
      return state().applyBatch(ops.ok, `Wire ${from} to ${label(to)}`);
    },

    remove(sel) {
      const s = state();
      if (sel.kind === "part") return s.apply({ op: "part.remove", body: { refdes: sel.refdes } }, `Delete ${sel.refdes}`);
      if (sel.kind === "net") {
        const net = s.nets[sel.id];
        if (!net?.pins.length) return null;
        return s.apply({ op: "net.disconnect", body: { net: net.id, pins: net.pins } }, `Delete net ${net.id}`);
      }
      return null; // blocks are removed by the generator, not the editor
    },

    disconnect(pin) {
      const net = Object.values(state().nets).find((n) => n?.pins.includes(pin));
      if (!net) return null;
      return state().apply({ op: "net.disconnect", body: { net: net.id, pins: [pin] } }, `Disconnect ${pin}`);
    },

    setParam(refdes, key, text) {
      return state().apply({ op: "part.set_param", body: { refdes, key, value: text } }, `${refdes} ${key} = ${text}`);
    },

    pin(refdes, placement, text) {
      return state().apply({ op: "part.pin", body: { refdes, placement } }, text ?? (placement ? `Move ${refdes}` : `Auto-place ${refdes}`));
    },

    setAnalyses(analyses, text) {
      return state().apply({ op: "analysis.set", body: { analyses } }, text);
    },

    previewBlock(req) {
      return outcome<Preview, OpError>(core.previewBlock(JSON.stringify(req)));
    },

    insertBlock(req) {
      const ins = outcome<Inserted, OpError>(core.insertBlock(JSON.stringify(req)));
      if (ins.err) {
        state().refuse(ins.err);
        return ins;
      }
      const begin = ins.ok.ops[0];
      const title = begin?.op === "block.begin" ? begin.body.title : req.template;
      const r = state().applyBatch(ins.ok.ops, `Insert ${title}`, "template");
      if (r.err) return { err: r.err };
      state().select({ kind: "block", id: ins.ok.block });
      return ins;
    },
  };
}
