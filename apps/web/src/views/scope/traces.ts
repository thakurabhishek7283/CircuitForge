// What the scope plots: the probes (plus the selected net, followed automatically) taken from a
// simulation view and downsampled to at most 2,000 points (LLD §8).
import type { SimView } from "../../store/simView.ts";
import type { Probe } from "../../store/uiStore.ts";
import { downsample } from "./lttb.ts";

export const PROBE_COLOURS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599"];
export const FOLLOW_COLOUR = "#868e96";

export interface Trace {
  label: string;
  unit: "V" | "A" | "dB" | "°";
  colour: string;
  /** The selected net, followed without being probed. */
  follow: boolean;
  y: number[];
}

export interface Plot {
  x: number[];
  traces: Trace[];
}

export const probeLabel = (p: Probe): string => (p.kind === "net" ? `V(${p.id})` : `I(${p.ref})`);

/** Probes plus the followed net, each with its colour. */
function lines(probes: Probe[], follow: string | null): { probe: Probe; colour: string; follow: boolean }[] {
  const out = probes.map((probe, k) => ({ probe, colour: PROBE_COLOURS[k % PROBE_COLOURS.length]!, follow: false }));
  if (follow && !probes.some((p) => p.kind === "net" && p.id === follow)) {
    out.push({ probe: { kind: "net", id: follow }, colour: FOLLOW_COLOUR, follow: true });
  }
  return out;
}

export function tranPlot(view: SimView | undefined, probes: Probe[], follow: string | null): Plot | null {
  const tran = view?.tran;
  if (!tran) return null;
  const shown = lines(probes, follow).flatMap(({ probe, colour, follow }) => {
    const data = probe.kind === "net" ? tran.v[probe.id] : tran.i[probe.ref];
    return data ? [{ label: probeLabel(probe), unit: probe.kind === "net" ? ("V" as const) : ("A" as const), colour, follow, data }] : [];
  });
  const { x, ys } = downsample(tran.x, shown.map((s) => s.data));
  return { x, traces: shown.map(({ data: _, ...s }, k) => ({ ...s, y: ys[k]! })) };
}

/** Bode plot: magnitude in dB and phase in degrees of every probed net (currents have no AC). */
export function acPlot(view: SimView | undefined, probes: Probe[], follow: string | null): Plot | null {
  const ac = view?.ac;
  if (!ac) return null;
  const shown = lines(probes, follow).flatMap(({ probe, colour, follow }) => {
    if (probe.kind !== "net") return [];
    const re = ac.v[probe.id];
    const im = ac.vi[probe.id];
    if (!re || !im) return [];
    const db = new Float64Array(re.length);
    const deg = new Float64Array(re.length);
    let turns = 0;
    for (let k = 0; k < re.length; k++) {
      db[k] = 20 * Math.log10(Math.max(Math.hypot(re[k]!, im[k]!), 1e-30));
      // Unwrapped: a jump of more than 180° between points is a wrap, not a change.
      const wrapped = (Math.atan2(im[k]!, re[k]!) * 180) / Math.PI;
      if (k > 0) turns += Math.round((deg[k - 1]! - (wrapped + turns)) / 360) * 360;
      deg[k] = wrapped + turns;
    }
    const label = probeLabel(probe);
    return [
      { label: `|${label}|`, unit: "dB" as const, colour, follow, data: db },
      { label: `∠${label}`, unit: "°" as const, colour, follow, data: deg },
    ];
  });
  const { x, ys } = downsample(ac.x, shown.map((s) => s.data));
  return { x, traces: shown.map(({ data: _, ...s }, k) => ({ ...s, y: ys[k]! })) };
}
