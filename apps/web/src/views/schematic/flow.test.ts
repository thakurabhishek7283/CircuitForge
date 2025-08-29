import ELK from "elkjs/lib/elk.bundled.js";
import { describe, expect, it } from "vitest";
import { bundle, demo, missingArtifacts } from "../../test/artifacts.ts";
import { LayoutEngine } from "../../workers/layout.engine.ts";
import { layoutRegistry, toLayoutInput } from "../../workers/layoutClient.ts";
import { buildFlow, netEdges } from "./flow.ts";

describe("current flow graph", () => {
  // A T: pin A at the left end, B at the right end, C at the bottom of a branch from the middle.
  //   A(0,0) ---- (50,0) ---- B(100,0)
  //                 |
  //               C(50,40)
  const polylines = [
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    [
      { x: 50, y: 0 },
      { x: 50, y: 40 },
    ],
  ];
  const pinsAt = new Map([
    ["0,0", ["X1.A"]],
    ["1000,0", ["X2.B"]],
    ["500,400", ["X3.C"]],
  ]);
  const pinPoints = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 40 },
  ];

  it("splits wires at branch points and sums the pins beyond each edge", () => {
    const edges = netEdges(polylines, pinsAt, pinPoints);
    expect(edges).toHaveLength(3);
    // Rooted at A: the trunk to the branch point carries B and C, then one each.
    const trunk = edges.find((e) => e.a.x === 0)!;
    expect(trunk.b).toEqual({ x: 50, y: 0 });
    expect(trunk.pins.sort()).toEqual(["X2.B", "X3.C"]);
    expect(trunk.length).toBe(50);
    expect(edges.find((e) => e.b.x === 100)!.pins).toEqual(["X2.B"]);
    expect(edges.find((e) => e.b.y === 40)!.pins).toEqual(["X3.C"]);
  });

  it("survives overlapping runs (a cycle in the drawing)", () => {
    const loop = [...polylines, [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 50, y: 40 }]];
    const edges = netEdges(loop, pinsAt, pinPoints);
    const nodes = new Set(edges.flatMap((e) => [`${e.a.x},${e.a.y}`, `${e.b.x},${e.b.y}`]));
    expect(edges.length).toBe(nodes.size - 1); // a tree
  });

  describe.skipIf(missingArtifacts().length > 0)("on the demo layout", () => {
    it("covers every signal net and every two-pin part", async () => {
      const c = demo();
      const reg = bundle();
      const layout = await new LayoutEngine(layoutRegistry(reg), new ELK()).layout(toLayoutInput(c));
      const flow = buildFlow(layout, c.nets, (refdes) => {
        const pins = reg.parts[c.parts[refdes]!.part]!.pins;
        return pins.length === 2 ? [pins[0]!.name, pins[1]!.name] : null;
      });
      for (const n of flow.nets) {
        const pins = c.nets[n.net]!.pins.filter((p) => layout.pins[p]);
        // A spanning tree touches every pin of the net: the edges' pins cover all but the root's.
        const covered = new Set(n.edges.flatMap((e) => e.pins));
        expect(covered.size, n.net).toBeGreaterThanOrEqual(pins.length - 1);
      }
      expect(flow.bodies.map((b) => b.pins[0]).sort()).toEqual(["C1.1", "C2.1", "R1.1", "R2.1", "V1.P", "V2.P", "V3.P"]);
    });
  });
});
