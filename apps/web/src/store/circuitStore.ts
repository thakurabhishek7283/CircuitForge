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
  CheckResult,
  Circuit,
  ErcIssue,
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
import type { SimView } from "./simView.ts";

/** A user change the core accepted, for sync (LLD §10): `ops` took the circuit from `baseRev`,
 * one rev per op, as the server's op log stores them. */
export interface Committed {
  ops: Op[];
  author: "user" | "template";
  baseRev: number;
}

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
  /** The analyses of the latest request, in deck order. */
  analyses?: Analysis[];
  /** The latest result by IR id (net voltages, pin currents) per analysis. */
  view?: SimView;
  /** OP node voltages by net id. */
  voltages: Record<string, number>;
  /** Spec checks of template blocks against the latest result (LLD §7), in block order. */
  checks?: CheckResult[];
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
  /** The rev whose topology `layout` shows; equal to `rev` once the drawing has caught up. */
  layoutRev: number;
  sim: SimState;
  selection: Selection | null;
  /** While a generation job streams, user edits are refused (LLD §4: single writer). */
  mode: "idle" | "generating" | "editing";
  history: { undo: Txn[]; redo: Txn[] };
  /** The last op the core refused, for the UI to explain. */
  lastError: OpError | null;
  /** Static ERC for user edits (LLD §7: warnings a learner may build through), after every change. */
  erc: ErcIssue[];
  /** Spec checks of generated blocks as the server measured them in their test bench (`sim.summary`). */
  bench: Record<string, CheckResult[]>;

  /** Apply one user op as one undo step. */
  apply(op: Op, label?: string): Outcome<ApplyOk, OpError>;
  /** Apply several ops atomically, as one undo step (e.g. place a part and wire it). `author`
   * is "template" for an inserted block, so its parts carry their template as origin. */
  applyBatch(ops: Op[], label: string, author?: "user" | "template"): Outcome<ApplyOk, OpError>;
  undo(): boolean;
  redo(): boolean;
  /** Apply envelopes from the server (a generation job's block, or user ops replayed after a
   * reload) whatever the mode: each through the core, which checks its `base_rev`. With a label
   * they become one undo step (LLD §4: one undo removes a generated block). Not reported to
   * `onCommit`: the server already has them. */
  applyRemote(envelopes: OpEnvelope[], label: string | null): Outcome<ApplyOk, OpError>;
  /** Be told of every user change the core accepted (edits, inserted blocks, undo, redo). */
  onCommit(listener: (c: Committed) => void): () => void;
  setMode(mode: CircuitState["mode"]): void;
  setBench(block: string, checks: CheckResult[] | null): void;
  /** Report an edit the core refused before anything was applied (e.g. an impossible wire). */
  refuse(err: OpError): Outcome<ApplyOk, OpError>;
  select(selection: Selection | null): void;
  setLayout(layout: Layout | null, rev: number): void;
  setSim(update: (sim: SimState) => unknown): void;
}

export type CircuitStore = StoreApi<CircuitState>;

const READ_ONLY: OpError = { code: "forbidden", message: "the circuit is read-only while a generation job runs" };

export function createCircuitStore(core: CoreSessionLike): CircuitStore {
  const initial = JSON.parse(core.snapshot()) as Circuit; // the one full read: loading a snapshot
  let seq = 0;
  const erc = () => expectOk<ErcIssue[]>(core.erc("user_edit"), "erc");
  const listeners = new Set<(c: Committed) => void>();
  const report = (ops: Op[], author: Committed["author"], baseRev: number, rev: number) => {
    if (rev - baseRev !== ops.length) console.error(`${ops.length} ops moved rev ${baseRev} -> ${rev}`); // sync relies on one rev per op
    for (const l of listeners) l({ ops, author, baseRev });
  };

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
          s.erc = erc();
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
      const commit = (r: Outcome<ApplyOk, OpError>, label: string, ops: Op[], author: Committed["author"], baseRev: number) => {
        if (r.err) return refuse(r.err);
        merge(r.ok.patch);
        report(ops, author, baseRev, r.ok.rev);
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
        const baseRev = core.rev;
        const r = outcome<ApplyOk, OpError>(core.applyOps(JSON.stringify(txn.ops), "user"));
        if (r.err) {
          refuse(r.err); // only possible after a version skew; keep the step for inspection
          return false;
        }
        merge(r.ok.patch);
        report(txn.ops, "user", baseRev, r.ok.rev);
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
        layoutRev: -1,
        sim: { hash: null, status: "idle", voltages: {} },
        selection: null,
        mode: "idle",
        history: { undo: [], redo: [] },
        lastError: null,
        erc: erc(),
        bench: {},

        apply(op, label = op.op) {
          if (get().mode === "generating") return refuse(READ_ONLY);
          const baseRev = core.rev;
          const env = { v: 1, seq: ++seq, author: "user", base_rev: baseRev, ...op } as OpEnvelope;
          return commit(outcome<ApplyOk, OpError>(core.apply(JSON.stringify(env))), label, [op], "user", baseRev);
        },

        applyBatch(ops, label, author = "user") {
          if (get().mode === "generating") return refuse(READ_ONLY);
          const baseRev = core.rev;
          return commit(outcome<ApplyOk, OpError>(core.applyOps(JSON.stringify(ops), author)), label, ops, author, baseRev);
        },

        applyRemote(envelopes, label) {
          const inverses: Op[][] = [];
          let last: ApplyOk | null = null;
          for (const env of envelopes) {
            const r = outcome<ApplyOk, OpError>(core.apply(JSON.stringify(env)));
            // Earlier envelopes stay applied: the caller resyncs from the server's snapshot.
            if (r.err) return refuse(r.err);
            merge(r.ok.patch);
            inverses.push(r.ok.inverse);
            last = r.ok;
          }
          if (!last) return { err: { code: "unknown_op", message: "no ops" } as OpError };
          const inverse = inverses.reverse().flat(); // undo the last op first
          if (label) {
            set((s) => {
              s.history.undo.push({ label, ops: inverse });
              s.history.redo = [];
            });
          }
          return { ok: { ...last, inverse } };
        },

        onCommit(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },

        setMode(mode) {
          set((s) => {
            s.mode = mode;
          });
        },

        setBench(block, checks) {
          set((s) => {
            if (checks) s.bench[block] = checks;
            else delete s.bench[block];
          });
        },

        refuse,
        undo: () => step("undo"),
        redo: () => step("redo"),

        select(selection) {
          set((s) => {
            s.selection = selection;
          });
        },

        setLayout(layout, rev) {
          set((s) => {
            s.layout = layout;
            s.layoutRev = rev;
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
