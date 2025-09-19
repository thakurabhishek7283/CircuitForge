// Tools, verified blocks and parts (LLD §10: "the place tool lists registry parts"; §12: blocks
// come from templates). Placing adds the part with the next free refdes; the layout positions it,
// and a drag pins it where the user wants it. A block opens its insert form in the inspector.
import { useMemo, useState } from "react";
import type { Category, Quantity, TemplateDef } from "../gen/contract.ts";
import type { Tool } from "../store/uiStore.ts";
import { useCircuit, useEditor, useUi } from "./editorContext.ts";
import { ROLE_ORDER, roleTitle } from "./InsertBlock.tsx";

const CATEGORY_TITLES: Record<Category, string> = {
  V: "Sources",
  R: "Resistors",
  C: "Capacitors",
  L: "Inductors",
  D: "Diodes",
  Q: "Transistors",
  U: "ICs",
  J: "Connectors",
};
const CATEGORY_ORDER: Category[] = ["V", "R", "C", "L", "D", "Q", "U", "J"];

const sameTool = (a: Tool, b: Tool) => a.kind === b.kind && (a.kind !== "rail" || (b.kind === "rail" && a.net === b.net));

export function Palette() {
  const { registry, edits, ui } = useEditor();
  const tool = useUi((s) => s.tool);
  const mode = useCircuit((s) => s.mode);
  const readOnly = mode === "generating";
  const parts = Object.values(registry.parts).filter((p) => p !== undefined);

  const toolButton = (t: Tool, text: string, title: string) => (
    <button type="button" aria-pressed={sameTool(tool, t)} disabled={readOnly} title={title} onClick={() => ui.getState().setTool(t)}>
      {text}
    </button>
  );

  return (
    <nav className="palette" aria-label="Tools and parts">
      <h3>Tools</h3>
      <div className="tools">
        {toolButton({ kind: "select" }, "Select", "Select and drag parts (V, Esc)")}
        {toolButton({ kind: "wire", from: null }, "Wire", "Click a pin, then another pin or a wire (W)")}
      </div>
      <h3>Supply</h3>
      <div className="tools">{toolButton({ kind: "rail", net: "GND", netKind: { kind: "ground" } }, "Ground", "Click pins to connect them to ground (G)")}</div>
      <RailForm disabled={readOnly} />
      <Blocks disabled={readOnly} />
      <h2 className="group">Parts</h2>
      {CATEGORY_ORDER.map((cat) => {
        const list = parts.filter((p) => p.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat}>
            <h3>{CATEGORY_TITLES[cat]}</h3>
            <ul>
              {list.map((p) => (
                <li key={p.id}>
                  <button type="button" data-part={p.id} disabled={readOnly} title={p.teach ?? p.title} onClick={() => edits.place(p.id)}>
                    {p.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

/** Verified block templates by role; one opens its insert form. */
function Blocks({ disabled }: { disabled: boolean }) {
  const { registry, ui } = useEditor();
  const inserting = useUi((s) => s.inserting);
  const templates = Object.values(registry.templates ?? {}).filter((t): t is TemplateDef => t !== undefined);
  if (!templates.length) return null;
  return (
    <>
      <h2 className="group">Blocks</h2>
      {ROLE_ORDER.map((role) => {
        const list = templates.filter((t) => t.role === role);
        if (!list.length) return null;
        return (
          <section key={role}>
            <h3>{roleTitle(role)}</h3>
            <ul>
              {list.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    data-template={t.id}
                    aria-pressed={inserting === t.id}
                    disabled={disabled}
                    title={t.teach ?? t.title}
                    onClick={() => ui.getState().setInserting(t.id)}
                  >
                    {t.title}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/** A named supply rail at a voltage, e.g. VCC +12 V; the rail tool then connects pins to it. */
function RailForm({ disabled }: { disabled: boolean }) {
  const { ui, parseQuantity } = useEditor();
  const nets = useCircuit((s) => s.nets);
  const rails = useMemo(() => Object.values(nets).filter((n) => n?.kind.kind === "power"), [nets]);
  const [name, setName] = useState("VCC");
  const [volts, setVolts] = useState("5");
  const v = (JSON.parse(parseQuantity(volts, "volt")) as { ok?: Quantity }).ok;
  const validName = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && name.toUpperCase() !== "GND";
  return (
    <>
      <form
        className="rail-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (v && validName) ui.getState().setTool({ kind: "rail", net: name, netKind: { kind: "power", volts: v.si } });
        }}
      >
        <input aria-label="Rail name" value={name} onChange={(e) => setName(e.target.value)} size={5} aria-invalid={!validName} />
        <input aria-label="Rail voltage" value={volts} onChange={(e) => setVolts(e.target.value)} size={4} aria-invalid={!v} />
        <button type="submit" disabled={disabled || !v || !validName} title="Then click pins to put them on this rail">
          Rail
        </button>
      </form>
      {rails.length > 0 && (
        <div className="tools">
          {rails.map((n) =>
            n && n.kind.kind === "power" ? (
              <button
                key={n.id}
                type="button"
                disabled={disabled}
                onClick={() => ui.getState().setTool({ kind: "rail", net: n.id, netKind: n.kind })}
                title={`Connect pins to ${n.id}`}
              >
                {n.id} {n.kind.volts > 0 ? "+" : ""}
                {n.kind.volts} V
              </button>
            ) : null,
          )}
        </div>
      )}
    </>
  );
}
