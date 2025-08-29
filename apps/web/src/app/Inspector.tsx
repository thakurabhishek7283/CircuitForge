// Details of the selected part, net or block, with live OP values and its edits: values (parsed
// by the core: "4k7" and "4.7k" are the same), probes, rotate, auto-place, disconnect, delete.
// With nothing selected it lists the ERC findings.
import { useState } from "react";
import type { ErcIssue, ParamDef, Quantity } from "../gen/contract.ts";
import type { Selection } from "../store/circuitStore.ts";
import { formatSi, formatVolts } from "../views/schematic/labels.ts";
import { rotatePart } from "./commands.ts";
import { useCircuit, useEditor, useUi } from "./editorContext.ts";

export function Inspector() {
  const selection = useCircuit((s) => s.selection);
  return (
    <aside className="inspector">
      {!selection ? <Overview /> : selection.kind === "part" ? <PartPanel refdes={selection.refdes} /> : selection.kind === "net" ? <NetPanel id={selection.id} /> : <BlockPanel id={selection.id} />}
    </aside>
  );
}

function Overview() {
  const erc = useCircuit((s) => s.erc);
  return (
    <>
      <p className="hint">Select a part, a wire or a block title. Drag to pan, scroll to zoom; drag a part to place it yourself.</p>
      <ErcList issues={erc} />
    </>
  );
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function ErcList({ issues }: { issues: ErcIssue[] }) {
  const { store } = useEditor();
  const sorted = [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const target = (i: ErcIssue): Selection | null =>
    i.parts?.[0] ? { kind: "part", refdes: i.parts[0] } : i.nets?.[0] ? { kind: "net", id: i.nets[0] } : i.pins?.[0] ? { kind: "part", refdes: i.pins[0].split(".")[0]! } : null;
  return (
    <>
      <h3>Checks</h3>
      {sorted.length === 0 ? (
        <p className="ok-note">No problems found.</p>
      ) : (
        <ul className="erc" aria-label="Circuit checks">
          {sorted.map((i, k) => (
            <li key={k} data-severity={i.severity} data-code={i.code}>
              <button type="button" disabled={!target(i)} onClick={() => store.getState().select(target(i))}>
                <span className="sev">{i.severity}</span> {i.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** A value as typed, checked live by the core's parser and applied on Enter or blur. */
function ValueField({ refdes, name, def, value }: { refdes: string; name: string; def: ParamDef; value: Quantity | undefined }) {
  const { edits, parseQuantity } = useEditor();
  const shown = value?.display ?? def.default;
  const [text, setText] = useState(shown);
  const parsed = JSON.parse(parseQuantity(text, def.unit)) as { ok?: Quantity; err?: string };
  const range =
    parsed.ok && ((def.min != null && parsed.ok.si < def.min) || (def.max != null && parsed.ok.si > def.max))
      ? `between ${def.min ?? "−∞"} and ${def.max ?? "∞"}`
      : null;
  const problem = parsed.err ?? (range ? `must be ${range}` : null);
  const commit = () => {
    if (text === shown || problem) return;
    if (edits.setParam(refdes, name, text).err) setText(shown);
  };
  return (
    <div className="field">
      <label htmlFor={`v-${refdes}-${name}`}>{name}</label>
      <input
        id={`v-${refdes}-${name}`}
        value={text}
        spellCheck={false}
        aria-invalid={!!problem}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setText(shown);
          else return;
          e.stopPropagation();
        }}
      />
      <span className={problem ? "parsed bad" : "parsed"}>{problem ?? (parsed.ok && text !== shown ? `= ${parsed.ok.display}` : "")}</span>
    </div>
  );
}

function PartPanel({ refdes }: { refdes: string }) {
  const editor = useEditor();
  const { registry, edits, ui, store } = editor;
  const inst = useCircuit((s) => s.parts[refdes]);
  const nets = useCircuit((s) => s.nets);
  const view = useCircuit((s) => s.sim.view);
  const layout = useCircuit((s) => s.layout);
  const probes = useUi((s) => s.probes);
  const def = inst && registry.parts[inst.part];
  if (!inst || !def) return null;

  const pinNets = def.pins.map((p) => {
    const ref = `${inst.refdes}.${p.name}`;
    const net = Object.values(nets).find((n) => n?.pins.includes(ref))?.id;
    return { pin: p.name, ref, net, v: net === undefined ? undefined : view?.op?.v[net], i: view?.op?.i[ref] };
  });
  const drawn = !!layout && Object.values(layout.symbols).some((s) => s.refdes === refdes);

  return (
    <>
      <h2>{inst.refdes}</h2>
      <p className="sub">{def.title}</p>
      {Object.entries(def.params ?? {}).map(([k, pd]) =>
        pd ? <ValueField key={`${k}:${inst.params[k]?.display}`} refdes={refdes} name={k} def={pd} value={inst.params[k]} /> : null,
      )}
      <div className="row-actions">
        <button type="button" onClick={() => rotatePart(editor, refdes)} disabled={!drawn} title="Rotate 90° (R); pins the part where it is">
          Rotate
        </button>
        {inst.pinned && (
          <button type="button" onClick={() => edits.pin(refdes, null)} title="Let the layout place this part again">
            Auto-place
          </button>
        )}
        <button type="button" className="danger" onClick={() => edits.remove({ kind: "part", refdes })} title="Delete (Del)">
          Delete
        </button>
      </div>
      <h3>Pins</h3>
      <table>
        <tbody>
          {pinNets.map(({ pin, ref, net, v, i }) => (
            <tr key={pin} data-pin={ref}>
              <td>{pin}</td>
              <td>
                {net ? (
                  <button type="button" className="link" onClick={() => store.getState().select({ kind: "net", id: net })}>
                    {net}
                  </button>
                ) : (
                  "—"
                )}
              </td>
              <td className="num">{v === undefined ? "" : formatVolts(v)}</td>
              <td className="num">{i === undefined ? "" : formatSi(i, "A")}</td>
              <td className="pin-actions">
                {net && (
                  <>
                    <button
                      type="button"
                      title={`Probe the current into ${ref}`}
                      aria-pressed={probes.some((p) => p.kind === "pin" && p.ref === ref)}
                      onClick={() => ui.getState().addProbe({ kind: "pin", ref })}
                    >
                      I
                    </button>
                    <button type="button" title={`Disconnect ${ref} from ${net}`} onClick={() => edits.disconnect(ref)}>
                      ×
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {def.teach && <p className="teach">{def.teach}</p>}
    </>
  );
}

function NetPanel({ id }: { id: string }) {
  const { edits, ui } = useEditor();
  const net = useCircuit((s) => s.nets[id]);
  const v = useCircuit((s) => s.sim.voltages[id]);
  const probed = useUi((s) => s.probes.some((p) => p.kind === "net" && p.id === id));
  if (!net) return null;
  return (
    <>
      <h2>{net.label ?? net.id}</h2>
      <p className="sub">{net.kind.kind === "power" ? `Power rail, ${net.kind.volts} V` : net.kind.kind === "ground" ? "Ground (0 V reference)" : "Signal net"}</p>
      {v !== undefined && <p className="big">{formatVolts(v)}</p>}
      <div className="row-actions">
        <button type="button" aria-pressed={probed} onClick={() => ui.getState().addProbe({ kind: "net", id })} title="Keep this voltage on the scope">
          Probe
        </button>
        <button type="button" className="danger" onClick={() => edits.remove({ kind: "net", id })} title="Remove every connection of this net (Del)">
          Delete net
        </button>
      </div>
      <h3>Connected pins</h3>
      <p>{net.pins.join(", ")}</p>
    </>
  );
}

function BlockPanel({ id }: { id: string }) {
  const block = useCircuit((s) => s.blocks[id]);
  const voltages = useCircuit((s) => s.sim.voltages);
  if (!block) return null;
  return (
    <>
      <h2>{block.title}</h2>
      <p className="sub">
        {block.role} · {block.status}
      </p>
      <h3>Ports</h3>
      <table>
        <tbody>
          {block.ports.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>{p.net}</td>
              <td className="num">{voltages[p.net] === undefined ? "" : formatVolts(voltages[p.net]!)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
