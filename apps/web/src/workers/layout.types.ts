// Layout worker contract (LLD §10). Hand-written: layout output never crosses the REST/SSE
// boundary. Positions come only from the registry's symbols and this layout; the IR's only
// coordinate is a part's `pinned` placement, which the layout respects.
import type { BlockPort, NetKind, PinType, Placement, SymbolDef } from "../gen/contract.ts";
import type { Point, Rot } from "./layout.geometry.ts";

/** What layout needs from the registry bundle; sent to the worker once. */
export interface LayoutRegistry {
  parts: Record<string, { symbol: string; units: string[]; pins: { name: string; unit?: string | null; type: PinType }[] }>;
  symbols: Record<string, SymbolDef>;
}

/** The circuit's topology. Param values are left out, so editing a value never re-lays out. */
export interface LayoutInput {
  parts: { refdes: string; part: string; block?: string | null; pinned?: Placement | null }[];
  nets: { id: string; kind: NetKind; label?: string | null; pins: string[] }[];
  /** In IR order; ties in signal order follow it. */
  blocks: { id: string; title: string; ports: BlockPort[] }[];
}

/** One drawn symbol: a whole part, or one unit of a multi-unit part. */
export interface PlacedSymbol {
  /** `R1`, or `U1:A` for unit A of U1. */
  key: string;
  refdes: string;
  unit: string | null;
  /** Symbol id; the sprite sheet holds it as `sym-<id>`. */
  symbol: string;
  /** Top-left corner of the rotated bounding box. */
  x: number;
  y: number;
  rot: Rot;
  flip: boolean;
  /** Bounding box after rotation. */
  width: number;
  height: number;
  /** The symbol's own size, which the `<use>` needs. */
  symbolWidth: number;
  symbolHeight: number;
  /** Where the reference and value go: a side without pins. `y` is the first line's baseline. */
  label: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

/** A VCC/GND flag drawn instead of a power or ground wire (LLD §10). */
export interface PlacedFlag {
  key: string;
  net: string;
  symbol: string;
  x: number;
  y: number;
  rot: Rot;
  width: number;
  height: number;
  symbolWidth: number;
  symbolHeight: number;
  /** Power flags carry the net's name; ground flags none. */
  text: string | null;
  textAt: Point;
  textAnchor: "start" | "middle" | "end";
}

export interface BlockFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

export interface Layout {
  symbols: Record<string, PlacedSymbol>;
  /** Orthogonal polylines per signal net. */
  wires: Record<string, Point[][]>;
  /** Dots where a net's wires branch. */
  junctions: Record<string, Point[]>;
  flags: PlacedFlag[];
  blocks: Record<string, BlockFrame>;
  /** Absolute pin positions by `REFDES.PIN` (a shared pin appears once per drawn unit). */
  pins: Record<string, Point[]>;
  /** Where a net's live value is shown. */
  netLabels: Record<string, Point & { anchor: "start" | "middle" | "end" }>;
  bounds: { x: number; y: number; width: number; height: number };
  stats: { ms: number; blocks: number; cachedBlocks: number };
}

export interface LayoutApi {
  init(registry: LayoutRegistry): Promise<void>;
  layout(input: LayoutInput): Promise<Layout>;
}
