// Insert a verified block from a template (LLD §12): type the targets ("1k", "0.707"), say where
// each port connects, see the part values the core's solver picks, then insert it as one undo
// step. Every rule (ranges, rail voltages, net names) is the core's; this form only collects text.
import { useMemo, useState } from "react";
import type { Block, InsertBlock, Net, PortBinding, PortDirection, Quantity, TemplateDef } from "../gen/contract.ts";
import { useCircuit, useEditor } from "./editorContext.ts";

const ROLE_TITLES: Record<string, string> = {
  filter: "Filters",
  amplifier: "Amplifiers",
  buffer: "Buffers",
  oscillator: "Oscillators",
  supply: "Supplies",
  comparator: "Comparators",
  source: "Sources",
  bias: "Bias",
};
export const ROLE_ORDER = Object.keys(ROLE_TITLES);
export const roleTitle = (role: string) => ROLE_TITLES[role] ?? role;

const isPower = (d: PortDirection | undefined) => d === "power_pos" || d === "power_neg";
const NEW = "\u0000new"; // select value for "a new net / rail"

/** The form's choice for one port, before it becomes a `PortBinding`. */
type Choice = { net: string } | { newRail: { name: string; volts: string } } | "new";

/** A net as a learner knows it: by the block ports on it ("B1_IN: Sallen-Key low-pass in"). */
function netLabel(id: string, blocks: Record<string, Block | undefined>): string {
  const ports = Object.values(blocks).flatMap((b) => (b ? b.ports.filter((p) => p.net === id).map((p) => `${b.title} ${p.name}`) : []));
  return ports.length ? `${id}: ${ports.join(", ")}` : id;
}

function railLabel(n: Net): string {
  const v = n.kind.kind === "power" ? n.kind.volts : 0;
  return `${n.id} ${v > 0 ? "+" : ""}${v} V`;
}

/** Default bindings: a compatible existing rail (or a new one at the template's voltage), GND,
 * and new nets for signals. */
function defaults(t: TemplateDef, nets: Record<string, Net | undefined>): Record<string, Choice> {
  const out: Record<string, Choice> = {};
  for (const [port, dir] of Object.entries(t.ports)) {
    if (!isPower(dir)) {
      if (dir !== "ground") out[port] = "new";
      continue;
    }
    const rail = t.rails?.[port];
    if (!rail) continue;
    const lo = rail.min ?? rail.volts;
    const hi = rail.max ?? rail.volts;
    const existing = nets[rail.net];
    if (existing?.kind.kind === "power" && existing.kind.volts >= lo && existing.kind.volts <= hi) {
      out[port] = { net: rail.net };
    } else {
      let name = rail.net;
      for (let k = 2; nets[name]; k++) name = `${rail.net}_${k}`;
      out[port] = { newRail: { name, volts: String(rail.volts) } };
    }
  }
  return out;
}

function binding(c: Choice): PortBinding {
  if (c === "new") return "new";
  if ("net" in c) return { net: c.net };
  return { rail: { net: c.newRail.name, volts: Number(c.newRail.volts) } };
}

export function InsertBlockPanel({ templateId }: { templateId: string }) {
  const { registry, edits, ui, parseQuantity } = useEditor();
  const nets = useCircuit((s) => s.nets);
  const blocks = useCircuit((s) => s.blocks);
  const t = registry.templates?.[templateId];
  const [targets, setTargets] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(t?.targets ?? {}).map(([k, td]) => [k, td?.default ?? ""])),
  );
  const [choices, setChoices] = useState<Record<string, Choice>>(() => (t ? defaults(t, nets) : {}));
  const req: InsertBlock = useMemo(
    () => ({ template: templateId, targets, ports: Object.fromEntries(Object.entries(choices).map(([p, c]) => [p, binding(c)])) }),
    [templateId, targets, choices],
  );
  const preview = useMemo(() => edits.previewBlock(req), [edits, req, nets]);
  if (!t) return null;

  const close = () => ui.getState().setInserting(null);
  const insert = () => {
    const r = edits.insertBlock(req);
    if (r.err) return;
    close();
    // A block measured in AC (a filter, an amplifier) shows its response straight away.
    if (t.checks.some((c) => c.kind.startsWith("ac_"))) ui.getState().setScope({ open: true, tab: "ac" });
  };
  const signalNets = Object.values(nets)
    .filter((n): n is Net => n?.kind.kind === "signal")
    .sort((a, b) => a.id.localeCompare(b.id));
  const railNets = Object.values(nets)
    .filter((n): n is Net => n?.kind.kind === "power")
    .sort((a, b) => a.id.localeCompare(b.id));

  return (
    <form
      className="insert-block"
      aria-label={`Insert ${t.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (preview.ok) insert();
      }}
    >
      <h2>{t.title}</h2>
      <p className="sub">{roleTitle(t.role).replace(/s$/, "")} block · verified template</p>
      {t.teach && <p className="teach">{t.teach}</p>}

      {Object.keys(t.targets ?? {}).length > 0 && <h3>What you want</h3>}
      {Object.entries(t.targets ?? {}).map(([name, td]) => {
        if (!td) return null;
        const parsed = JSON.parse(parseQuantity(targets[name] ?? "", td.unit)) as { ok?: Quantity; err?: string };
        // Unitless targets (Q, gain) read as plain numbers, not engineering notation ("500m").
        const fmt = (x: number) =>
          td.unit === "unitless" ? String(Number(x.toPrecision(3))) : ((JSON.parse(parseQuantity(String(x), td.unit)) as { ok?: Quantity }).ok?.display ?? String(x));
        return (
          <div className="field" key={name}>
            <label htmlFor={`t-${name}`}>{td.label}</label>
            <input
              id={`t-${name}`}
              value={targets[name] ?? ""}
              spellCheck={false}
              aria-invalid={!!parsed.err}
              onChange={(e) => setTargets({ ...targets, [name]: e.target.value })}
            />
            <span className={parsed.err ? "parsed bad" : "parsed"}>
              {parsed.err ?? `${fmt(td.min)} to ${fmt(td.max)}${parsed.ok ? ` · ${fmt(parsed.ok.si)}` : ""}`}
            </span>
          </div>
        );
      })}

      <h3>Connections</h3>
      {Object.entries(t.ports).map(([port, dir]) => {
        if (dir === "ground") {
          return (
            <div className="field" key={port}>
              <label>{port}</label>
              <span className="fixed">GND</span>
            </div>
          );
        }
        const choice = choices[port] ?? "new";
        const set = (c: Choice) => setChoices({ ...choices, [port]: c });
        if (isPower(dir)) {
          const rail = t.rails?.[port];
          const lo = rail?.min ?? rail?.volts;
          const hi = rail?.max ?? rail?.volts;
          const value = typeof choice === "object" && "net" in choice ? choice.net : NEW;
          const fresh = typeof choice === "object" && "newRail" in choice ? choice.newRail : { name: rail?.net ?? "VCC", volts: String(rail?.volts ?? 5) };
          return (
            <div className="field port" key={port}>
              <label htmlFor={`p-${port}`}>{port}</label>
              <select id={`p-${port}`} value={value} onChange={(e) => set(e.target.value === NEW ? { newRail: fresh } : { net: e.target.value })}>
                {railNets.map((n) => (
                  <option key={n.id} value={n.id}>
                    {railLabel(n)}
                  </option>
                ))}
                <option value={NEW}>New rail…</option>
              </select>
              {value === NEW && (
                <span className="new-rail">
                  <input aria-label={`${port} rail name`} value={fresh.name} onChange={(e) => set({ newRail: { ...fresh, name: e.target.value } })} size={6} />
                  <input aria-label={`${port} rail volts`} value={fresh.volts} onChange={(e) => set({ newRail: { ...fresh, volts: e.target.value } })} size={4} />V
                </span>
              )}
              <span className="parsed">{lo === hi ? `${lo} V supply` : `supply ${lo} to ${hi} V`}</span>
            </div>
          );
        }
        const value = typeof choice === "object" && "net" in choice ? choice.net : NEW;
        return (
          <div className="field port" key={port}>
            <label htmlFor={`p-${port}`}>{port}</label>
            <select id={`p-${port}`} value={value} onChange={(e) => set(e.target.value === NEW ? "new" : { net: e.target.value })}>
              <option value={NEW}>New net (wire it later)</option>
              {signalNets.map((n) => (
                <option key={n.id} value={n.id}>
                  {netLabel(n.id, blocks)}
                </option>
              ))}
            </select>
            <span className="parsed">{dir}</span>
          </div>
        );
      })}

      {preview.ok ? (
        <>
          <h3>Part values</h3>
          <p className="values" aria-label="Solved part values">
            {Object.entries(preview.ok.values)
              .flatMap(([local, params]) => {
                const entries = Object.entries(params ?? {});
                // Name the value only when a part has several (a source's amplitude, frequency…).
                return entries.map(([key, q]) => (entries.length > 1 ? `${local} ${key} ${q?.display}` : `${local} ${q?.display}`));
              })
              .join(" · ") || "No values to choose."}
          </p>
          <h3>Checked after every simulation</h3>
          <ul className="spec">
            {t.checks.map((c) => (
              <li key={c.name}>
                {c.label}: {preview.ok.spec_display[c.name]} ±{preview.ok.spec[c.name]?.tol_pct}%
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="problem" role="alert">
          {preview.err.message}
        </p>
      )}

      <div className="row-actions">
        <button type="submit" className="primary" disabled={!preview.ok}>
          Insert block
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
