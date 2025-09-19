// Schematic view (LLD §10): registry symbols as <symbol> defs, instances as memoized <use>
// elements, wires as polylines. Pan and zoom go through one transform written straight to the
// DOM by d3-zoom, so they never re-render React. Hit-testing uses native SVG events.
//
// Edit tools: the wire and rail tools snap only to pins (layout.pins); a drag pins a part where it
// is dropped. Pointer feedback (snap marker, rubber band, the dragged part) is written to the DOM
// directly; only the resulting op re-renders. Simulation overlays live on a canvas under the SVG
// (overlay.ts).
import { select } from "d3-selection";
import { type D3ZoomEvent, type ZoomBehavior, type ZoomTransform, zoom, zoomIdentity } from "d3-zoom";
import { memo, useEffect, useMemo, useRef } from "react";
import type { CheckResult, PartDef, PartInstance } from "../../gen/contract.ts";
import { useCircuit, useEditor, useUi } from "../../app/editorContext.ts";
import type { Selection } from "../../store/circuitStore.ts";
import type { Tool } from "../../store/uiStore.ts";
import { type Point, symbolTransform } from "../../workers/layout.geometry.ts";
import type { BlockFrame, Layout, PlacedFlag, PlacedSymbol } from "../../workers/layout.types.ts";
import { formatVolts, partName, partValue } from "./labels.ts";
import { OverlayRenderer } from "./overlay.ts";

/** The sprite sheet's <symbol> elements, inlined once (cross-origin <use href> is not allowed). */
export function SymbolDefs({ sprite }: { sprite: string }) {
  const inner = useMemo(() => sprite.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""), [sprite]);
  return (
    <svg className="symbol-defs" aria-hidden="true" width="0" height="0">
      <defs dangerouslySetInnerHTML={{ __html: inner }} />
    </svg>
  );
}

const points = (pl: Point[]) => pl.map((p) => `${p.x},${p.y}`).join(" ");

interface PartGlyphProps {
  sym: PlacedSymbol;
  name: string;
  value: string;
  selected: boolean;
  onSelect: (s: Selection) => void;
}

const PartGlyph = memo(function PartGlyph({ sym, name, value, selected, onSelect }: PartGlyphProps) {
  const { label } = sym;
  return (
    <g
      className={selected ? "part selected" : "part"}
      data-refdes={sym.refdes}
      onClick={(e) => {
        e.stopPropagation();
        onSelect({ kind: "part", refdes: sym.refdes });
      }}
    >
      <rect className="hit" x={sym.x} y={sym.y} width={sym.width} height={sym.height} />
      <use
        href={`#sym-${sym.symbol}`}
        width={sym.symbolWidth}
        height={sym.symbolHeight}
        transform={symbolTransform(sym.x, sym.y, sym.symbolWidth, sym.symbolHeight, sym.rot, sym.flip)}
      />
      <text className="refdes" x={label.x} y={label.y} textAnchor={label.anchor}>
        {name}
      </text>
      {value && (
        <text className="value" x={label.x} y={label.y + 11} textAnchor={label.anchor}>
          {value}
        </text>
      )}
    </g>
  );
});

const Flag = memo(function Flag({ flag, onSelect }: { flag: PlacedFlag; onSelect: (s: Selection) => void }) {
  return (
    <g
      className="flag"
      data-net={flag.net}
      onClick={(e) => {
        e.stopPropagation();
        onSelect({ kind: "net", id: flag.net });
      }}
    >
      <use
        href={`#sym-${flag.symbol}`}
        width={flag.symbolWidth}
        height={flag.symbolHeight}
        transform={symbolTransform(flag.x, flag.y, flag.symbolWidth, flag.symbolHeight, flag.rot)}
      />
      {flag.text && (
        <text x={flag.textAt.x} y={flag.textAt.y} textAnchor={flag.textAnchor}>
          {flag.text}
        </text>
      )}
    </g>
  );
});

interface NetWiresProps {
  id: string;
  polylines: Point[][];
  junctions: Point[] | undefined;
  selected: boolean;
  onSelect: (s: Selection) => void;
}

const NetWires = memo(function NetWires({ id, polylines, junctions, selected, onSelect }: NetWiresProps) {
  return (
    <g
      className={selected ? "net selected" : "net"}
      data-net={id}
      onClick={(e) => {
        e.stopPropagation();
        onSelect({ kind: "net", id });
      }}
    >
      {polylines.map((pl, i) => (
        <polyline key={`h${i}`} className="hit" points={points(pl)} />
      ))}
      {polylines.map((pl, i) => (
        <polyline key={i} className="wire" points={points(pl)} />
      ))}
      {junctions?.map((p, i) => <circle key={`j${i}`} className="junction" cx={p.x} cy={p.y} r={2.5} />)}
    </g>
  );
});

/** A block's frame and title, followed by one badge per spec check (✓ within tolerance, ✗ out,
 * ? not measured). The badges flow after the title as tspans, so no text is measured. */
const Frame = memo(function Frame({
  id,
  frame,
  selected,
  checks,
  onSelect,
}: {
  id: string;
  frame: BlockFrame;
  selected: boolean;
  checks: CheckResult[] | undefined;
  onSelect: (s: Selection) => void;
}) {
  return (
    <g className={selected ? "block selected" : "block"} data-block={id}>
      <rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx={8} />
      <text
        x={frame.x + 4}
        y={frame.y - 8}
        onClick={(e) => {
          e.stopPropagation();
          onSelect({ kind: "block", id });
        }}
      >
        {checks && checks.length > 0 && (
          <title>
            {checks.map((c) => `${c.label}: ${c.measured_display ?? c.note ?? "—"} (target ${c.target_display} ±${c.tol_pct}%)`).join("\n")}
          </title>
        )}
        {frame.title}
        {checks?.map((c) => (
          <tspan key={c.name} dx={8} className={c.pass ? "badge pass" : c.measured_display ? "badge fail" : "badge unknown"} data-check={c.name}>
            {`${c.symbol} ${c.measured_display ?? "?"} ${c.pass ? "✓" : c.measured_display ? "✗" : ""}`.trimEnd()}
          </tspan>
        ))}
      </text>
    </g>
  );
});

const NO_CHECKS: CheckResult[] = [];

/** The drawing for one layout; split out so it renders on the server in tests. */
export function SchematicContent({
  layout,
  parts,
  defs,
  voltages,
  selection,
  checks = NO_CHECKS,
  onSelect,
}: {
  layout: Layout;
  parts: Record<string, PartInstance>;
  defs: Record<string, PartDef | undefined>;
  voltages: Record<string, number>;
  selection: Selection | null;
  /** Spec check results of template blocks (sim.checks). */
  checks?: CheckResult[];
  onSelect: (s: Selection) => void;
}) {
  const named = new Set<string>();
  const byBlock = useMemo(() => {
    const m = new Map<string, CheckResult[]>();
    for (const c of checks) m.set(c.block, [...(m.get(c.block) ?? []), c]);
    return m;
  }, [checks]);
  return (
    <>
      <g className="blocks">
        {Object.entries(layout.blocks).map(([id, f]) => (
          <Frame key={id} id={id} frame={f} selected={selection?.kind === "block" && selection.id === id} checks={byBlock.get(id)} onSelect={onSelect} />
        ))}
      </g>
      <g className="wires">
        {Object.entries(layout.wires).map(([id, pls]) => (
          <NetWires
            key={id}
            id={id}
            polylines={pls}
            junctions={layout.junctions[id]}
            selected={selection?.kind === "net" && selection.id === id}
            onSelect={onSelect}
          />
        ))}
      </g>
      <g className="flags">
        {layout.flags.map((f) => (
          <Flag key={f.key} flag={f} onSelect={onSelect} />
        ))}
      </g>
      <g className="parts">
        {Object.values(layout.symbols).map((s) => {
          const inst = parts[s.refdes];
          if (!inst) return null; // removed since this layout; the next layout drops it
          const first = !named.has(s.refdes); // the value goes on the first unit only
          named.add(s.refdes);
          return (
            <PartGlyph
              key={s.key}
              sym={s}
              name={partName(s.refdes, s.unit)}
              value={first ? partValue(inst, defs[inst.part]) : ""}
              selected={selection?.kind === "part" && selection.refdes === s.refdes}
              onSelect={onSelect}
            />
          );
        })}
      </g>
      <g className="voltages">
        {Object.entries(layout.netLabels).map(([net, at]) => {
          const v = voltages[net];
          return v === undefined ? null : (
            <text key={net} x={at.x} y={at.y} textAnchor={at.anchor} className={net === selectionNet(selection) ? "volt selected" : "volt"}>
              {formatVolts(v)}
            </text>
          );
        })}
      </g>
    </>
  );
}

const selectionNet = (s: Selection | null) => (s?.kind === "net" ? s.id : null);

/** Pins the wire and rail tools snap to; free pins are drawn open. */
const PinTargets = memo(function PinTargets({ pins, connected }: { pins: Layout["pins"]; connected: Set<string> }) {
  return (
    <g className="pin-targets">
      {Object.entries(pins).flatMap(([ref, at]) =>
        at.map((p, i) => <circle key={`${ref}#${i}`} data-pin={ref} className={connected.has(ref) ? "on" : "free"} cx={p.x} cy={p.y} r={2.5} />),
      )}
    </g>
  );
});

/** Snap radius, in screen pixels. */
const SNAP_PX = 10;
/** Pointer travel before a press on a part becomes a drag, in screen pixels. */
const DRAG_PX = 4;
const GRID = 10;

/** The pin nearest to `p` within `radius`, if any. */
export function nearestPin(pins: Layout["pins"], p: Point, radius: number): { ref: string; at: Point } | null {
  let best: { ref: string; at: Point } | null = null;
  let bestD = radius * radius;
  for (const [ref, ats] of Object.entries(pins)) {
    for (const at of ats) {
      const d = (at.x - p.x) ** 2 + (at.y - p.y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = { ref, at };
      }
    }
  }
  return best;
}

interface Drag {
  refdes: string;
  /** The part's first drawn unit: its placement is the part's. */
  sym: PlacedSymbol;
  start: Point;
  startScreen: Point;
  moved: boolean;
  dx: number;
  dy: number;
}

export function Schematic() {
  const { store, ui, edits, registry, playback } = useEditor();
  const layout = useCircuit((s) => s.layout);
  const parts = useCircuit((s) => s.parts);
  const nets = useCircuit((s) => s.nets);
  const voltages = useCircuit((s) => s.sim.voltages);
  const selection = useCircuit((s) => s.selection);
  const checks = useCircuit((s) => s.sim.checks);
  const tool = useUi((s) => s.tool);
  const rev = useCircuit((s) => s.rev);
  const layoutRev = useCircuit((s) => s.layoutRev);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<SVGGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapRef = useRef<SVGCircleElement>(null);
  const bandRef = useRef<SVGLineElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const hotPin = useRef<{ ref: string; at: Point } | null>(null);
  const drag = useRef<Drag | null>(null);
  const justDragged = useRef(false);
  /** Follow the circuit as it grows until the user pans or zooms (Fit resumes it). */
  const autoFit = useRef(true);

  const connected = useMemo(() => new Set(Object.values(nets).flatMap((n) => n?.pins ?? [])), [nets]);

  useEffect(() => {
    const svg = svgRef.current!;
    const overlay = new OverlayRenderer({ canvas: canvasRef.current!, store, ui, registry, playback });
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 8])
      // In the select tool a press on a part starts a drag, not a pan.
      .filter((e: Event) => {
        if (e.type === "wheel") return true;
        if ((e as MouseEvent).button) return false;
        return !(ui.getState().tool.kind === "select" && (e.target as Element).closest?.(".part"));
      })
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (e.sourceEvent) autoFit.current = false; // a user gesture, not fit()
        transformRef.current = e.transform;
        viewRef.current?.setAttribute("transform", e.transform.toString());
        overlay.setTransform(e.transform);
      });
    select(svg).call(z).on("dblclick.zoom", null);
    zoomRef.current = z;
    return () => {
      select(svg).on(".zoom", null);
      overlay.dispose();
    };
  }, [store, ui, registry, playback]);

  // Keep the circuit in view while it is being built, until the user takes over the view.
  useEffect(() => {
    if (!layout || !autoFit.current || !layout.bounds.width) return;
    fit(svgRef.current!, zoomRef.current!, layout);
  }, [layout]);

  // A new layout has a dropped part in place: clear the drag offsets.
  useEffect(() => {
    for (const g of viewRef.current?.querySelectorAll(".part[transform]") ?? []) g.removeAttribute("transform");
  }, [layout]);

  // Changing tools clears their pointer feedback.
  useEffect(() => {
    hotPin.current = null;
    snapRef.current?.setAttribute("visibility", "hidden");
    if (tool.kind !== "wire" || !tool.from) bandRef.current?.setAttribute("visibility", "hidden");
  }, [tool]);

  const world = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    const [x, y] = transformRef.current.invert([e.clientX - r.left, e.clientY - r.top]);
    return { x, y };
  };

  const dragged = (refdes: string) => viewRef.current!.querySelectorAll(`.part[data-refdes="${refdes}"]`);

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = world(e);
    const d = drag.current;
    if (d) {
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startScreen.x, e.clientY - d.startScreen.y) < DRAG_PX) return;
        // Captured only now: capturing on press would retarget a plain click to the <svg>.
        d.moved = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      // The part's corner snaps to the grid, wherever on the part it was grabbed.
      d.dx = Math.round((d.sym.x + p.x - d.start.x) / GRID) * GRID - d.sym.x;
      d.dy = Math.round((d.sym.y + p.y - d.start.y) / GRID) * GRID - d.sym.y;
      for (const g of dragged(d.refdes)) g.setAttribute("transform", `translate(${d.dx} ${d.dy})`);
      return;
    }
    const t = ui.getState().tool;
    if (t.kind === "select" || !layout) return;
    const hot = nearestPin(layout.pins, p, SNAP_PX / transformRef.current.k);
    hotPin.current = hot;
    const snap = snapRef.current!;
    if (hot) {
      snap.setAttribute("cx", String(hot.at.x));
      snap.setAttribute("cy", String(hot.at.y));
    }
    snap.setAttribute("visibility", hot ? "visible" : "hidden");
    const from = t.kind === "wire" && t.from ? layout.pins[t.from]?.[0] : undefined;
    if (from) {
      const to = hot?.at ?? p;
      const band = bandRef.current!;
      band.setAttribute("x1", String(from.x));
      band.setAttribute("y1", String(from.y));
      band.setAttribute("x2", String(to.x));
      band.setAttribute("y2", String(to.y));
      band.setAttribute("visibility", "visible");
    }
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || ui.getState().tool.kind !== "select" || !layout) return;
    const refdes = (e.target as Element).closest<SVGGElement>(".part")?.dataset.refdes;
    const sym = refdes ? Object.values(layout.symbols).find((s) => s.refdes === refdes) : undefined;
    if (!refdes || !sym) return;
    drag.current = { refdes, sym, start: world(e), startScreen: { x: e.clientX, y: e.clientY }, moved: false, dx: 0, dy: 0 };
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d?.moved) return;
    justDragged.current = true; // the click that ends a drag is not a selection
    if (d.dx === 0 && d.dy === 0) return;
    const r = edits.pin(d.refdes, { x: d.sym.x + d.dx, y: d.sym.y + d.dy, rot: d.sym.rot, flip: d.sym.flip });
    if (r.err) for (const g of dragged(d.refdes)) g.removeAttribute("transform");
  };

  /** A click on an item (or on the background: null), as the active tool reads it. */
  const pick = (sel: Selection | null) => {
    if (justDragged.current) {
      justDragged.current = false;
      return;
    }
    const t: Tool = ui.getState().tool;
    const hot = hotPin.current?.ref;
    if (t.kind === "select") store.getState().select(sel);
    else if (t.kind === "rail") {
      if (hot) edits.wire(hot, { rail: { net: t.net, kind: t.netKind } });
    } else if (!t.from) {
      if (hot) ui.getState().setTool({ kind: "wire", from: hot });
    } else {
      const end = hot && hot !== t.from ? { pin: hot } : sel?.kind === "net" ? { net: sel.id } : null;
      if (end) edits.wire(t.from, end);
      ui.getState().setTool({ kind: "wire", from: null });
    }
  };

  return (
    <div className={`schematic-wrap tool-${tool.kind}`} data-rev={rev} data-layout-rev={layoutRev}>
      <canvas ref={canvasRef} className="overlay" aria-hidden="true" />
      <svg
        ref={svgRef}
        className="schematic"
        role="img"
        aria-label="Circuit schematic"
        onClick={() => pick(null)}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <g ref={viewRef}>
          {layout && (
            <SchematicContent
              layout={layout}
              parts={parts}
              defs={registry.parts}
              voltages={voltages}
              selection={selection}
              checks={checks}
              onSelect={pick}
            />
          )}
          {layout && tool.kind !== "select" && <PinTargets pins={layout.pins} connected={connected} />}
          <line ref={bandRef} className="rubber-band" visibility="hidden" />
          <circle ref={snapRef} className="snap" r={5} visibility="hidden" />
        </g>
      </svg>
      <button
        type="button"
        className="fit"
        title="Fit to view, and keep fitting as the circuit grows"
        onClick={() => {
          autoFit.current = true;
          if (layout) fit(svgRef.current!, zoomRef.current!, layout);
        }}
      >
        Fit
      </button>
    </div>
  );
}

function fit(svg: SVGSVGElement, z: ZoomBehavior<SVGSVGElement, unknown>, layout: Layout) {
  const { width, height } = svg.getBoundingClientRect();
  const b = layout.bounds;
  const pad = 40;
  const k = Math.min(1.5, Math.max(0.2, Math.min(width / (b.width + 2 * pad), height / (b.height + 2 * pad))));
  const t = zoomIdentity.translate(width / 2 - k * (b.x + b.width / 2), height / 2 - k * (b.y + b.height / 2)).scale(k);
  select(svg).call(z.transform, t);
}
