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
  | "forbidden";
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
 * via the `definition` "Side".
 */
export type Side = "left" | "right" | "top" | "bottom";

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
   * Override the circuit's analyses (e.g. the interactive default). `None` uses
   * `circuit.analyses`, or `.op` if that is empty.
   */
  analyses?: Analysis[] | null;
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
   * Spec checks as `.meas` statements (filled once block templates define them).
   */
  meas: MeasDef[];
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
