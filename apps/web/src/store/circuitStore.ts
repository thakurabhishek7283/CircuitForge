// The editor's state (LLD §10). The authoritative circuit lives in a WASM CoreSession; this store
// mirrors it through patches only: every change goes through the core's apply(), which returns
// what changed by id, and `changes()` returns just those entities. Undo and redo apply the
// inverse ops the core returned, so they too go through apply() and are themselves undoable.
import { createStore, type StoreApi } from "zustand/vanilla";
import { immer } from "zustand/middleware/immer";
import type {
  Analysis,
  ApplyOk,
  Block,
  Circuit,
  LayoutHint,
  Net,
  Op,
  OpEnvelope,
  OpError,
  PartInstance,
  Patch,
  PatchData,
} from "../gen/contract.ts";
import { type CoreSessionLike, expectOk, outcome, type Outcome } from "../core/types.ts";
import type { SimResult, SimStatus } from "../workers/sim.types.ts";
import type { Layout } from "../workers/layout.types.ts";

/** One undo or redo step: the ops that take the circuit to the other side of it. */
export interface Txn {
  label: string;
  ops: Op[];
}

export type Selection = { kind: "part"; refdes: string } | { kind: "net"; id: string } | { kind: "block"; id: string };

export interface SimState {
  /** Netlist hash of the latest request; a result for any other hash is stale. */
  hash: string | null;
  status: "idle" | "pending" | "running" | SimStatus;
  result?: SimResult;
  /** OP node voltages by net id. */
  voltages: Record<string, number>;
  /** Compile error or worker failure. */
  message?: string;
}

export interface CircuitData {
  registryVersion: string;
  rev: number;
  parts: Record<string, PartInstance>;
  nets: Record<string, Net>;
  blocks: Record<string, Block>;
  analyses: Analysis[];
  hints: LayoutHint[];
}

export interface CircuitState extends CircuitData {
  layout: Layout | null;
  sim: SimState;
  selection: Selection | null;
  /** While a generation job streams, user edits are refused (LLD §4: single writer). */
  mode: "idle" | "generating" | "editing";
  history: { undo: Txn[]; redo: Txn[] };
  /** The last op the core refused, for the UI to explain. */
  lastError: OpError | null;

  /** Apply one user op as one undo step. */
  apply(op: Op, label?: string): Outcome<ApplyOk, OpError>;
  /** Apply several user ops atomically, as one undo step (e.g. place a part and wire it). */
  applyBatch(ops: Op[], label: string): Outcome<ApplyOk, OpError>;
  undo(): boolean;
  redo(): boolean;
  select(selection: Selection | null): void;
  setLayout(layout: Layout): void;
  setSim(update: (sim: SimState) => unknown): void;
}

export type CircuitStore = StoreApi<CircuitState>;

const READ_ONLY: OpError = { code: "forbidden", message: "the circuit is read-only while a generation job runs" };

export function createCircuitStore(core: CoreSessionLike): CircuitStore {
  const initial = JSON.parse(core.snapshot()) as Circuit; // the one full read: loading a snapshot
  let seq = 0;

  return createStore<CircuitState>()(
    immer((set, get) => {
      /** Merge what the core says changed. */
      const merge = (patch: Patch) => {
        const data = expectOk<PatchData>(core.changes(JSON.stringify(patch)), "changes");
        set((s) => {
          for (const id of patch.parts_removed) delete s.parts[id];
          for (const id of patch.nets_removed) delete s.nets[id];
          for (const id of patch.blocks_removed) delete s.blocks[id];
          Object.assign(s.parts, data.parts);
          Object.assign(s.nets, data.nets);
          Object.assign(s.blocks, data.blocks);
          if (data.analyses) s.analyses = data.analyses;
          if (data.hints) s.hints = data.hints;
          s.rev = data.rev;
          s.lastError = null;
          const sel = s.selection;
          if (
            (sel?.kind === "part" && !s.parts[sel.refdes]) ||
            (sel?.kind === "net" && !s.nets[sel.id]) ||
            (sel?.kind === "block" && !s.blocks[sel.id])
          ) {
            s.selection = null;
          }
        });
      };

      const refuse = (err: OpError): Outcome<ApplyOk, OpError> => {
        set((s) => {
          s.lastError = err;
        });
        return { err };
      };

      /** Record a user change as one undo step; a new change clears redo. */
      const commit = (r: Outcome<ApplyOk, OpError>, label: string) => {
        if (r.err) return refuse(r.err);
        merge(r.ok.patch);
        set((s) => {
          s.history.undo.push({ label, ops: r.ok.inverse });
          s.history.redo = [];
        });
        return r;
      };

      /** Undo or redo: apply a recorded step and file its inverse on the other stack. */
      const step = (from: "undo" | "redo") => {
        const to = from === "undo" ? "redo" : "undo";
        const txn = get().history[from].at(-1);
        if (!txn || get().mode === "generating") return false;
        const r = outcome<ApplyOk, OpError>(core.applyOps(JSON.stringify(txn.ops), "user"));
        if (r.err) {
          refuse(r.err); // only possible after a version skew; keep the step for inspection
          return false;
        }
        merge(r.ok.patch);
        set((s) => {
          s.history[from].pop();
          s.history[to].push({ label: txn.label, ops: r.ok.inverse });
        });
        return true;
      };

      return {
        registryVersion: initial.registry_version,
        rev: initial.rev,
        parts: initial.parts as Record<string, PartInstance>,
        nets: initial.nets as Record<string, Net>,
        blocks: initial.blocks as Record<string, Block>,
        analyses: initial.analyses,
        hints: initial.hints,
        layout: null,
        sim: { hash: null, status: "idle", voltages: {} },
        selection: null,
        mode: "idle",
        history: { undo: [], redo: [] },
        lastError: null,

        apply(op, label = op.op) {
          if (get().mode === "generating") return refuse(READ_ONLY);
          const env = { v: 1, seq: ++seq, author: "user", base_rev: core.rev, ...op } as OpEnvelope;
          return commit(outcome<ApplyOk, OpError>(core.apply(JSON.stringify(env))), label);
        },

        applyBatch(ops, label) {
          if (get().mode === "generating") return refuse(READ_ONLY);
          return commit(outcome<ApplyOk, OpError>(core.applyOps(JSON.stringify(ops), "user")), label);
        },

        undo: () => step("undo"),
        redo: () => step("redo"),

        select(selection) {
          set((s) => {
            s.selection = selection;
          });
        },

        setLayout(layout) {
          set((s) => {
            s.layout = layout;
          });
        },

        setSim(update) {
          set((s) => {
            update(s.sim);
          });
        },
      };
    }),
  );
}
