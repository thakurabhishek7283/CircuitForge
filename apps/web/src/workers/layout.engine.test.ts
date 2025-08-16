// Layout of the demo circuit and of variations of it, with the real registry symbols and ELK.
import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import type { BlockPort, Circuit } from "../gen/contract.ts";
import { bundle, demo, missingArtifacts } from "../test/artifacts.ts";
import type { Point } from "./layout.geometry.ts";
import { LayoutEngine, findJunctions } from "./layout.engine.ts";
import type { Layout, LayoutInput } from "./layout.types.ts";
import { layoutRegistry, toLayoutInput } from "./layoutClient.ts";

const missing = missingArtifacts();

function engine() {
  return new LayoutEngine(layoutRegistry(bundle()), new ELK());
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Elementary wire segments of a net plus its pins form one connected graph. */
function connected(polylines: Point[][], pins: Point[]): boolean {
  const k = (p: Point) => `${p.x},${p.y}`;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    const p = parent.get(x)!;
    return p === x ? x : find(p);
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const pts = [...polylines.flat(), ...pins];
  const on = (a: Point, b: Point, p: Point) =>
    (a.x === b.x && p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)) ||
    (a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x));
  for (const pl of polylines) {
    for (let i = 1; i < pl.length; i++) {
      for (const p of pts) if (on(pl[i - 1]!, pl[i]!, p)) union(k(p), k(pl[i - 1]!));
    }
  }
  return new Set(pins.map((p) => find(k(p)))).size === 1;
}

function checkDrawing(l: Layout, input: LayoutInput) {
  const syms = Object.values(l.symbols);
  const b = l.bounds;
  const inside = (p: Point) => p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height;
  expect([b.x, b.y, b.width, b.height].every(Number.isFinite)).toBe(true);
  for (const s of syms) expect(inside(s) && inside({ x: s.x + s.width, y: s.y + s.height }), `${s.key} in bounds`).toBe(true);
  for (const pl of Object.values(l.wires).flat()) for (const p of pl) expect(inside(p)).toBe(true);
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) expect(overlaps(syms[i]!, syms[j]!), `${syms[i]!.key} / ${syms[j]!.key}`).toBe(false);
    for (const f of l.flags) expect(overlaps(syms[i]!, f), `${syms[i]!.key} / ${f.key}`).toBe(false);
  }
  for (const [net, pls] of Object.entries(l.wires)) {
    for (const pl of pls) {
      for (let i = 1; i < pl.length; i++) {
        const [a, b] = [pl[i - 1]!, pl[i]!];
        expect(a.x === b.x || a.y === b.y, `${net}: diagonal segment`).toBe(true);
      }
    }
  }
  for (const n of input.nets) {
    const pins = n.pins.flatMap((p) => l.pins[p] ?? []);
    if (n.kind.kind === "signal") {
      if (pins.length > 1) expect(connected(l.wires[n.id] ?? [], pins), `${n.id} is connected`).toBe(true);
    } else {
      expect(l.flags.filter((f) => f.net === n.id)).toHaveLength(pins.length);
      expect(l.wires[n.id]).toBeUndefined();
    }
  }
}

function withOps(c: Circuit, edit: (c: Circuit) => void): Circuit {
  const copy = structuredClone(c);
  edit(copy);
  return copy;
}

describe.skipIf(missing.length > 0)("layout engine", () => {
  it("lays out the demo: every symbol placed, nothing overlaps, every net drawn", async () => {
    const input = toLayoutInput(demo());
    const l = await engine().layout(input);
    expect(Object.keys(l.symbols).sort()).toEqual(["C1", "C2", "R1", "R2", "U1:A", "V1", "V2", "V3"]);
    checkDrawing(l, input);
    // Signal order: supply, source, filter.
    expect(l.blocks.b1!.x).toBeLessThan(l.blocks.b2!.x);
    expect(l.blocks.b2!.x + l.blocks.b2!.width).toBeLessThan(l.blocks.b3!.x);
    // Shunts to ground stand upright; series parts lie flat.
    expect(l.symbols.C2!.rot % 180).toBe(90);
    expect(l.symbols.R1!.rot).toBe(0);
    // V2 (+ on GND, − on VEE) is turned over so ground points down.
    expect(l.symbols.V2!.rot).toBe(180);
    expect(l.flags.find((f) => f.key === "flag:U1.VCC")!.text).toBe("VCC");
    expect(l.netLabels.N_OUT).toBeDefined();
    expect(l.stats.cachedBlocks).toBe(0);
  });

  it("is deterministic and reuses every block on an unchanged topology", async () => {
    const e = engine();
    const input = toLayoutInput(demo());
    const first = await e.layout(input);
    const again = await e.layout(input);
    expect(again.stats.cachedBlocks).toBe(3);
    expect({ ...again, stats: null }).toEqual({ ...first, stats: null });
    const other = await engine().layout(input);
    expect({ ...other, stats: null }).toEqual({ ...first, stats: null });
  });

  it("does not move earlier blocks when a downstream block is added", async () => {
    const e = engine();
    const before = await e.layout(toLayoutInput(demo()));
    const grown = withOps(demo(), (c) => {
      c.blocks.b4 = {
        id: "b4",
        role: "load",
        title: "Load",
        spec: {},
        status: "committed",
        ports: [{ name: "in", direction: "input", net: "N_OUT" }],
      };
      c.parts.R9 = { refdes: "R9", part: "resistor_th", params: {}, block: "b4", origin: { kind: "user" } };
      c.nets.N_OUT!.pins.push("R9.1");
      c.nets.GND!.pins.push("R9.2");
    });
    const after = await e.layout(toLayoutInput(grown));
    expect(after.stats.cachedBlocks).toBe(3);
    for (const b of ["b1", "b2", "b3"]) expect(after.blocks[b]).toEqual(before.blocks[b]);
    expect(after.blocks.b4!.x).toBeGreaterThan(before.blocks.b3!.x + before.blocks.b3!.width);
    checkDrawing(after, toLayoutInput(grown));
  });

  it("draws a second op-amp unit once it is used, with its own power flags", async () => {
    const c = withOps(demo(), (c) => {
      c.nets.N_IN!.pins.push("U1.INP_B");
      c.nets.N_B2 = { id: "N_B2", kind: { kind: "signal" }, pins: ["U1.OUT_B", "U1.INM_B"] };
    });
    const l = await engine().layout(toLayoutInput(c));
    expect(l.symbols["U1:B"]).toBeDefined();
    expect(l.pins["U1.VCC"]).toHaveLength(2);
    expect(l.flags.filter((f) => f.key === "flag:U1.VCC")).toHaveLength(2);
    checkDrawing(l, toLayoutInput(c));
  });

  it("puts a pinned part exactly where it was pinned and wires it in", async () => {
    const c = withOps(demo(), (c) => {
      c.parts.R2!.pinned = { x: 500, y: 400, rot: 90, flip: false };
    });
    const l = await engine().layout(toLayoutInput(c));
    expect(l.symbols.R2).toMatchObject({ x: 500, y: 400, rot: 90 });
    for (const net of ["N_A", "N_B"]) {
      const input = toLayoutInput(c);
      const pins = input.nets.find((n) => n.id === net)!.pins.flatMap((p) => l.pins[p] ?? []);
      expect(connected(l.wires[net]!, pins), net).toBe(true);
    }
  });

  it("lays out a part without a block, and an empty block", async () => {
    const c = withOps(demo(), (c) => {
      c.parts.R7 = { refdes: "R7", part: "resistor_th", params: {}, origin: { kind: "user" } };
      c.nets.N_OUT!.pins.push("R7.1");
      c.blocks.b5 = { id: "b5", role: "other", title: "Planned", spec: {}, status: "planned", ports: [] };
    });
    const l = await engine().layout(toLayoutInput(c));
    expect(l.symbols.R7).toBeDefined();
    expect(l.blocks.b5).toMatchObject({ width: 120, height: 60, title: "Planned" });
    expect(l.blocks["~free"]).toBeUndefined();
    checkDrawing(l, toLayoutInput(c));
  });

  it("lays out a circuit at the v1 limits (8 blocks, 300 parts)", async () => {
    // Eight RC ladders in a chain, 37-38 parts each, every one with a ground flag.
    const c = withOps(demo(), (c) => {
      c.parts = {};
      c.nets = { GND: { id: "GND", kind: { kind: "ground" }, pins: [] } };
      c.blocks = {};
      let k = 0;
      for (let b = 0; b < 8; b++) {
        const id = `b${b}`;
        const n = b < 4 ? 37 : 38;
        const ports: BlockPort[] = [];
        if (b > 0) ports.push({ name: "in", direction: "input", net: `N_${b}_0` });
        ports.push({ name: "out", direction: "output", net: `N_${b + 1}_0` });
        c.blocks[id] = { id, role: "filter", title: `Ladder ${b}`, spec: {}, status: "committed", ports };
        for (let i = 0; i < n; i++) {
          const isR = i % 2 === 0;
          const refdes = `${isR ? "R" : "C"}${++k}`;
          c.parts[refdes] = { refdes, part: isR ? "resistor_th" : "cap_film", params: {}, block: id, origin: { kind: "user" } };
          const from = `N_${b}_${Math.floor(i / 2)}`;
          const to = i === n - 1 || i === n - 2 ? `N_${b + 1}_0` : `N_${b}_${Math.floor(i / 2) + 1}`;
          const add = (net: string, pin: string) => (c.nets[net] ??= { id: net, kind: { kind: "signal" }, pins: [] }).pins.push(pin);
          if (isR) {
            add(from, `${refdes}.1`);
            add(to, `${refdes}.2`);
          } else {
            add(`N_${b}_${Math.floor(i / 2) + 1}`, `${refdes}.1`);
            c.nets.GND!.pins.push(`${refdes}.2`);
          }
        }
      }
    });
    expect(Object.keys(c.parts)).toHaveLength(300);
    const e = engine();
    const cold = await e.layout(toLayoutInput(c));
    const warm = await e.layout(toLayoutInput(c));
    console.info(`300 parts / 8 blocks: ${cold.stats.ms.toFixed(0)} ms uncached, ${warm.stats.ms.toFixed(1)} ms cached`);
    expect(Object.keys(cold.symbols)).toHaveLength(300);
    expect(cold.flags).toHaveLength(Object.keys(c.parts).filter((r) => r.startsWith("C")).length); // one ground flag per C
    const xs = Object.values(cold.blocks).map((f) => f.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("lays out quickly once warm", async () => {
    const e = engine();
    const input = toLayoutInput(demo());
    await e.layout(input);
    const cold = await engine().layout(input); // fresh cache, warm ELK
    const warm = await e.layout(input);
    console.info(`demo layout: ${cold.stats.ms.toFixed(1)} ms uncached, ${warm.stats.ms.toFixed(2)} ms cached`);
    expect(warm.stats.ms).toBeLessThan(20);
  });
});

describe("junctions", () => {
  it("finds branch points but not overlapping runs", () => {
    const pin = { x: 0, y: 0 };
    // Two wires leave the same pin along the same line, then split at x=10.
    const wires = [
      [pin, { x: 10, y: 0 }, { x: 10, y: 20 }],
      [pin, { x: 30, y: 0 }],
    ];
    expect(findJunctions(wires, [pin, { x: 10, y: 20 }, { x: 30, y: 0 }])).toEqual([{ x: 10, y: 0 }]);
    expect(findJunctions([[pin, { x: 30, y: 0 }]], [pin, { x: 30, y: 0 }])).toEqual([]);
  });
});
