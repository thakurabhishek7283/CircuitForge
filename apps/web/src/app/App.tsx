import { useEffect, useState } from "react";
// The demo circuit is circuit-core's own fixture (refreshed with UPDATE_FIXTURES=1 cargo test).
import demoSnapshot from "../../../../crates/circuit-core/tests/fixtures/demo_sallen_key.json?raw";
import type { Circuit } from "../gen/contract.ts";
import { Schematic, SymbolDefs } from "../views/schematic/Schematic.tsx";
import { Scope } from "../views/scope/Scope.tsx";
import { bindShortcuts } from "./commands.ts";
import { type Editor, openEditor } from "./editor.ts";
import { EditorContext, useCircuit, useEditor, useUi } from "./editorContext.ts";
import { Inspector } from "./Inspector.tsx";
import { Palette } from "./Palette.tsx";

/** An empty circuit on the demo's registry version. */
function emptySnapshot(): string {
  const { registry_version } = JSON.parse(demoSnapshot) as Circuit;
  const empty: Circuit = { schema_version: 1, registry_version, rev: 0, parts: {}, nets: {}, blocks: {}, analyses: [], hints: [] };
  return JSON.stringify(empty);
}

type Start = "demo" | "new";

export function App() {
  const [start, setStart] = useState<Start>(() => (location.hash === "#new" ? "new" : "demo"));
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: Editor | null = null;
    setEditor(null);
    openEditor(start === "new" ? emptySnapshot() : demoSnapshot).then(
      (e) => {
        if (cancelled) return e.dispose();
        opened = e;
        setEditor(e);
        // Dev builds only: drive the editor from the console.
        if (import.meta.env.DEV) Object.assign(window, { circuitForge: e });
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [start]);

  useEffect(() => (editor ? bindShortcuts(editor) : undefined), [editor]);

  // A link to #new (or back) opens that circuit without a reload.
  useEffect(() => {
    const onHash = () => setStart(location.hash === "#new" ? "new" : "demo");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const open = (s: Start) => {
    history.replaceState(null, "", s === "new" ? "#new" : location.pathname);
    setStart(s);
  };

  if (error) return <div className="splash error">Could not open the circuit: {error}</div>;
  if (!editor) return <div className="splash">Loading…</div>;
  return (
    <EditorContext.Provider value={editor}>
      <SymbolDefs sprite={editor.sprite} />
      <div className="app">
        <Toolbar start={start} onOpen={open} />
        <main>
          <Palette />
          <div className="center">
            <Schematic />
            <Scope />
          </div>
          <Inspector />
        </main>
      </div>
    </EditorContext.Provider>
  );
}

const SIM_TEXT: Record<string, string> = {
  idle: "No circuit",
  pending: "Simulating…",
  running: "Simulating…",
  ok: "Simulated",
  no_convergence: "Did not converge",
  singular_matrix: "Singular matrix",
  timeout: "Timed out",
  error: "Simulation error",
};

function Toolbar({ start, onOpen }: { start: Start; onOpen: (s: Start) => void }) {
  const { store, ui } = useEditor();
  const undo = useCircuit((s) => s.history.undo.at(-1)?.label);
  const redo = useCircuit((s) => s.history.redo.at(-1)?.label);
  const sim = useCircuit((s) => s.sim);
  const lastError = useCircuit((s) => s.lastError);
  const overlays = useUi((s) => s.overlays);
  const tool = useUi((s) => s.tool);
  const issues = useCircuit((s) => s.erc.length);

  const ok = sim.status === "ok" || sim.status === "pending" || sim.status === "running" || sim.status === "idle";
  const toolHint =
    tool.kind === "wire"
      ? tool.from
        ? `Wiring from ${tool.from}: click a pin or a wire (Esc cancels)`
        : "Wire: click a pin to start"
      : tool.kind === "rail"
        ? `Click pins to connect them to ${tool.net} (Esc ends)`
        : null;
  return (
    <header className="toolbar">
      <h1>Circuit Forge</h1>
      <div className="actions">
        <button type="button" aria-pressed={start === "new"} onClick={() => onOpen("new")} title="Start from an empty circuit">
          New
        </button>
        <button type="button" aria-pressed={start === "demo"} onClick={() => onOpen("demo")} title="Open the Sallen-Key demo">
          Demo
        </button>
      </div>
      <div className="actions">
        <button type="button" disabled={!undo} title={undo ? `Undo ${undo} (Ctrl+Z)` : "Nothing to undo"} onClick={() => store.getState().undo()}>
          Undo
        </button>
        <button type="button" disabled={!redo} title={redo ? `Redo ${redo} (Ctrl+Y)` : "Nothing to redo"} onClick={() => store.getState().redo()}>
          Redo
        </button>
      </div>
      <div className="actions">
        <button type="button" aria-pressed={overlays.voltage} onClick={() => ui.getState().toggleOverlay("voltage")} title="Colour wires by voltage">
          Voltages
        </button>
        <button type="button" aria-pressed={overlays.current} onClick={() => ui.getState().toggleOverlay("current")} title="Animate current flow">
          Currents
        </button>
      </div>
      {lastError ? <span className="notice">{lastError.message}</span> : toolHint && <span className="tool-hint">{toolHint}</span>}
      <span className={ok ? "sim-status" : "sim-status bad"} title={sim.message ?? sim.result?.log.split("\n").slice(-3).join("\n")}>
        {issues > 0 && (
          <button type="button" className="erc-badge" onClick={() => store.getState().select(null)} title="Show the circuit checks">
            {issues} check{issues === 1 ? "" : "s"}
          </button>
        )}
        <span className="dot" data-status={sim.status} />
        {SIM_TEXT[sim.status] ?? sim.status}
        {sim.result && sim.status === "ok" ? ` · ${sim.result.ms.toFixed(0)} ms` : ""}
      </span>
    </header>
  );
}
