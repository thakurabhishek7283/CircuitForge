import { describe, expect, it } from "vitest";
import { MAX_POINTS, downsample, lttbIndices } from "./lttb.ts";

describe("lttb", () => {
  it("keeps short traces whole", () => {
    expect(lttbIndices([0, 1, 2], [[5, 6, 7]], 10)).toEqual([0, 1, 2]);
  });

  it("caps at the threshold, keeps the ends and stays ordered", () => {
    const n = 100_000;
    const x = Float64Array.from({ length: n }, (_, i) => i * 1e-6);
    const y = x.map((t) => Math.sin(2 * Math.PI * 1000 * t));
    const idx = lttbIndices(x, [y]);
    expect(idx).toHaveLength(MAX_POINTS);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(n - 1);
    for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
    // Peaks survive: the kept points still reach ±1.
    const kept = idx.map((i) => y[i]!);
    expect(Math.max(...kept)).toBeGreaterThan(0.999);
    expect(Math.min(...kept)).toBeLessThan(-0.999);
  });

  it("keeps a narrow spike in a small trace next to a large one", () => {
    const n = 10_000;
    const x = Float64Array.from({ length: n }, (_, i) => i);
    const big = x.map((i) => 12 * Math.sin(i / 500));
    const small = new Float64Array(n);
    small[7_777] = 1e-3; // a 1 mV glitch on one sample
    const { ys } = downsample(x, [big, small], 200);
    expect(ys[0]).toHaveLength(200);
    expect(Math.max(...ys[1]!)).toBe(1e-3);
  });
});
