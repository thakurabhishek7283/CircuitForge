// Scope panel (LLD §8, §10): probes on nets (voltage) and pins (current), the short transient by
// default, and an AC sweep or a longer transient only when asked for. Asking is an
// `analysis.set` op, so it is undoable and saved with the circuit. Plots are uPlot on canvas;
// the playback cursor follows the overlays through a requestAnimationFrame loop, not React.
import { useEffect, useMemo, useRef, useState } from "react";
import uPlot, { type AlignedData, type Options } from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Analysis, Quantity } from "../../gen/contract.ts";
import { useCircuit, useEditor, useUi } from "../../app/editorContext.ts";
import { formatSi } from "../schematic/labels.ts";
import type { Playback } from "../playback.ts";
import { type Plot, type Trace, acPlot, probeLabel, tranPlot } from "./traces.ts";

/** The longest transient the scope offers to run, in output steps. */
export const MAX_TRAN_STEPS = 100_000;
const AC_DEFAULT = { points_per_decade: 20, f_start: 10, f_stop: 1e6 };

const fmt = (unit: Trace["unit"] | "s" | "Hz") => (v: number) =>
  unit === "dB" ? `${v.toFixed(1)} dB` : unit === "°" ? `${v.toFixed(0)}°` : formatSi(v, unit);

export function Scope() {
  const { ui, playback } = useEditor();
  const open = useUi((s) => s.scope.open);
  const tab = useUi((s) => s.scope.tab);
  const probes = useUi((s) => s.probes);
  const view = useCircuit((s) => s.sim.view);
  const selection = useCircuit((s) => s.selection);
  // The settings forms remount when the analyses change (an undo), so their fields follow.
  const analysesKey = JSON.stringify(useCircuit((s) => s.analyses)) + JSON.stringify(useCircuit((s) => s.sim.analyses));
  const follow = selection?.kind === "net" ? selection.id : null;
  const plot = useMemo(
    () => (tab === "tran" ? tranPlot(view, probes, follow) : acPlot(view, probes, follow)),
    [tab, view, probes, follow],
  );

  return (
    <section className={open ? "scope" : "scope closed"} aria-label="Scope">
      <header>
        <button type="button" className="toggle" aria-expanded={open} onClick={() => ui.getState().setScope({ open: !open })}>
          Scope
        </button>
        <div className="tabs" role="tablist">
          {(["tran", "ac"] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => ui.getState().setScope({ tab: t, open: true })}>
              {t === "tran" ? "Transient" : "AC sweep"}
            </button>
          ))}
        </div>
        <ProbeChips />
        {open && (tab === "tran" ? <TranSettings key={analysesKey} /> : <AcSettings key={analysesKey} />)}
      </header>
      {open && (
        <div className="scope-body">
          {plot && plot.traces.length > 0 ? (
            <Chart plot={plot} log={tab === "ac"} xUnit={tab === "ac" ? "Hz" : "s"} playback={tab === "tran" ? playback : null} />
          ) : (
            <p className="hint">{emptyText(tab, !!plot, view !== undefined)}</p>
          )}
        </div>
      )}
    </section>
  );
}

function emptyText(tab: "tran" | "ac", hasData: boolean, simulated: boolean): string {
  if (!simulated) return "Waiting for a simulation…";
  if (!hasData) return tab === "ac" ? "No AC sweep yet: set its range above and run it." : "No transient in the last result.";
  return "Select a net to see it here, or add a probe from the inspector.";
}

function ProbeChips() {
  const { ui } = useEditor();
  const probes = useUi((s) => s.probes);
  return (
    <ul className="probes">
      {probes.map((p, k) => (
        <li key={probeLabel(p)} data-probe={probeLabel(p)} style={{ "--probe": `var(--probe-${k % 6})` } as React.CSSProperties}>
          {probeLabel(p)}
          <button type="button" aria-label={`Remove probe ${probeLabel(p)}`} onClick={() => ui.getState().removeProbe(p)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A time or frequency field parsed by the core's unit parser. */
function useQuantityField(initial: string, unit: "second" | "hertz") {
  const { parseQuantity } = useEditor();
  const [text, setText] = useState(initial);
  const parsed = JSON.parse(parseQuantity(text, unit)) as { ok?: Quantity; err?: string };
  return { text, setText, value: parsed.ok?.si, error: parsed.err };
}

function TranSettings() {
  const { edits } = useEditor();
  const analyses = useCircuit((s) => s.analyses);
  const isTran = (a: Analysis): a is Extract<Analysis, { type: "tran" }> => a.type === "tran";
  const ran = useCircuit((s) => s.sim.analyses);
  const own = analyses.find(isTran);
  // Auto mode starts from the transient that actually ran (the core's default).
  const shown = own ?? ran?.find(isTran) ?? { type: "tran", t_stop: 10e-3, t_step: 10e-6 };
  const stop = useQuantityField(formatSi(shown.t_stop, "s").replace(" ", ""), "second");
  const step = useQuantityField(formatSi(shown.t_step, "s").replace(" ", ""), "second");
  const rest = analyses.filter((a) => a.type !== "tran");
  const steps = stop.value && step.value ? stop.value / step.value : NaN;
  const problem =
    stop.error ?? step.error ?? (!(steps >= 1) ? "the step must not exceed the stop time" : steps > MAX_TRAN_STEPS ? `at most ${MAX_TRAN_STEPS.toLocaleString()} steps` : null);
  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        edits.setAnalyses([...rest, { type: "tran", t_step: step.value!, t_stop: stop.value! }], `Transient to ${stop.text}`);
      }}
    >
      <span className="mode">{own ? "Custom" : "Auto"}</span>
      <label>
        Stop <input value={stop.text} onChange={(e) => stop.setText(e.target.value)} size={6} aria-invalid={!!stop.error} />
      </label>
      <label>
        Step <input value={step.text} onChange={(e) => step.setText(e.target.value)} size={6} aria-invalid={!!step.error} />
      </label>
      <button type="submit" disabled={!!problem} title={problem ?? "Run this transient after every edit"}>
        Run
      </button>
      {own && (
        <button type="button" onClick={() => edits.setAnalyses(rest, "Auto transient")} title="Back to five periods of the slowest source">
          Auto
        </button>
      )}
    </form>
  );
}

function AcSettings() {
  const { edits } = useEditor();
  const analyses = useCircuit((s) => s.analyses);
  const own = analyses.find((a): a is Extract<Analysis, { type: "ac" }> => a.type === "ac");
  const cur = own ?? { type: "ac" as const, ...AC_DEFAULT };
  const start = useQuantityField(formatSi(cur.f_start, "Hz").replace(" ", ""), "hertz");
  const stop = useQuantityField(formatSi(cur.f_stop, "Hz").replace(" ", ""), "hertz");
  const rest = analyses.filter((a) => a.type !== "ac");
  const problem = start.error ?? stop.error ?? (start.value! > 0 && start.value! < stop.value! ? null : "start must be above 0 and below stop");
  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem) return;
        edits.setAnalyses(
          [...rest, { type: "ac", points_per_decade: cur.points_per_decade, f_start: start.value!, f_stop: stop.value! }],
          own ? "Change AC sweep" : "Run AC sweep",
        );
      }}
    >
      <label>
        From <input value={start.text} onChange={(e) => start.setText(e.target.value)} size={6} aria-invalid={!!start.error} />
      </label>
      <label>
        to <input value={stop.text} onChange={(e) => stop.setText(e.target.value)} size={6} aria-invalid={!!stop.error} />
      </label>
      <button type="submit" disabled={!!problem} title={problem ?? "Run this sweep after every edit"}>
        {own ? "Update" : "Run AC sweep"}
      </button>
      {own && (
        <button type="button" onClick={() => edits.setAnalyses(rest, "Remove AC sweep")}>
          Stop
        </button>
      )}
    </form>
  );
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function Chart({ plot, log, xUnit, playback }: { plot: Plot; log: boolean; xUnit: "s" | "Hz"; playback: Playback | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);
  // A new chart only when the set of traces changes; new data just replaces the old.
  const shape = `${log}|${plot.traces.map((t) => `${t.label}/${t.colour}/${t.follow}`).join(",")}`;
  const data: AlignedData = useMemo(() => [plot.x, ...plot.traces.map((t) => t.y)], [plot]);

  useEffect(() => {
    const el = ref.current!;
    const units = [...new Set(plot.traces.map((t) => t.unit))];
    const axis = { stroke: cssVar("--muted"), grid: { stroke: cssVar("--line"), width: 1 }, ticks: { stroke: cssVar("--line"), width: 1 } };
    const opts: Options = {
      width: el.clientWidth,
      height: el.clientHeight,
      scales: { x: log ? { time: false, distr: 3, log: 10 } : { time: false }, ...Object.fromEntries(units.map((u) => [u, {}])) },
      axes: [
        // A log axis passes null for its unlabelled minor ticks.
        { ...axis, values: (_, splits) => splits.map((v) => (v == null ? "" : fmt(xUnit)(v))) },
        ...units.map((u, k) => ({
          ...axis,
          scale: u,
          side: k === 0 ? 3 : 1,
          size: 64,
          values: (_: uPlot, splits: number[]) => splits.map((v) => (v == null ? "" : fmt(u)(v))),
        })),
      ],
      series: [
        { label: xUnit === "s" ? "time" : "frequency", value: (_, v) => (v == null ? "—" : fmt(xUnit)(v)) },
        ...plot.traces.map((t) => ({
          label: t.label,
          scale: t.unit,
          stroke: t.colour,
          width: t.unit === "°" ? 1 : 1.5,
          dash: t.follow ? [5, 4] : t.unit === "°" ? [2, 3] : undefined,
          value: (_: uPlot, v: number | null) => (v == null ? "—" : fmt(t.unit)(v)),
        })),
      ],
      cursor: { drag: { x: true, y: false } },
      legend: { show: true },
    };
    const u = new uPlot(opts, data, el);
    chart.current = u;
    // The legend sits under the plot, inside the same box.
    const fitSize = () => {
      const legend = u.root.querySelector<HTMLElement>(".u-legend")?.offsetHeight ?? 0;
      u.setSize({ width: el.clientWidth, height: Math.max(60, el.clientHeight - legend - 4) });
    };
    fitSize();
    const ro = new ResizeObserver(fitSize);
    ro.observe(el);

    // The overlays' playback instant, as a line across the plot.
    let frame = 0;
    const cursor = document.createElement("div");
    cursor.className = "scope-cursor";
    if (playback) {
      u.over.appendChild(cursor);
      const tick = () => {
        const xs = u.data[0];
        if (xs.length > 1) {
          const t = xs[0]! + playback.phase * (xs[xs.length - 1]! - xs[0]!);
          cursor.style.transform = `translateX(${u.valToPos(t, "x")}px)`;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      u.destroy();
      chart.current = null;
    };
    // `data` is applied by the effect below; the chart is rebuilt only for a new shape.
  }, [shape, xUnit, playback]);

  useEffect(() => {
    chart.current?.setData(data);
  }, [data]);

  return <div ref={ref} className="chart" />;
}
