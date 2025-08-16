// Schematic view (LLD §10): registry symbols as <symbol> defs, instances as memoized <use>
// elements, wires as polylines. Pan and zoom go through one transform written straight to the
// DOM by d3-zoom, so they never re-render React. Hit-testing uses native SVG events.
import { select } from "d3-selection";
import { type ZoomBehavior, zoom, zoomIdentity } from "d3-zoom";
import { memo, useEffect, useMemo, useRef } from "react";
import type { PartDef, PartInstance } from "../../gen/contract.ts";
import { useCircuit, useEditor } from "../../app/editorContext.ts";
import type { Selection } from "../../store/circuitStore.ts";
import { type Point, symbolTransform } from "../../workers/layout.geometry.ts";
import type { BlockFrame, Layout, PlacedFlag, PlacedSymbol } from "../../workers/layout.types.ts";
import { formatVolts, partName, partValue } from "./labels.ts";

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

const Frame = memo(function Frame({ id, frame, selected, onSelect }: { id: string; frame: BlockFrame; selected: boolean; onSelect: (s: Selection) => void }) {
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
        {frame.title}
      </text>
    </g>
  );
});

/** The drawing for one layout; split out so it renders on the server in tests. */
export function SchematicContent({
  layout,
  parts,
  defs,
  voltages,
  selection,
  onSelect,
}: {
  layout: Layout;
  parts: Record<string, PartInstance>;
  defs: Record<string, PartDef | undefined>;
  voltages: Record<string, number>;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const named = new Set<string>();
  return (
    <>
      <g className="blocks">
        {Object.entries(layout.blocks).map(([id, f]) => (
          <Frame key={id} id={id} frame={f} selected={selection?.kind === "block" && selection.id === id} onSelect={onSelect} />
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

export function Schematic() {
  const { store, registry } = useEditor();
  const layout = useCircuit((s) => s.layout);
  const parts = useCircuit((s) => s.parts);
  const voltages = useCircuit((s) => s.sim.voltages);
  const selection = useCircuit((s) => s.selection);
  const onSelect = store.getState().select;
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    const svg = svgRef.current!;
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 8])
      .on("zoom", (e: { transform: { toString(): string } }) => viewRef.current?.setAttribute("transform", e.transform.toString()));
    select(svg).call(z).on("dblclick.zoom", null);
    zoomRef.current = z;
    return () => {
      select(svg).on(".zoom", null);
    };
  }, []);

  // Fit the circuit into view the first time it is laid out.
  useEffect(() => {
    if (!layout || fitted.current || !layout.bounds.width) return;
    fitted.current = true;
    fit(svgRef.current!, zoomRef.current!, layout);
  }, [layout]);

  return (
    <div className="schematic-wrap">
      <svg ref={svgRef} className="schematic" role="img" aria-label="Circuit schematic" onClick={() => onSelect(null)}>
        <g ref={viewRef}>
          {layout && (
            <SchematicContent layout={layout} parts={parts} defs={registry.parts} voltages={voltages} selection={selection} onSelect={onSelect} />
          )}
        </g>
      </svg>
      <button type="button" className="fit" title="Fit to view" onClick={() => layout && fit(svgRef.current!, zoomRef.current!, layout)}>
        Fit
      </button>
    </div>
  );
}

function fit(svg: SVGSVGElement, z: ZoomBehavior<SVGSVGElement, unknown>, layout: Layout) {
  const { width, height } = svg.getBoundingClientRect();
  const b = layout.bounds;
  const pad = 40;
  const k = Math.min(3, Math.max(0.2, Math.min(width / (b.width + 2 * pad), height / (b.height + 2 * pad))));
  const t = zoomIdentity.translate(width / 2 - k * (b.x + b.width / 2), height / 2 - k * (b.y + b.height / 2)).scale(k);
  select(svg).call(z.transform, t);
}
