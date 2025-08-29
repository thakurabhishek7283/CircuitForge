// Largest-Triangle-Three-Buckets downsampling (LLD §8: traces are plotted with at most 2,000
// points). Several traces share one x axis, so one set of indices is chosen for all of them:
// in each bucket, the point whose triangles have the largest area summed over the traces, each
// trace scaled by its own range so a millivolt trace counts as much as a 12 V one.

export const MAX_POINTS = 2000;

/** Indices to keep, ascending, first and last included. */
export function lttbIndices(x: ArrayLike<number>, ys: ArrayLike<number>[], threshold = MAX_POINTS): number[] {
  const n = x.length;
  if (threshold >= n || threshold < 3 || ys.length === 0) return Array.from({ length: n }, (_, i) => i);

  const scale = ys.map((y) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = y[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi > lo ? 1 / (hi - lo) : 0;
  });
  let xlo = x[0]!;
  let xhi = x[n - 1]!;
  if (xhi === xlo) xhi = xlo + 1;
  const xs = 1 / (xhi - xlo);

  const out = [0];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let b = 0; b < threshold - 2; b++) {
    // The next bucket's average point is the triangle's third corner.
    const nextStart = Math.floor((b + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((b + 2) * every) + 1, n);
    const span = Math.max(nextEnd - nextStart, 1);
    let avgX = 0;
    for (let i = nextStart; i < nextEnd; i++) avgX += x[i]!;
    avgX = (nextEnd > nextStart ? avgX / span : x[n - 1]!) * xs;
    const avgY = ys.map((y, s) => {
      if (nextEnd <= nextStart) return y[n - 1]! * scale[s]!;
      let sum = 0;
      for (let i = nextStart; i < nextEnd; i++) sum += y[i]!;
      return (sum / span) * scale[s]!;
    });

    const start = Math.floor(b * every) + 1;
    const end = Math.floor((b + 1) * every) + 1;
    const ax = x[a]! * xs;
    let best = start;
    let bestArea = -1;
    for (let i = start; i < end; i++) {
      const px = x[i]! * xs;
      let area = 0;
      for (let s = 0; s < ys.length; s++) {
        const k = scale[s]!;
        const ay = ys[s]![a]! * k;
        area += Math.abs((ax - avgX) * (ys[s]![i]! * k - ay) - (ax - px) * (avgY[s]! - ay));
      }
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    out.push(best);
    a = best;
  }
  out.push(n - 1);
  return out;
}

/** `x` and every trace, downsampled to the same indices. */
export function downsample(x: ArrayLike<number>, ys: ArrayLike<number>[], threshold = MAX_POINTS): { x: number[]; ys: number[][] } {
  const idx = lttbIndices(x, ys, threshold);
  return { x: idx.map((i) => x[i]!), ys: ys.map((y) => idx.map((i) => y[i]!)) };
}
