// Simulation overlays (LLD §10): voltage colouring and current dots on a canvas under the SVG,
// driven by requestAnimationFrame. The renderer reads the stores through `subscribe`, never
// through React, so animating never re-renders a component.
//
// With a transient the overlays play it back in a loop (one period of the slowest source per
// second), otherwise they show the operating point. Dot speed is proportional to log |I|.
import type { Registry } from "../../gen/contract.ts";
import type { CircuitState, CircuitStore } from "../../store/circuitStore.ts";
import type { SimView } from "../../store/simView.ts";
import type { UiStore } from "../../store/uiStore.ts";
import type { Layout } from "../../workers/layout.types.ts";
import type { Playback } from "../playback.ts";
import { type FlowEdge, type FlowGraph, buildFlow } from "./flow.ts";

/** Below this, no dots (and a 1 GΩ shunt's leakage stays still). */
export const I_MIN = 1e-9;
/** World units per second per decade of current above I_MIN. */
const SPEED_PER_DECADE = 8;
const DOT_SPACING = 16;
const DOT_RADIUS = 2.2;
const HALO_WIDTH = 5;

export function dotSpeed(amps: number): number {
  const a = Math.abs(amps);
  if (!(a > I_MIN)) return 0;
  return Math.sign(amps) * Math.log10(a / I_MIN) * SPEED_PER_DECADE;
}

/** A value of every net and pin at one instant. */
interface Sample {
  v(net: string): number | undefined;
  i(pin: string): number | undefined;
}

function sampleAt(view: SimView | undefined, phase: number): Sample | null {
  const tran = view?.tran;
  if (tran && tran.x.length > 1) {
    const x = tran.x;
    const t = x[0]! + phase * (x[x.length - 1]! - x[0]!);
    let lo = 0;
    let hi = x.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x[mid]! <= t) lo = mid;
      else hi = mid;
    }
    const f = x[hi]! > x[lo]! ? (t - x[lo]!) / (x[hi]! - x[lo]!) : 0;
    const at = (a: Float64Array | undefined) => (a ? a[lo]! + f * (a[hi]! - a[lo]!) : undefined);
    return { v: (n) => at(tran.v[n]), i: (p) => at(tran.i[p]) };
  }
  const op = view?.op;
  return op ? { v: (n) => op.v[n], i: (p) => op.i[p] } : null;
}

/**
 * Largest |V| on the drawn (signal) nets: the colour scale's full swing. Rails are flags, not
 * wires, so a 12 V supply does not wash out a 1 V signal.
 */
function voltageSwing(view: SimView | undefined, nets: string[]): number {
  let m = 0;
  for (const n of nets) {
    m = Math.max(m, Math.abs(view?.op?.v[n] ?? 0));
    for (const v of view?.tran?.v[n] ?? []) m = Math.max(m, Math.abs(v));
  }
  return m || 1;
}

/** Grey at 0 V, warm for positive, blue for negative. */
function voltageColour(v: number, swing: number): string {
  const u = Math.max(-1, Math.min(1, v / swing));
  const grey = [138, 138, 138];
  const end = u >= 0 ? [232, 89, 12] : [28, 126, 214];
  const k = Math.abs(u);
  const c = grey.map((g, j) => Math.round(g + (end[j]! - g) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Seconds of playback for the whole transient: one period of the slowest source per second. */
function loopSeconds(state: CircuitState, registry: Registry, view: SimView | undefined): number {
  const x = view?.tran?.x;
  if (!x || x.length < 2) return 5;
  let slowest = Infinity;
  for (const p of Object.values(state.parts)) {
    if (!p || registry.parts[p.part]?.category !== "V") continue;
    for (const q of Object.values(p.params)) if (q?.unit === "hertz" && q.si > 0) slowest = Math.min(slowest, q.si);
  }
  const span = x[x.length - 1]! - x[0]!;
  return Number.isFinite(slowest) ? Math.min(20, Math.max(2, span * slowest)) : 5;
}

export interface OverlayOptions {
  canvas: HTMLCanvasElement;
  store: CircuitStore;
  ui: UiStore;
  registry: Registry;
  playback: Playback;
}

export class OverlayRenderer {
  private readonly o: OverlayOptions;
  private readonly ctx: CanvasRenderingContext2D;
  private transform = { k: 1, x: 0, y: 0 };
  private flow: FlowGraph | null = null;
  private flowFor: { layout: Layout | null; nets: CircuitState["nets"] | null } = { layout: null, nets: null };
  private phases = new Map<FlowEdge, number>();
  private swing = 1;
  private swingFor: SimView | undefined;
  private swingFlow: FlowGraph | null = null;
  /** Seconds per playback loop, for the result in `loopFor`. */
  private loop = 5;
  private loopFor: SimView | undefined;
  private frame = 0;
  private readonly dotColour: string;
  private last = 0;
  private readonly stops: (() => void)[] = [];
  private readonly resize: ResizeObserver;

  constructor(o: OverlayOptions) {
    this.o = o;
    this.ctx = o.canvas.getContext("2d")!;
    this.stops.push(
      o.store.subscribe((s, p) => {
        if (s.layout !== p.layout || s.sim.view !== p.sim.view || s.nets !== p.nets) this.wake();
      }),
      o.ui.subscribe((s, p) => {
        if (s.overlays !== p.overlays) this.wake();
      }),
    );
    this.resize = new ResizeObserver(() => this.wake());
    this.resize.observe(o.canvas);
    const onVisible = () => this.wake();
    document.addEventListener("visibilitychange", onVisible);
    this.stops.push(() => document.removeEventListener("visibilitychange", onVisible));
    this.dotColour = getComputedStyle(o.canvas).getPropertyValue("--dot").trim() || "#f2b705";
    this.wake();
  }

  setTransform(t: { k: number; x: number; y: number }): void {
    this.transform = { k: t.k, x: t.x, y: t.y };
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    for (const stop of this.stops) stop();
  }

  /** Draw on the next frame (and keep going while something moves). */
  private wake(): void {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.draw(t));
  }

  private graph(state: CircuitState): FlowGraph | null {
    if (!state.layout) return null;
    if (this.flowFor.layout !== state.layout || this.flowFor.nets !== state.nets) {
      const { registry } = this.o;
      this.flow = buildFlow(state.layout, state.nets, (refdes) => {
        const pins = registry.parts[state.parts[refdes]?.part ?? ""]?.pins;
        return pins?.length === 2 ? [pins[0]!.name, pins[1]!.name] : null;
      });
      this.flowFor = { layout: state.layout, nets: state.nets };
      this.phases.clear();
    }
    return this.flow;
  }

  private draw(now: number): void {
    this.frame = 0;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const { canvas, store, ui, registry, playback } = this.o;
    const state = store.getState();
    const { overlays } = ui.getState();
    const view = state.sim.view;

    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const flow = this.graph(state);
    const playing = !!view?.tran && (overlays.voltage || overlays.current);
    if (playing) {
      if (this.loopFor !== view) {
        this.loop = loopSeconds(state, registry, view);
        this.loopFor = view;
      }
      playback.phase = (playback.phase + dt / this.loop) % 1;
    }
    const sample = sampleAt(view, playback.phase);
    // The last good result stays up while the next one runs, so edits do not flicker.
    if (!flow || !sample || state.sim.result?.status !== "ok" || (!overlays.voltage && !overlays.current)) {
      this.last = 0;
      return;
    }

    const { k, x, y } = this.transform;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (overlays.voltage) {
      if (this.swingFor !== view || this.swingFlow !== flow) {
        this.swing = voltageSwing(view, flow.nets.map((n) => n.net));
        this.swingFor = view;
        this.swingFlow = flow;
      }
      ctx.lineWidth = HALO_WIDTH;
      ctx.globalAlpha = 0.55;
      for (const n of flow.nets) {
        const v = sample.v(n.net);
        if (v === undefined) continue;
        ctx.strokeStyle = voltageColour(v, this.swing);
        ctx.beginPath();
        for (const pl of n.polylines) {
          ctx.moveTo(pl[0]!.x, pl[0]!.y);
          for (let j = 1; j < pl.length; j++) ctx.lineTo(pl[j]!.x, pl[j]!.y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    let moving = playing;
    if (overlays.current) {
      ctx.fillStyle = this.dotColour;
      ctx.beginPath();
      const edges = [...flow.bodies, ...flow.nets.flatMap((n) => n.edges)];
      for (const e of edges) {
        let amps = 0;
        let known = true;
        for (const p of e.pins) {
          const i = sample.i(p);
          if (i === undefined) known = false;
          else amps += i;
        }
        const speed = known ? dotSpeed(amps) : 0;
        if (!speed || e.length < 1) continue;
        moving = true;
        const phase = ((this.phases.get(e) ?? 0) + speed * dt) % DOT_SPACING;
        this.phases.set(e, phase);
        const start = phase < 0 ? phase + DOT_SPACING : phase;
        const ux = (e.b.x - e.a.x) / e.length;
        const uy = (e.b.y - e.a.y) / e.length;
        for (let s = start; s < e.length; s += DOT_SPACING) {
          const px = e.a.x + ux * s;
          const py = e.a.y + uy * s;
          ctx.moveTo(px + DOT_RADIUS, py);
          ctx.arc(px, py, DOT_RADIUS, 0, 2 * Math.PI);
        }
      }
      ctx.fill();
    }

    if (moving && document.visibilityState !== "hidden") this.wake();
    else this.last = 0;
  }
}
