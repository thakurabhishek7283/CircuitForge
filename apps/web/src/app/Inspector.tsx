// Details of the selected part, net or block, with live OP values.
import { useCircuit, useEditor } from "./editorContext.ts";
import { formatVolts } from "../views/schematic/labels.ts";

export function Inspector() {
  const { registry } = useEditor();
  const selection = useCircuit((s) => s.selection);
  const parts = useCircuit((s) => s.parts);
  const nets = useCircuit((s) => s.nets);
  const blocks = useCircuit((s) => s.blocks);
  const voltages = useCircuit((s) => s.sim.voltages);

  if (!selection) {
    return (
      <aside className="inspector">
        <p className="hint">Select a part, a wire or a block title. Drag to pan, scroll to zoom.</p>
      </aside>
    );
  }

  if (selection.kind === "part") {
    const inst = parts[selection.refdes];
    const def = inst && registry.parts[inst.part];
    if (!inst || !def) return null;
    const pinNets = def.pins.map((p) => {
      const ref = `${inst.refdes}.${p.name}`;
      const net = Object.values(nets).find((n) => n?.pins.includes(ref))?.id;
      return { pin: p.name, net, v: net === undefined ? undefined : voltages[net] };
    });
    return (
      <aside className="inspector">
        <h2>{inst.refdes}</h2>
        <p className="sub">{def.title}</p>
        {Object.keys(inst.params).length > 0 && (
          <dl>
            {Object.entries(inst.params).map(([k, q]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{q?.display}</dd>
              </div>
            ))}
          </dl>
        )}
        <h3>Pins</h3>
        <table>
          <tbody>
            {pinNets.map(({ pin, net, v }) => (
              <tr key={pin}>
                <td>{pin}</td>
                <td>{net ?? "—"}</td>
                <td className="num">{v === undefined ? "" : formatVolts(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {def.teach && <p className="teach">{def.teach}</p>}
      </aside>
    );
  }

  if (selection.kind === "net") {
    const net = nets[selection.id];
    if (!net) return null;
    const v = voltages[net.id];
    return (
      <aside className="inspector">
        <h2>{net.label ?? net.id}</h2>
        <p className="sub">{net.kind.kind === "power" ? `Power rail, ${net.kind.volts} V` : net.kind.kind === "ground" ? "Ground (0 V reference)" : "Signal net"}</p>
        {v !== undefined && <p className="big">{formatVolts(v)}</p>}
        <h3>Connected pins</h3>
        <p>{net.pins.join(", ")}</p>
      </aside>
    );
  }

  const block = blocks[selection.id];
  if (!block) return null;
  return (
    <aside className="inspector">
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
    </aside>
  );
}
