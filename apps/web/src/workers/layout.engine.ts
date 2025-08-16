// Two-level schematic layout (LLD §10). Pure apart from ELK, which is injected, so the same code
// runs in the layout worker and in Node tests.
//
// 1. Each block is laid out on its own with ELK `layered` (direction RIGHT, orthogonal routing,
//    FIXED_POS ports at the symbols' pin anchors). Nets that leave the block end at ports on its
//    frame: inputs on the west side, outputs on the east. The result is cached by the block's
//    content (the ELK graph itself), so a block is laid out again only when its topology changes.
// 2. Blocks are placed left to right in signal order, each aligned with the block that drives
//    it. This level is deterministic and appends: adding a downstream block never moves earlier
//    blocks. Wires between blocks run through channels in the gaps between blocks, or over the
//    top when they skip a block.
// 3. Power and ground nets are not wired: every pin on them gets a flag. Flags are part of their
//    symbol's footprint during layout, so nothing is placed on top of them.
// 4. Parts with a `pinned` placement are placed exactly there (LLD §3: only a user drag sets it)
//    and joined to the rest of their nets with short orthogonal wires.
import type { ElkExtendedEdge, ElkNode, ElkPort } from "elkjs/lib/elk-api";
import type { BlockPort, NetKind, Side, SymbolDef } from "../gen/contract.ts";
import {
  OPPOSITE,
  OUTWARD,
  ROTATIONS,
  type Point,
  type Rot,
  rotatedSize,
  toRot,
  transformPoint,
  transformSide,
} from "./layout.geometry.ts";
import type {
  BlockFrame,
  Layout,
  LayoutInput,
  LayoutRegistry,
  PlacedFlag,
  PlacedSymbol,
} from "./layout.types.ts";

export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export const FLAG_GROUND = "flag_ground";
export const FLAG_POWER = "flag_power";
/** Group for parts that belong to no block (drawn without a frame). */
export const FREE = "~free";

const GAP = 40; // minimum gap between blocks
const CHANNEL = 10; // spacing of the vertical wire channels in a gap
const LANE = 10; // spacing of the wires that pass over the top
const FRAME_TITLE = 24; // room above a block frame for its title
const EMPTY_BLOCK = { width: 120, height: 60 };
const CACHE_SIZE = 128;

const ELK_SIDE: Record<Side, string> = { left: "WEST", right: "EAST", top: "NORTH", bottom: "SOUTH" };

const BLOCK_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.portConstraints": "FIXED_SIDE",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.mergeEdges": "true",
  "elk.layered.spacing.nodeNodeBetweenLayers": "40",
  "elk.layered.spacing.edgeNodeBetweenLayers": "20",
  "elk.spacing.nodeNode": "30",
  "elk.spacing.edgeNode": "20",
  "elk.spacing.edgeEdge": "10",
  "elk.spacing.componentComponent": "40",
  "elk.padding": "[top=20,left=20,bottom=20,right=20]",
};

type NetClass = "signal" | "ground" | "pos" | "neg";

function netClass(kind: NetKind): NetClass {
  if (kind.kind === "ground") return "ground";
  if (kind.kind === "power") return kind.volts < 0 ? "neg" : "pos";
  return "signal";
}

interface NodePin {
  pin: string;
  /** Relative to the node's footprint (symbol plus flag room). */
  at: Point;
  side: Side;
  net?: string;
}

interface Node {
  key: string;
  refdes: string;
  /** Registry part id. */
  part: string;
  unit: string | null;
  group: string;
  symbol: string;
  def: SymbolDef;
  rot: Rot;
  flip: boolean;
  width: number;
  height: number;
  /** Footprint padding that holds the flags. */
  pad: { left: number; top: number; right: number; bottom: number };
  pins: NodePin[];
  /** Flags relative to the symbol's top-left corner. */
  flags: PlacedFlag[];
  /** Reference/value label relative to the symbol's top-left corner. */
  label: PlacedSymbol["label"];
  pinned?: { x: number; y: number };
}

interface BlockLayout {
  width: number;
  height: number;
  nodes: Record<string, Point>;
  ports: Record<string, { x: number; y: number; side: Side }>;
  wires: Record<string, Point[][]>;
}

interface Endpoint {
  node: Node;
  pin: NodePin;
}

export class LayoutEngine {
  private readonly cache = new Map<string, BlockLayout>();
  private readonly reg: LayoutRegistry;
  private readonly elk: ElkLike;

  constructor(reg: LayoutRegistry, elk: ElkLike) {
    this.reg = reg;
    this.elk = elk;
  }

  async layout(input: LayoutInput): Promise<Layout> {
    const started = performance.now();
    const nets = new Map(input.nets.map((n) => [n.id, n]));
    const netOf = new Map<string, string>();
    for (const n of input.nets) for (const p of n.pins) netOf.set(p, n.id);
    const blockIds = new Set(input.blocks.map((b) => b.id));

    // Symbols (one per used unit), oriented, with their flags.
    const nodes: Node[] = [];
    for (const part of input.parts) {
      const group = part.block && blockIds.has(part.block) ? part.block : FREE;
      nodes.push(...this.partNodes(part, group, netOf, nets));
    }

    // Signal-net endpoints; power and ground pins carry flags instead.
    const endpoints = new Map<string, Endpoint[]>();
    for (const node of nodes) {
      for (const pin of node.pins) {
        if (!pin.net || netClass(nets.get(pin.net)!.kind) !== "signal") continue;
        const list = endpoints.get(pin.net) ?? [];
        list.push({ node, pin });
        endpoints.set(pin.net, list);
      }
    }

    // Level 1: every group on its own.
    const order = signalOrder(input, nodes);
    const groupOf = (e: Endpoint) => e.node.group;
    const groupsOfNet = new Map<string, string[]>();
    for (const [net, eps] of endpoints) {
      const gs = [...new Set(eps.filter((e) => !e.node.pinned).map(groupOf))];
      groupsOfNet.set(net, gs.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
    const portSide = (group: string, net: string): Side => {
      const declared = input.blocks.find((b) => b.id === group)?.ports.find((p) => p.net === net);
      if (declared?.direction === "input") return "left";
      if (declared?.direction === "output") return "right";
      const driver = endpoints.get(net)!.find((e) => !e.node.pinned && this.pinType(e) === "output");
      return group === (driver ? groupOf(driver) : groupsOfNet.get(net)![0]) ? "right" : "left";
    };

    let cachedBlocks = 0;
    const blockLayouts = new Map<string, BlockLayout>();
    for (const group of order) {
      const members = nodes.filter((n) => n.group === group && !n.pinned);
      const declared = input.blocks.find((b) => b.id === group)?.ports ?? [];
      const graph = this.blockGraph(group, members, endpoints, groupsOfNet, portSide, declared);
      const key = JSON.stringify(graph);
      let bl = this.cache.get(key);
      if (bl) {
        cachedBlocks++;
        this.cache.delete(key); // refresh its LRU position
      } else {
        bl = members.length ? parseBlock(await this.elk.layout({ id: "root", layoutOptions: { "elk.algorithm": "fixed" }, children: [graph] })) : emptyBlock();
      }
      this.cache.set(key, bl);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      blockLayouts.set(group, bl);
    }

    // Level 2: blocks left to right, wires between them through the gaps.
    const out = placeBlocks(order, blockLayouts, groupsOfNet, input);

    const symbols: Record<string, PlacedSymbol> = {};
    const flags: PlacedFlag[] = [];
    const pins: Record<string, Point[]> = {};
    const place = (node: Node, x: number, y: number) => {
      symbols[node.key] = {
        key: node.key,
        refdes: node.refdes,
        unit: node.unit,
        symbol: node.symbol,
        x,
        y,
        rot: node.rot,
        flip: node.flip,
        width: node.width,
        height: node.height,
        symbolWidth: node.def.width,
        symbolHeight: node.def.height,
        label: { ...node.label, x: node.label.x + x, y: node.label.y + y },
      };
      for (const f of node.flags) {
        flags.push({ ...f, x: f.x + x, y: f.y + y, textAt: { x: f.textAt.x + x, y: f.textAt.y + y } });
      }
      for (const p of node.pins) {
        const ref = `${node.refdes}.${p.pin}`;
        (pins[ref] ??= []).push({ x: x + p.at.x - node.pad.left, y: y + p.at.y - node.pad.top });
      }
    };
    for (const node of nodes) {
      if (node.pinned) {
        place(node, node.pinned.x, node.pinned.y);
      } else {
        const origin = out.origins.get(node.group)!;
        const at = blockLayouts.get(node.group)!.nodes[node.key]!;
        place(node, origin.x + at.x + node.pad.left, origin.y + at.y + node.pad.top);
      }
    }

    // Pinned parts: join each of their signal pins to the nearest point of its net.
    const wires = out.wires;
    for (const [net, eps] of endpoints) {
      const pinnedEps = eps.filter((e) => e.node.pinned);
      if (!pinnedEps.length) continue;
      const pool: Point[] = (wires[net] ?? []).flat();
      for (const e of eps.filter((e) => !e.node.pinned)) pool.push(...(pins[`${e.node.refdes}.${e.pin.pin}`] ?? []));
      for (const e of pinnedEps) {
        for (const p of pins[`${e.node.refdes}.${e.pin.pin}`] ?? []) {
          const q = nearest(pool, p);
          if (q) {
            const dir = OUTWARD[e.pin.side];
            const stub = { x: p.x + dir.x * 10, y: p.y + dir.y * 10 };
            (wires[net] ??= []).push(dedupe([p, stub, { x: q.x, y: stub.y }, q]));
          }
          pool.push(p);
        }
      }
    }

    const junctions: Record<string, Point[]> = {};
    for (const [net, polylines] of Object.entries(wires)) {
      const netPins = (nets.get(net)?.pins ?? []).flatMap((p) => pins[p] ?? []);
      const dots = findJunctions(polylines, netPins);
      if (dots.length) junctions[net] = dots;
    }

    const netLabels: Layout["netLabels"] = {};
    for (const n of input.nets) {
      const cls = netClass(n.kind);
      if (cls === "ground") continue;
      if (cls === "signal") {
        const at = labelPoint(wires[n.id]) ?? n.pins.map((p) => pins[p]?.[0]).find(Boolean);
        if (at) netLabels[n.id] = { ...at, anchor: "middle" };
      } else {
        const f = flags.find((f) => f.net === n.id);
        // The rail's live value goes beside its name, away from the flag.
        if (f) netLabels[n.id] = { x: f.textAt.x, y: f.textAt.y + (f.textAt.y < f.y ? -11 : 11), anchor: f.textAnchor };
      }
    }

    return {
      symbols,
      wires,
      junctions,
      flags,
      blocks: out.frames,
      pins,
      netLabels,
      bounds: bounds(Object.values(symbols), flags, out.frames, wires),
      stats: { ms: performance.now() - started, blocks: order.length, cachedBlocks },
    };
  }

  private pinType(e: Endpoint) {
    const part = this.reg.parts[e.node.part];
    return part?.pins.find((p) => p.name === e.pin.pin)?.type;
  }

  private partNodes(
    part: LayoutInput["parts"][number],
    group: string,
    netOf: Map<string, string>,
    nets: Map<string, LayoutInput["nets"][number]>,
  ): Node[] {
    const def = this.reg.parts[part.part];
    const symbol = def && /^symbols\/([a-z0-9_]+)\.svg$/.exec(def.symbol)?.[1];
    const sym = symbol ? this.reg.symbols[symbol] : undefined;
    if (!def || !symbol || !sym) return []; // the core only accepts registry parts; a skewed bundle draws nothing
    const used = def.units.filter((u) => def.pins.some((p) => p.unit === u && netOf.has(`${part.refdes}.${p.name}`)));
    const units: (string | null)[] = def.units.length ? (used.length ? used : [def.units[0]!]) : [null];

    return units.map((unit, i) => {
      const pins = def.pins
        .filter((p) => unit === null || p.unit === unit || !p.unit)
        .map((p) => {
          const anchor = unit && p.unit ? p.name.slice(0, -(unit.length + 1)) : p.name;
          const net = netOf.get(`${part.refdes}.${p.name}`);
          return { pin: p.name, anchor, net, cls: net ? netClass(nets.get(net)!.kind) : undefined };
        });
      const rot = part.pinned ? toRot(part.pinned.rot) : chooseRotation(sym, pins);
      const flip = part.pinned?.flip ?? false;
      const { width, height } = rotatedSize(sym.width, sym.height, rot);
      const pad = { left: 0, top: 0, right: 0, bottom: 0 };
      const flags: PlacedFlag[] = [];
      const nodePins: NodePin[] = pins.map((p) => {
        const a = sym.pins[p.anchor]!;
        const at = transformPoint(a, sym.width, sym.height, rot, flip);
        const side = transformSide(a.side, rot, flip);
        if (p.net && p.cls && p.cls !== "signal") {
          const net = nets.get(p.net)!;
          const flag = this.flag(at, side, p.cls, net.label ?? net.id, `${part.refdes}.${p.pin}`, p.net);
          flags.push(flag.placed);
          pad[side] = Math.max(pad[side], flag.extent);
        }
        return { pin: p.pin, at, side, net: p.net };
      });
      // The label takes a side without pins and gets room there, so wires keep clear of it.
      const label = labelSpot(new Set(nodePins.map((p) => p.side)), width, height, pad);
      pad[label.side] += LABEL_ROOM[label.side];
      for (const p of nodePins) p.at = { x: p.at.x + pad.left, y: p.at.y + pad.top };
      const key = unit ? `${part.refdes}:${unit}` : part.refdes;
      const pinned = part.pinned ? { x: part.pinned.x, y: part.pinned.y + i * (height + 40) } : undefined;
      return {
        key,
        refdes: part.refdes,
        unit,
        group,
        symbol,
        part: part.part,
        def: sym,
        rot,
        flip,
        width,
        height,
        pad,
        pins: nodePins,
        flags,
        label: { x: label.x, y: label.y, anchor: label.anchor },
        pinned,
      };
    });
  }

  /** A flag on a pin at `at` (symbol coordinates) on `side`, pointing away from the symbol. */
  private flag(at: Point, side: Side, cls: NetClass, name: string, pinRef: string, net: string) {
    const symbol = cls === "ground" ? FLAG_GROUND : FLAG_POWER;
    const fs = this.reg.symbols[symbol]!;
    const anchor = fs.pins.P!;
    const rot = ROTATIONS.find((r) => transformSide(anchor.side, r) === OPPOSITE[side])!;
    const size = rotatedSize(fs.width, fs.height, rot);
    const a = transformPoint(anchor, fs.width, fs.height, rot);
    const dir = OUTWARD[side];
    const length = dir.x ? size.width : size.height;
    const text = cls === "ground" ? null : name;
    const textAt = {
      x: at.x + dir.x * (length + 4),
      y: at.y + (dir.y < 0 ? -(length + 4) : dir.y > 0 ? length + 12 : 3),
    };
    const textRoom = text === null ? 0 : dir.x ? text.length * 6 + 6 : 25; // name, and live value beside it
    const placed: PlacedFlag = {
      key: `flag:${pinRef}`,
      net,
      symbol,
      x: at.x - a.x,
      y: at.y - a.y,
      rot,
      width: size.width,
      height: size.height,
      symbolWidth: fs.width,
      symbolHeight: fs.height,
      text,
      textAt,
      textAnchor: dir.x > 0 ? "start" : dir.x < 0 ? "end" : "middle",
    };
    return { placed, extent: length + textRoom };
  }

  /** The ELK graph of one group: its symbols, its internal wires and its frame ports. */
  private blockGraph(
    group: string,
    members: Node[],
    endpoints: Map<string, Endpoint[]>,
    groupsOfNet: Map<string, string[]>,
    portSide: (group: string, net: string) => Side,
    declaredPorts: BlockPort[],
  ): ElkNode {
    const memberKeys = new Set(members.map((m) => m.key));
    const interfaceNets = new Set(
      declaredPorts.filter((p) => ["input", "output", "bidir"].includes(p.direction)).map((p) => p.net),
    );
    const ports: ElkPort[] = [];
    const edges: ElkExtendedEdge[] = [];
    const usedPins = new Set<string>();
    const nets = [...endpoints.keys()].sort();
    for (const net of nets) {
      const local = endpoints.get(net)!.filter((e) => memberKeys.has(e.node.key));
      if (!local.length) continue;
      // A declared signal port is part of the block's interface: it reaches the frame even before
      // anything outside uses it, so adding a downstream block leaves this block's layout alone.
      const declared = interfaceNets.has(net);
      const external = declared || groupsOfNet.get(net)!.length > 1;
      if (local.length + (external ? 1 : 0) < 2) continue;
      const pid = (e: Endpoint) => `${e.node.key}/${e.pin.pin}`;
      const side = external ? portSide(group, net) : null;
      const portId = `port:${net}`;
      if (side) ports.push({ id: portId, width: 0, height: 0, layoutOptions: { "elk.port.side": ELK_SIDE[side] } });
      let source: string;
      let targets: string[];
      if (side === "left") {
        source = portId;
        targets = local.map(pid);
      } else {
        const driver = local.find((e) => this.pinType(e) === "output") ?? local[0]!;
        source = pid(driver);
        targets = local.filter((e) => e !== driver).map(pid);
        if (side) targets.push(portId);
      }
      for (const e of local) usedPins.add(pid(e));
      targets.forEach((t, i) => edges.push({ id: `${net}|${i}`, sources: [source], targets: [t] }));
    }
    return {
      id: group,
      layoutOptions: BLOCK_OPTIONS,
      ports,
      edges,
      children: members.map((n) => ({
        id: n.key,
        width: n.width + n.pad.left + n.pad.right,
        height: n.height + n.pad.top + n.pad.bottom,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: n.pins
          .filter((p) => usedPins.has(`${n.key}/${p.pin}`))
          .map((p) => ({
            id: `${n.key}/${p.pin}`,
            x: p.at.x,
            y: p.at.y,
            width: 0,
            height: 0,
            layoutOptions: { "elk.port.side": ELK_SIDE[p.side] },
          })),
      })),
    };
  }
}

/** Room a two-line reference/value label takes on each side of a symbol. */
const LABEL_ROOM: Record<Side, number> = { top: 26, bottom: 26, left: 56, right: 56 };

/**
 * Labels go on the first side without pins (so without wires or flags): top, right, bottom, left.
 * With pins all round (an op-amp), above the top flags. Relative to the symbol's top-left corner.
 */
function labelSpot(
  sides: Set<Side>,
  w: number,
  h: number,
  pad: Record<Side, number>,
): PlacedSymbol["label"] & { side: Side } {
  if (!sides.has("top")) return { side: "top", x: w / 2, y: -16, anchor: "middle" };
  if (!sides.has("right")) return { side: "right", x: w + 6, y: h / 2 - 2, anchor: "start" };
  if (!sides.has("bottom")) return { side: "bottom", x: w / 2, y: h + 12, anchor: "middle" };
  if (!sides.has("left")) return { side: "left", x: -6, y: h / 2 - 2, anchor: "end" };
  return { side: "top", x: w / 2, y: -pad.top - 16, anchor: "middle" };
}

/** Score each rotation: positive supply pins up, ground and negative supply pins down. */
function chooseRotation(sym: SymbolDef, pins: { anchor: string; cls?: NetClass }[]): Rot {
  const weight: Record<NetClass, { top: number; bottom: number }> = {
    pos: { top: 2, bottom: -2 },
    ground: { top: -2, bottom: 2 },
    neg: { top: -1, bottom: 1 },
    signal: { top: 0, bottom: 0 },
  };
  let best: Rot = 0;
  let bestScore = -Infinity;
  for (const rot of ROTATIONS) {
    let score = 0;
    for (const p of pins) {
      if (!p.cls) continue;
      const side = transformSide(sym.pins[p.anchor]!.side, rot);
      if (side === "top" || side === "bottom") score += weight[p.cls][side];
    }
    if (score > bestScore) [best, bestScore] = [rot, score];
  }
  return best;
}

/**
 * Groups in signal order: a block that drives another (an output port bound to the net of the
 * other's input port) comes first; otherwise IR order. Parts outside blocks come last.
 */
function signalOrder(input: LayoutInput, nodes: Node[]): string[] {
  const ids = input.blocks.map((b) => b.id);
  const producers = new Map<string, string>();
  for (const b of input.blocks) for (const p of b.ports) if (p.direction === "output") producers.set(p.net, b.id);
  const deps = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const b of input.blocks) {
    for (const p of b.ports) {
      const from = p.direction === "input" ? producers.get(p.net) : undefined;
      if (from && from !== b.id) deps.get(b.id)!.add(from);
    }
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < ids.length) {
    const ready = ids.find((id) => !done.has(id) && [...deps.get(id)!].every((d) => done.has(d)));
    const next = ready ?? ids.find((id) => !done.has(id))!; // a feedback loop: fall back to IR order
    order.push(next);
    done.add(next);
  }
  if (nodes.some((n) => n.group === FREE && !n.pinned)) order.push(FREE);
  return order;
}

function emptyBlock(): BlockLayout {
  return { ...EMPTY_BLOCK, nodes: {}, ports: {}, wires: {} };
}

function parseBlock(root: ElkNode): BlockLayout {
  const g = root.children![0]!;
  const out: BlockLayout = { width: g.width ?? 0, height: g.height ?? 0, nodes: {}, ports: {}, wires: {} };
  for (const c of g.children ?? []) out.nodes[c.id] = { x: c.x ?? 0, y: c.y ?? 0 };
  for (const p of g.ports ?? []) {
    const x = p.x ?? 0;
    out.ports[p.id.slice("port:".length)] = { x, y: p.y ?? 0, side: x <= 0 ? "left" : "right" };
  }
  for (const e of (g.edges ?? []) as ElkExtendedEdge[]) {
    const net = e.id.slice(0, e.id.lastIndexOf("|"));
    for (const s of e.sections ?? []) {
      (out.wires[net] ??= []).push(dedupe([s.startPoint, ...(s.bendPoints ?? []), s.endPoint]));
    }
  }
  return out;
}

interface PortRef {
  group: string;
  index: number;
  side: Side;
  /** Gap the port faces: -1 is left of the first group, i is right of group i. */
  gap: number;
}

function placeBlocks(
  order: string[],
  layouts: Map<string, BlockLayout>,
  groupsOfNet: Map<string, string[]>,
  input: LayoutInput,
) {
  // Which nets cross which gaps, and which need a lane over the top.
  const channels = new Map<number, string[]>();
  const lanes: string[] = [];
  const routes: { net: string; from: PortRef; to: PortRef }[] = [];
  const useChannel = (gap: number, net: string) => {
    const list = channels.get(gap) ?? [];
    if (!list.includes(net)) list.push(net);
    channels.set(gap, list);
  };
  for (const net of [...groupsOfNet.keys()].sort()) {
    const refs: PortRef[] = [];
    for (const group of groupsOfNet.get(net)!) {
      const port = layouts.get(group)?.ports[net];
      if (!port) continue;
      const index = order.indexOf(group);
      refs.push({ group, index, side: port.side, gap: port.side === "left" ? index - 1 : index });
    }
    if (refs.length < 2) continue;
    const from = refs.find((r) => r.side === "right") ?? refs[0]!;
    for (const to of refs.filter((r) => r !== from)) {
      useChannel(from.gap, net);
      if (to.gap !== from.gap) {
        useChannel(to.gap, net);
        if (!lanes.includes(net)) lanes.push(net);
      }
      routes.push({ net, from, to });
    }
  }
  const gapWidth = (gap: number) => GAP + CHANNEL * (channels.get(gap)?.length ?? 0);

  // Place: x by accumulated widths, y aligned with the driving block's port.
  const origins = new Map<string, Point>();
  const gapStart = new Map<number, number>();
  let x = channels.has(-1) ? gapWidth(-1) : 0;
  gapStart.set(-1, 0);
  order.forEach((group, i) => {
    const bl = layouts.get(group)!;
    let y = 0;
    for (const [net, port] of Object.entries(bl.ports)) {
      if (port.side !== "left") continue;
      const driver = order.slice(0, i).find((g) => layouts.get(g)!.ports[net]?.side === "right");
      if (driver) {
        y = origins.get(driver)!.y + layouts.get(driver)!.ports[net]!.y - port.y;
        break;
      }
    }
    origins.set(group, { x, y });
    gapStart.set(i, x + bl.width);
    x += bl.width + gapWidth(i);
  });

  const frames: Record<string, BlockFrame> = {};
  const titles = new Map(input.blocks.map((b) => [b.id, b.title]));
  for (const group of order) {
    if (group === FREE) continue;
    const o = origins.get(group)!;
    const bl = layouts.get(group)!;
    frames[group] = { x: o.x, y: o.y, width: bl.width, height: bl.height, title: titles.get(group) ?? group };
  }

  // Wires inside blocks, moved into place.
  const wires: Record<string, Point[][]> = {};
  for (const group of order) {
    const o = origins.get(group)!;
    for (const [net, polylines] of Object.entries(layouts.get(group)!.wires)) {
      for (const pl of polylines) (wires[net] ??= []).push(pl.map((p) => ({ x: p.x + o.x, y: p.y + o.y })));
    }
  }

  // Wires between blocks.
  const top = Math.min(0, ...[...origins.values()].map((o) => o.y)) - FRAME_TITLE;
  const channelX = (gap: number, net: string) => gapStart.get(gap)! + GAP / 2 + CHANNEL * channels.get(gap)!.indexOf(net);
  const portAt = (r: PortRef, net: string): Point => {
    const o = origins.get(r.group)!;
    const p = layouts.get(r.group)!.ports[net]!;
    return { x: o.x + p.x, y: o.y + p.y };
  };
  for (const { net, from, to } of routes) {
    const a = portAt(from, net);
    const b = portAt(to, net);
    const ca = channelX(from.gap, net);
    let pl: Point[];
    if (to.gap === from.gap) {
      pl = [a, { x: ca, y: a.y }, { x: ca, y: b.y }, b];
    } else {
      const cb = channelX(to.gap, net);
      const ly = top - 20 - LANE * lanes.indexOf(net);
      pl = [a, { x: ca, y: a.y }, { x: ca, y: ly }, { x: cb, y: ly }, { x: cb, y: b.y }, b];
    }
    (wires[net] ??= []).push(dedupe(pl));
  }
  return { origins, frames, wires };
}

/** Drop repeated points and the middle of straight runs. */
function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    const prev = out[out.length - 2];
    if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

function nearest(pool: Point[], p: Point): Point | undefined {
  let best: Point | undefined;
  let d = Infinity;
  for (const q of pool) {
    const dq = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (dq < d) [best, d] = [q, dq];
  }
  return best;
}

const key = (p: Point) => `${Math.round(p.x * 10) / 10},${Math.round(p.y * 10) / 10}`;

/**
 * Points where a net branches: three or more wire arms meet (a pin counts as an arm). Wires
 * of one net may overlap, so segments are first split at every vertex and de-duplicated.
 */
export function findJunctions(polylines: Point[][], pins: Point[]): Point[] {
  const vertices = new Map<string, Point>();
  for (const pl of polylines) for (const p of pl) vertices.set(key(p), p);
  for (const p of pins) vertices.set(key(p), p);
  const segments = new Set<string>();
  const degree = new Map<string, number>();
  const on = (a: Point, b: Point, p: Point) =>
    (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) ||
    (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x));
  for (const pl of polylines) {
    for (let i = 1; i < pl.length; i++) {
      const [a, b] = [pl[i - 1]!, pl[i]!];
      const along = [...vertices.values()]
        .filter((p) => on(a, b, p))
        .sort((p, q) => (a.x === b.x ? p.y - q.y : p.x - q.x));
      for (let j = 1; j < along.length; j++) {
        const [k1, k2] = [key(along[j - 1]!), key(along[j]!)].sort();
        const s = `${k1}|${k2}`;
        if (segments.has(s)) continue;
        segments.add(s);
        degree.set(k1!, (degree.get(k1!) ?? 0) + 1);
        degree.set(k2!, (degree.get(k2!) ?? 0) + 1);
      }
    }
  }
  for (const p of pins) degree.set(key(p), (degree.get(key(p)) ?? 0) + 1);
  return [...degree.entries()].filter(([, d]) => d >= 3).map(([k]) => vertices.get(k)!);
}

/** Midpoint of a net's longest horizontal segment, a little above the wire. */
function labelPoint(polylines: Point[][] | undefined): Point | undefined {
  let best: Point | undefined;
  let len = 0;
  for (const pl of polylines ?? []) {
    for (let i = 1; i < pl.length; i++) {
      const [a, b] = [pl[i - 1]!, pl[i]!];
      if (a.y === b.y && Math.abs(b.x - a.x) > len) {
        len = Math.abs(b.x - a.x);
        best = { x: (a.x + b.x) / 2, y: a.y - 4 };
      }
    }
  }
  return best;
}

function bounds(symbols: PlacedSymbol[], flags: PlacedFlag[], frames: Record<string, BlockFrame>, wires: Record<string, Point[][]>) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, w = 0, h = 0) => {
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + w), Math.max(y1, y + h)];
  };
  for (const s of symbols) add(s.x, s.y, s.width, s.height);
  for (const f of flags) add(f.x, f.y, f.width, f.height);
  for (const f of Object.values(frames)) add(f.x, f.y - FRAME_TITLE, f.width, f.height + FRAME_TITLE);
  for (const pls of Object.values(wires)) for (const pl of pls) for (const p of pl) add(p.x, p.y);
  if (x0 === Infinity) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
