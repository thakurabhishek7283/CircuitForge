/* Generated from contract/schema/contract.schema.json by tools/codegen. Do not edit. */

/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Unit".
 */
export type Unit = "ohm" | "farad" | "henry" | "volt" | "ampere" | "hertz" | "second" | "watt" | "unitless";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Origin".
 */
export type Origin =
  | {
      job_id: string;
      kind: "llm";
    }
  | {
      kind: "user";
    }
  | {
      id: string;
      kind: "template";
    };
/**
 * Part pin as REFDES.PIN, e.g. "R3.1" or "U1.OUT_A".
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PinRef".
 */
export type PinRef = string;
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NetKind".
 */
export type NetKind =
  | {
      kind: "signal";
    }
  | {
      volts: number;
      kind: "power";
    }
  | {
      kind: "ground";
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockRole".
 */
export type BlockRole =
  | "supply"
  | "source"
  | "bias"
  | "amplifier"
  | "buffer"
  | "filter"
  | "oscillator"
  | "comparator"
  | "load"
  | "other";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PortDirection".
 */
export type PortDirection = "input" | "output" | "bidir" | "power_pos" | "power_neg" | "ground";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockStatus".
 */
export type BlockStatus = "planned" | "composing" | "verified" | "committed" | "failed";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Analysis".
 */
export type Analysis =
  | {
      type: "op";
    }
  | {
      source: string;
      start: number;
      stop: number;
      step: number;
      type: "dc";
    }
  | {
      points_per_decade: number;
      f_start: number;
      f_stop: number;
      type: "ac";
    }
  | {
      t_step: number;
      t_stop: number;
      type: "tran";
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "LayoutHint".
 */
export type LayoutHint =
  | {
      dir: Direction;
      kind: "flow";
    }
  | {
      a: string;
      b: string;
      kind: "near";
    }
  | {
      block: string;
      kind: "group";
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Direction".
 */
export type Direction = "right" | "down";
/**
 * One op in its envelope (LLD §4): `{v, seq, op, author, job?, block?, base_rev, body}`.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "OpEnvelope".
 */
export type OpEnvelope = Op & {
  v: number;
  seq: number;
  author: Author;
  job?: string | null;
  block?: string | null;
  base_rev: number;
};
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Op".
 */
export type Op =
  | {
      op: "block.begin";
      body: BlockBegin;
    }
  | {
      op: "block.commit";
      body: BlockRef;
    }
  | {
      op: "block.abort";
      body: BlockAbort;
    }
  | {
      op: "block.remove";
      body: BlockRef;
    }
  | {
      op: "block.set_status";
      body: BlockSetStatus;
    }
  | {
      op: "part.add";
      body: PartAdd;
    }
  | {
      op: "part.remove";
      body: PartRef;
    }
  | {
      op: "part.set_param";
      body: PartSetParam;
    }
  | {
      op: "part.swap";
      body: PartSwap;
    }
  | {
      op: "part.pin";
      body: PartPin;
    }
  | {
      op: "net.connect";
      body: NetConnect;
    }
  | {
      op: "net.disconnect";
      body: NetDisconnect;
    }
  | {
      op: "net.rename";
      body: NetRename;
    }
  | {
      op: "analysis.set";
      body: AnalysisSet;
    }
  | {
      op: "hint.add";
      body: HintBody;
    }
  | {
      op: "hint.remove";
      body: HintBody;
    }
  | {
      op: "narrate";
      body: Narrate;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Author".
 */
export type Author = "llm" | "user" | "template";
/**
 * Error codes returned by `apply()`. These go back to the LLM verbatim during repair and are
 * shown to users as friendly text (LLD §4). Additive only within a protocol major version.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
  | (
      | "part_not_in_registry"
      | "pin_not_found"
      | "pin_already_connected"
      | "param_out_of_range"
      | "refdes_conflict"
      | "block_not_open"
      | "stale_rev"
      | "unknown_op"
      | "limit_exceeded"
      | "part_not_found"
      | "param_unknown"
      | "net_not_found"
      | "block_not_found"
      | "block_conflict"
      | "hint_not_found"
    )
  | "schema_error"
  | "unsupported_version"
  | "registry_mismatch"
  | "refdes_invalid"
  | "bad_value"
  | "category_mismatch"
  | "net_invalid"
  | "net_conflict"
  | "block_not_empty"
  | "analysis_invalid"
  | "forbidden"
  | "template_not_found"
  | "target_out_of_range"
  | "port_invalid"
  | "compile_failed";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Outcome".
 */
export type Outcome =
  | {
      ok: ApplyOk;
    }
  | {
      err: OpError;
    };
/**
 * Who the check is for: LLM blocks must be clean; learners may build broken circuits.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ErcContext".
 */
export type ErcContext = "llm_block" | "user_edit";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ErcCode".
 */
export type ErcCode =
  | "floating_pin"
  | "dangling_net"
  | "no_dc_path"
  | "vsource_loop"
  | "unpowered_ic"
  | "output_conflict"
  | "supply_short"
  | "over_voltage"
  | "port_unbound"
  | "unused_unit";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Severity".
 */
export type Severity = ("warning" | "info") | "error";
/**
 * LLD §7 spec checks. Each is a few primitive ngspice `.meas` results combined by
 * [`evaluate_checks`] (ngspice cannot measure an expression such as `vdb(out)-vdb(in)`).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CheckKind".
 */
export type CheckKind =
  | "ac_corner"
  | "ac_q"
  | "ac_gain"
  | "ac_center"
  | "ac_band_q"
  | "tran_freq"
  | "tran_duty"
  | "tran_amplitude"
  | "dc_level"
  | "tran_threshold";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Category".
 */
export type Category = "R" | "C" | "L" | "D" | "Q" | "U" | "V" | "J";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PinType".
 */
export type PinType = ("input" | "output" | "passive" | "power_pos" | "power_neg") | "nc";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Hazard".
 */
export type Hazard = "mains";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Pass".
 */
export type Pass = "low" | "high";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Edge".
 */
export type Edge = "rise" | "fall";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Side".
 */
export type Side = "left" | "right" | "top" | "bottom";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Scale".
 */
export type Scale = "lin" | "log";
/**
 * Where a wire ends: a pin, an existing net (a wire or a power/ground flag of it), or a supply
 * rail, which is created with its kind if it does not exist yet (the editor's GND and rail tools).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "WireEnd".
 */
export type WireEnd =
  | {
      pin: PinRef;
    }
  | {
      net: string;
    }
  | {
      rail: {
        net: string;
        kind: NetKind;
      };
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PortBinding".
 */
export type PortBinding =
  | {
      net: string;
    }
  | "new"
  | {
      rail: {
        net: string;
        volts: number;
      };
    };
/**
 * What to trial: a template at targets (the composer's `use_template`, or the fallback), or a
 * draft.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockRequest".
 */
export type BlockRequest =
  | {
      template: InsertBlock;
    }
  | {
      draft: DraftBlock;
    };
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "IssueCode".
 */
export type IssueCode = ErrorCode | ErcCode;
/**
 * One event on `GET /v1/jobs/{id}/events`. On the wire, `event` is the SSE event name, `data`
 * its JSON, and the event's sequence number its SSE `id`, which a reconnect resumes from.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "JobEvent".
 */
export type JobEvent =
  | {
      event: "job.state";
      data: JobStateData;
    }
  | {
      event: "narration.delta";
      data: NarrationData;
    }
  | {
      event: "block.ghost";
      data: GhostData;
    }
  | {
      event: "op";
      data: OpEnvelope;
    }
  | {
      event: "block.repair";
      data: RepairData;
    }
  | {
      event: "sim.summary";
      data: SimSummaryData;
    }
  | {
      event: "error";
      data: ApiError;
    }
  | {
      event: "done";
      data: DoneData;
    }
  | {
      event: "heartbeat";
    };
/**
 * A generation job's state (LLD §6). `failed` and `cancelled` can follow any other state.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "JobState".
 */
export type JobState =
  | "queued"
  | "planning"
  | "composing"
  | "verifying"
  | "repairing"
  | "fallback"
  | "committing"
  | "done"
  | "failed"
  | "cancelled";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "LessonKind".
 */
export type LessonKind = "narration" | "note" | "repair";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "GenerateMode".
 */
export type GenerateMode = "compose" | "templates";
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "LearnerLevel".
 */
export type LearnerLevel = "beginner" | "intermediate" | "advanced";

/**
 * All circuit-core wire types. Generated by circuit-core; do not edit.
 */
export interface Contract {
  [k: string]: unknown | undefined;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Circuit".
 */
export interface Circuit {
  schema_version: number;
  registry_version: string;
  /**
   * +1 per applied op (narration excluded).
   */
  rev: number;
  parts: {
    [k: string]: PartInstance | undefined;
  };
  nets: {
    [k: string]: Net | undefined;
  };
  blocks: {
    [k: string]: Block | undefined;
  };
  analyses: Analysis[];
  /**
   * Kept sorted and de-duplicated so the order never depends on edit history.
   */
  hints: LayoutHint[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartInstance".
 */
export interface PartInstance {
  refdes: string;
  part: string;
  /**
   * Every param declared by the registry part, keyed by name ("resistance" -> 10kΩ).
   */
  params: {
    [k: string]: Quantity | undefined;
  };
  block?: string | null;
  origin: Origin;
  pinned?: Placement | null;
}
/**
 * A parsed physical value. `display` is canonical and round-trips exactly through [`parse_quantity`].
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Quantity".
 */
export interface Quantity {
  si: number;
  unit: Unit;
  display: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Placement".
 */
export interface Placement {
  x: number;
  y: number;
  /**
   * Degrees: 0, 90, 180 or 270.
   */
  rot?: number;
  flip?: boolean;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Net".
 */
export interface Net {
  id: string;
  pins: PinRef[];
  kind: NetKind;
  label?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Block".
 */
export interface Block {
  id: string;
  role: BlockRole;
  title: string;
  spec: {
    [k: string]: SpecTarget | undefined;
  };
  ports: BlockPort[];
  status: BlockStatus;
  template?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SpecTarget".
 */
export interface SpecTarget {
  target: number;
  tol_pct: number;
}
/**
 * A named interface of a block, bound to the net that carries it (checked by ERC009).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockPort".
 */
export interface BlockPort {
  name: string;
  direction: PortDirection;
  net: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockBegin".
 */
export interface BlockBegin {
  id: string;
  role: BlockRole;
  title: string;
  spec?: {
    [k: string]: SpecTarget | undefined;
  };
  ports?: BlockPort[];
  template?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockRef".
 */
export interface BlockRef {
  id: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockAbort".
 */
export interface BlockAbort {
  id: string;
  reason: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockSetStatus".
 */
export interface BlockSetStatus {
  id: string;
  status: BlockStatus;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartAdd".
 */
export interface PartAdd {
  refdes: string;
  part: string;
  /**
   * Values as written ("10k", "4.7u"); unspecified params take the registry default.
   */
  params?: {
    [k: string]: string | undefined;
  };
  block?: string | null;
  /**
   * Normally derived from the envelope; set explicitly by inverse ops so undo restores it.
   */
  origin?: Origin | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartRef".
 */
export interface PartRef {
  refdes: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartSetParam".
 */
export interface PartSetParam {
  refdes: string;
  key: string;
  value: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartSwap".
 */
export interface PartSwap {
  refdes: string;
  part: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartPin".
 */
export interface PartPin {
  refdes: string;
  placement?: Placement | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NetConnect".
 */
export interface NetConnect {
  net: string;
  pins: PinRef[];
  /**
   * Applied when the net is created; must match if the net exists.
   */
  kind?: NetKind | null;
  label?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NetDisconnect".
 */
export interface NetDisconnect {
  net: string;
  pins: PinRef[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NetRename".
 */
export interface NetRename {
  from: string;
  to: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "AnalysisSet".
 */
export interface AnalysisSet {
  analyses: Analysis[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "HintBody".
 */
export interface HintBody {
  hint: LayoutHint;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Narrate".
 */
export interface Narrate {
  refs: string[];
  text: string;
  block?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "OpError".
 */
export interface OpError {
  code: ErrorCode;
  message: string;
  /**
   * Index of the failing op within a batch (`apply_all`).
   */
  op_index?: number | null;
}
/**
 * What changed, by id, so the UI never needs the whole circuit per op (LLD §10).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Patch".
 */
export interface Patch {
  parts_upserted: string[];
  parts_removed: string[];
  nets_upserted: string[];
  nets_removed: string[];
  blocks_upserted: string[];
  blocks_removed: string[];
  analyses_changed: boolean;
  hints_changed: boolean;
}
/**
 * What a successful `apply` reports to the UI: only what changed (LLD §10).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ApplyOk".
 */
export interface ApplyOk {
  rev: number;
  patch: Patch;
  /**
   * Ops that undo this change, in the order they must be applied.
   */
  inverse: Op[];
}
/**
 * The current state of everything a [`Patch`] names, so a UI mirror can update itself without
 * reading the whole circuit (LLD §10). Removed ids are in the patch itself.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PatchData".
 */
export interface PatchData {
  rev: number;
  parts: {
    [k: string]: PartInstance | undefined;
  };
  nets: {
    [k: string]: Net | undefined;
  };
  blocks: {
    [k: string]: Block | undefined;
  };
  /**
   * Present when `patch.analyses_changed`.
   */
  analyses?: Analysis[] | null;
  /**
   * Present when `patch.hints_changed`.
   */
  hints?: LayoutHint[] | null;
}
/**
 * Outcome of a trial batch (the orchestrator's composer draft).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Trial".
 */
export interface Trial {
  circuit: Circuit;
  /**
   * Every rejected op, with `op_index` set. Rejected ops are skipped; the rest still apply,
   * so the LLM gets all its mistakes back in one repair round.
   */
  errors: OpError[];
  /**
   * Undo for the ops that did apply.
   */
  inverse: Op[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ErcIssue".
 */
export interface ErcIssue {
  rule: string;
  code: ErcCode;
  severity: Severity;
  message: string;
  parts?: string[];
  nets?: string[];
  pins?: PinRef[];
  block?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CompileOpts".
 */
export interface CompileOpts {
  /**
   * Add a 1 GΩ shunt to ground on every node without a DC path (user circuits, ERC003),
   * so the simulation still runs and the tutor can explain the problem.
   */
  shunt_floating?: boolean;
  /**
   * Override the circuit's analyses. `None` uses `circuit.analyses`, or `.op` if that is empty.
   */
  analyses?: Analysis[] | null;
  /**
   * Without `analyses`: the editor's set, [`interactive_analyses`].
   */
  interactive?: boolean;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Netlist".
 */
export interface Netlist {
  /**
   * Deterministic: parts in natural refdes order.
   */
  text: string;
  /**
   * Lowercase hex sha256 of `text`.
   */
  hash: string;
  /**
   * IR net id -> SPICE node name ("N_VOUT" -> "n_vout", "GND" -> "0").
   */
  node_map: {
    [k: string]: string | undefined;
  };
  /**
   * Registry model files the simulator must load, relative to the registry root.
   */
  includes: string[];
  /**
   * Spec checks as primitive `.meas` statements, in replay order (later cards may use earlier
   * results).
   */
  meas: MeasDef[];
  /**
   * The spec checks of every template block, and which `meas` results each combines
   * ([`crate::template::evaluate_checks`]).
   */
  checks: SpecCheckDef[];
  /**
   * Current into each connected pin (`"R1.1"`), as a sum of saved vectors, for the overlays
   * and current probes. OP and transient plots only: device currents do not exist in AC.
   * Pins inside subcircuit models (op-amps, regulators) are absent; a net with one such pin
   * gets its current by KCL.
   */
  pin_currents: {
    [k: string]: CurrentTerm[] | undefined;
  };
  /**
   * The analyses in the deck, in order (resolved from `CompileOpts`).
   */
  analyses: Analysis[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "MeasDef".
 */
export interface MeasDef {
  name: string;
  line: string;
}
/**
 * A check as compiled into one netlist: which `.meas` results it combines.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SpecCheckDef".
 */
export interface SpecCheckDef {
  block: string;
  name: string;
  label: string;
  symbol: string;
  kind: CheckKind;
  unit: Unit;
  target: number;
  tol_pct: number;
  /**
   * `.meas` result names, in the order the kind combines them. Empty when `missing` is set.
   */
  meas: string[];
  /**
   * Why the check could not be compiled into this netlist ("needs an AC analysis").
   */
  missing?: string | null;
}
/**
 * `coeff · vector`, e.g. `-1 · @r1[i]`.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CurrentTerm".
 */
export interface CurrentTerm {
  /**
   * Canonical result vector name: `@r1[i]`, `i(v1)`, `@q1[ic]`.
   */
  vector: string;
  coeff: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CompileError".
 */
export interface CompileError {
  refdes?: string | null;
  message: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Registry".
 */
export interface Registry {
  version: string;
  parts: {
    [k: string]: PartDef | undefined;
  };
  /**
   * Schematic symbols by id (`symbols/<id>.svg`): geometry only; the drawings ship in the
   * bundle's sprite sheet.
   */
  symbols: {
    [k: string]: SymbolDef | undefined;
  };
  /**
   * Block templates by id (`templates/<id>.yaml`), each checked against the parts at load.
   */
  templates?: {
    [k: string]: TemplateDef | undefined;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PartDef".
 */
export interface PartDef {
  id: string;
  category: Category;
  title: string;
  role_tags?: string[];
  /**
   * Units of a multi-unit IC (e.g. `[A, B]` for a dual op-amp). Empty for single-unit parts.
   */
  units?: string[];
  pins: PinDef[];
  /**
   * Every param must declare a default, so instances always carry a full param set.
   */
  params?: {
    [k: string]: ParamDef | undefined;
  };
  /**
   * Ratings used by ERC, e.g. `v_supply_max`, `i_max`, `p_max`.
   */
  limits?: {
    [k: string]: number | undefined;
  };
  /**
   * For voltage sources: the param holding V(P) − V(N) at DC (used by ERC007).
   */
  dc_param?: string | null;
  spice?: SpiceDef | null;
  /**
   * Schematic symbol, `symbols/<id>.svg`; its pin anchors are matched by pin name.
   */
  symbol: string;
  breadboard?: string | null;
  teach?: string | null;
  hazard?: Hazard | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "PinDef".
 */
export interface PinDef {
  name: string;
  num: number;
  type: PinType;
  unit?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ParamDef".
 */
export interface ParamDef {
  unit: Unit;
  default: string;
  /**
   * In SI units. YAML sources may write a prefixed number such as `1p` or `100meg`.
   */
  min?: number | null;
  max?: number | null;
}
/**
 * SPICE emission template. `line` is for single-unit parts; `unit_line` is emitted once per
 * used unit of a multi-unit part. Placeholders: `{refdes}`, `{unit}`, pin names, param names.
 * In `unit_line`, a unit pin is named without its `_<unit>` suffix (`{OUT}` → `OUT_A`).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SpiceDef".
 */
export interface SpiceDef {
  include?: string | null;
  line?: string | null;
  unit_line?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SymbolDef".
 */
export interface SymbolDef {
  /**
   * Size in schematic units (multiples of [`GRID`]).
   */
  width: number;
  height: number;
  /**
   * Pin anchors by pin name (base name for the unit pins of a multi-unit part).
   */
  pins: {
    [k: string]: Anchor | undefined;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Anchor".
 */
export interface Anchor {
  x: number;
  y: number;
  /**
   * The edge the anchor sits on; wires leave the symbol in this direction.
   */
  side: "left" | "right" | "top" | "bottom";
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "TemplateDef".
 */
export interface TemplateDef {
  id: string;
  version: number;
  role: BlockRole;
  title: string;
  teach?: string | null;
  /**
   * What the user asks for, in order (the insert form shows them in this order).
   */
  targets?: {
    [k: string]: TargetDef | undefined;
  };
  /**
   * The block's interface: port name -> direction.
   */
  ports: {
    [k: string]: PortDirection | undefined;
  };
  /**
   * The supply each power port expects: default rail and the range the design works over.
   */
  rails?: {
    [k: string]: RailDef | undefined;
  };
  /**
   * Local refdes (R1, C1, U1, ...) -> registry part. Renumbered on instantiation.
   */
  parts: {
    [k: string]: TemplatePart | undefined;
  };
  /**
   * Port or internal net name -> pins (`R1.2`, `U1.OUT_A`). Every port has one.
   */
  nets: {
    [k: string]: PinRef[] | undefined;
  };
  /**
   * A solver in [`solvers`], by name.
   */
  solver: string;
  checks: CheckDef[];
  /**
   * The test bench CI simulates the template in (LLD §12 step 2).
   */
  verify?: VerifyBench | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "TargetDef".
 */
export interface TargetDef {
  label: string;
  unit: Unit;
  /**
   * In SI units; YAML may write `10`, `50k` or `1meg`.
   */
  min: number;
  max: number;
  /**
   * As the user would type it.
   */
  default: string;
  /**
   * How verification spreads its points (frequencies and gains are `log`).
   */
  scale?: "lin" | "log";
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "RailDef".
 */
export interface RailDef {
  /**
   * The rail this port binds to by default (created if missing).
   */
  net: string;
  volts: number;
  /**
   * The supply range the design is verified over; absent means exactly `volts`.
   */
  min?: number | null;
  max?: number | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "TemplatePart".
 */
export interface TemplatePart {
  part: string;
}
/**
 * One spec check: what to measure (a closed set of kinds, so a template can never inject SPICE)
 * on which ports. Its target is the block's `spec[name]`.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CheckDef".
 */
export interface CheckDef {
  name: string;
  label: string;
  /**
   * A few characters for badges on the drawing: `fc`, `Q`, `Vth+`.
   */
  symbol: string;
  kind: CheckKind;
  /**
   * Output port measured.
   */
  out: string;
  /**
   * Input port (gain reference, threshold input).
   */
  in?: string | null;
  /**
   * Which side of a corner is the pass band (corner and Q checks).
   */
  pass?: Pass | null;
  /**
   * Output edge whose input level is the threshold (threshold checks).
   */
  edge?: Edge | null;
  /**
   * Frequency a gain is measured at; default 1 kHz.
   */
  at_hz?: number | null;
  /**
   * The transient a time-domain check needs. Regenerative circuits (a Schmitt trigger) switch
   * late in simulation unless the steps are near the op-amp's own speed: with coarse steps the
   * integrator follows the unstable balance point until it hits a rail.
   */
  tran?: TranWindow | null;
  tol_pct: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "TranWindow".
 */
export interface TranWindow {
  /**
   * Run length, seconds.
   */
  stop: number;
  /**
   * Largest step, seconds.
   */
  step: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "VerifyBench".
 */
export interface VerifyBench {
  /**
   * A sine source from each listed port to ground.
   */
  drive?: {
    [k: string]: Drive | undefined;
  };
  /**
   * A resistor from each listed port to ground, in ohms.
   */
  load?: {
    [k: string]: number | undefined;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Drive".
 */
export interface Drive {
  amplitude: number;
  frequency: number;
  offset?: number;
}
/**
 * Insert a block from a template (the editor's "insert block", the generator's fallback).
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "InsertBlock".
 */
export interface InsertBlock {
  template: string;
  /**
   * Target values as typed ("1k", "0.707"); a missing target takes the template default.
   */
  targets?: {
    [k: string]: string | undefined;
  };
  /**
   * How each port is wired; a missing port takes its default (signals: a new net; power: the
   * template's rail; ground: GND).
   */
  ports?: {
    [k: string]: PortBinding | undefined;
  };
  /**
   * Block id; default the lowest free `bN`.
   */
  id?: string | null;
}
/**
 * What inserting would produce, before anything is applied: the insert form shows it.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Preview".
 */
export interface Preview {
  template: string;
  targets: {
    [k: string]: Quantity | undefined;
  };
  /**
   * Supply volts per power port.
   */
  rails: {
    [k: string]: number | undefined;
  };
  /**
   * Solved part values by the template's local refdes.
   */
  values: {
    [k: string]:
      | {
          [k: string]: Quantity | undefined;
        }
      | undefined;
  };
  /**
   * The block's spec: every check's target and tolerance.
   */
  spec: {
    [k: string]: SpecTarget | undefined;
  };
  /**
   * Each spec target formatted for reading (`1kHz`, `0.707`, `2.5V`).
   */
  spec_display: {
    [k: string]: string | undefined;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Inserted".
 */
export interface Inserted {
  block: string;
  /**
   * Apply as one batch (author `template`): one undo step.
   */
  ops: Op[];
  /**
   * Local refdes -> refdes in the circuit.
   */
  refdes: {
    [k: string]: string | undefined;
  };
  preview: Preview;
}
/**
 * One check's outcome (LLD §7: `{name, target, measured, tol_pct, pass}`), with the numbers
 * already formatted by the core so no client formats units itself.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CheckResult".
 */
export interface CheckResult {
  block: string;
  name: string;
  label: string;
  symbol: string;
  unit: Unit;
  target: number;
  tol_pct: number;
  measured?: number | null;
  pass: boolean;
  target_display: string;
  measured_display?: string | null;
  /**
   * Why there is no measurement.
   */
  note?: string | null;
}
/**
 * One verification point: target values as text (what a user would type) and rail volts.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "VerifyPoint".
 */
export interface VerifyPoint {
  targets: {
    [k: string]: string | undefined;
  };
  rails: {
    [k: string]: number | undefined;
  };
}
/**
 * A block drafted part by part, in the shape of a template's `parts` and `nets`. Refs are the
 * draft's own (`R1`, `U1`: category letter and number) and are renumbered on insertion. A net
 * named after a port of the reference template is that port, `gnd` is ground, and any other
 * name is internal to the block.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "DraftBlock".
 */
export interface DraftBlock {
  /**
   * The reference template: ports, rails, spec checks, fallback.
   */
  template: string;
  /**
   * Target values as typed; a missing target takes the template default.
   */
  targets?: {
    [k: string]: string | undefined;
  };
  ports?: {
    [k: string]: PortBinding | undefined;
  };
  id?: string | null;
  /**
   * Default: the template's title.
   */
  title?: string | null;
  parts: DraftPart[];
  nets: DraftNet[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "DraftPart".
 */
export interface DraftPart {
  ref: string;
  part: string;
  /**
   * Values as written (`"10k"`); unspecified params take the registry default.
   */
  params?: {
    [k: string]: string | undefined;
  };
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "DraftNet".
 */
export interface DraftNet {
  name: string;
  /**
   * `R1.2`, `U1.OUT_A`, in the draft's refs. Text, so a malformed pin is one problem, not a
   * rejected draft.
   */
  pins: string[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "BlockTrial".
 */
export interface BlockTrial {
  block: string;
  template: string;
  /**
   * Author of `ops`: `llm` for a draft, `template` for a template block.
   */
  author: "llm" | "user" | "template";
  /**
   * Ops that add the block to the circuit, `block.begin` … `block.commit`, trial-applied.
   * Empty when there are problems.
   */
  ops: Op[];
  /**
   * Request ref (template local or draft ref) -> refdes in the circuit.
   */
  refdes: {
    [k: string]: string | undefined;
  };
  spec: {
    [k: string]: SpecTarget | undefined;
  };
  spec_display: {
    [k: string]: string | undefined;
  };
  /**
   * Everything that rejects the block. Empty means: simulate `bench`, then check its spec.
   */
  problems: Problem[];
  /**
   * ERC findings that do not reject a generated block (an unused op-amp unit).
   */
  warnings: ErcIssue[];
  /**
   * The block alone in its verification bench, compiled with the editor's analyses and the
   * block's checks as `.meas` cards. Absent when there are problems.
   */
  bench?: Netlist | null;
}
/**
 * One reason a block cannot commit, returned to the composer verbatim during repair.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Problem".
 */
export interface Problem {
  code: IssueCode;
  message: string;
  /**
   * The request line it comes from: `part R1`, `net n_a` or `block`.
   */
  at?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "JobStateData".
 */
export interface JobStateData {
  state: JobState;
  block?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "NarrationData".
 */
export interface NarrationData {
  block?: string | null;
  text: string;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "GhostData".
 */
export interface GhostData {
  id: string;
  title: string;
  role: BlockRole;
  ports: GhostPort[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "GhostPort".
 */
export interface GhostPort {
  name: string;
  direction: PortDirection;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "RepairData".
 */
export interface RepairData {
  id: string;
  /**
   * The attempt that failed, from 1.
   */
  attempt: number;
  /**
   * Its problem codes (`pin_not_found`, `floating_pin`, `spec_miss`, ...).
   */
  errors: string[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "SimSummaryData".
 */
export interface SimSummaryData {
  block: string;
  checks: CheckResult[];
}
/**
 * Every error body and the stream's `error` event: `code` is stable (`stale_rev`,
 * `not_found`, `rate_limited`, ...), `message` is for people.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ApiError".
 */
export interface ApiError {
  code: string;
  message: string;
  retryable?: boolean;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "DoneData".
 */
export interface DoneData {
  rev: number;
  usage: Usage;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Usage".
 */
export interface Usage {
  in_tokens: number;
  out_tokens: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "AnonymousSession".
 */
export interface AnonymousSession {
  /**
   * Bearer token for `Authorization`.
   */
  token: string;
  user_id: string;
  /**
   * Seconds until the token expires.
   */
  expires_in: number;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "CreateProject".
 */
export interface CreateProject {
  title?: string | null;
}
/**
 * `GET /v1/projects/{id}`: everything an editor opens.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "ProjectSnapshot".
 */
export interface ProjectSnapshot {
  project: Project;
  circuit: Circuit1;
  lesson: LessonEntry[];
  /**
   * A generation job still running on this project, if any (the editor stays read-only).
   */
  active_job?: string | null;
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "Project".
 */
export interface Project {
  id: string;
  title: string;
  /**
   * Fixed for the project's life: symbols, pin maps and models never change silently.
   */
  registry_version: string;
  head_rev: number;
  /**
   * RFC 3339.
   */
  created_at: string;
  updated_at: string;
}
/**
 * At `project.head_rev`.
 */
export interface Circuit1 {
  schema_version: number;
  registry_version: string;
  /**
   * +1 per applied op (narration excluded).
   */
  rev: number;
  parts: {
    [k: string]: PartInstance | undefined;
  };
  nets: {
    [k: string]: Net | undefined;
  };
  blocks: {
    [k: string]: Block | undefined;
  };
  analyses: Analysis[];
  /**
   * Kept sorted and de-duplicated so the order never depends on edit history.
   */
  hints: LayoutHint[];
}
/**
 * One line of a project's lesson track: narration and notes, replayable with their blocks.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "LessonEntry".
 */
export interface LessonEntry {
  seq: number;
  block?: string | null;
  kind: LessonKind;
  text: string;
  refs?: string[];
}
/**
 * `POST /v1/projects/{id}/ops`: user ops since `base_rev`, applied in order. A mismatched
 * `base_rev` is 409 `stale_rev`, and the client reloads the snapshot.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "AppendOps".
 */
export interface AppendOps {
  base_rev: number;
  ops: OpEnvelope[];
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "AppendOk".
 */
export interface AppendOk {
  rev: number;
}
/**
 * `POST /v1/projects/{id}/generate`.
 *
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "GenerateRequest".
 */
export interface GenerateRequest {
  prompt: string;
  mode?: "compose" | "templates";
  level?: "beginner" | "intermediate" | "advanced";
}
/**
 * This interface was referenced by `Contract`'s JSON-Schema
 * via the `definition` "JobAccepted".
 */
export interface JobAccepted {
  job_id: string;
}
