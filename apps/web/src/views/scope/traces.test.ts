import { describe, expect, it } from "vitest";
import type { SimView } from "../../store/simView.ts";
import { acPlot, tranPlot } from "./traces.ts";

const n = 5000;
const view: SimView = {
  op: null,
  tran: {
    x: Float64Array.from({ length: n }, (_, k) => k * 1e-6),
    v: { N_OUT: new Float64Array(n).fill(2), N_IN: new Float64Array(n).fill(1) },
    i: { "R1.1": new Float64Array(n).fill(1e-3) },
  },
  ac: {
    x: Float64Array.of(10, 100, 1000),
    v: { N_OUT: Float64Array.of(1, 0, 0.1) },
    vi: { N_OUT: Float64Array.of(0, -1, 0) },
  },
};

describe("scope traces", () => {
  it("plots probes, follows the selected net, and caps the points", () => {
    const p = tranPlot(view, [{ kind: "net", id: "N_OUT" }, { kind: "pin", ref: "R1.1" }], ["N_IN"])!;
    expect(p.traces.map((t) => [t.label, t.unit, t.follow])).toEqual([
      ["V(N_OUT)", "V", false],
      ["I(R1.1)", "A", false],
      ["V(N_IN)", "V", true],
    ]);
    expect(p.x).toHaveLength(2000);
    expect(p.traces.every((t) => t.y.length === 2000)).toBe(true);
    // A probed net is not followed twice.
    expect(tranPlot(view, [{ kind: "net", id: "N_IN" }], ["N_IN"])!.traces).toHaveLength(1);
  });

  it("gives magnitude in dB and phase in degrees for AC", () => {
    const p = acPlot(view, [{ kind: "net", id: "N_OUT" }, { kind: "pin", ref: "R1.1" }], [])!;
    expect(p.traces.map((t) => t.label)).toEqual(["|V(N_OUT)|", "∠V(N_OUT)"]);
    expect(p.traces[0]!.y.map((v) => Math.round(v))).toEqual([0, 0, -20]);
    expect(p.traces[1]!.y.map((v) => Math.round(v))).toEqual([0, -90, 0]);
    expect(acPlot({ ...view, ac: null }, [], [])).toBeNull();
  });

  it("unwraps the phase through ±180°", () => {
    const deg = [-170, 170, 150, -10].map((d) => (d * Math.PI) / 180);
    const ac = { x: Float64Array.of(1, 2, 3, 4), v: { N: Float64Array.from(deg, Math.cos) }, vi: { N: Float64Array.from(deg, Math.sin) } };
    const p = acPlot({ op: null, tran: null, ac }, [{ kind: "net", id: "N" }], [])!;
    expect(p.traces[1]!.y.map((v) => Math.round(v))).toEqual([-170, -190, -210, -370]);
  });
});
