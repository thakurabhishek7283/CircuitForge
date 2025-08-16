import { useEffect, useState } from "react";
// The demo circuit is circuit-core's own fixture (refreshed with UPDATE_FIXTURES=1 cargo test).
import demoSnapshot from "../../../../crates/circuit-core/tests/fixtures/demo_sallen_key.json?raw";
import { Schematic, SymbolDefs } from "../views/schematic/Schematic.tsx";
import { type Editor, openEditor } from "./editor.ts";
import { EditorContext, useCircuit, useEditor } from "./editorContext.ts";
import { Inspector } from "./Inspector.tsx";

export function App() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: Editor | null = null;
    openEditor(demoSnapshot).then(
      (e) => {
        if (cancelled) return e.dispose();
        opened = e;
        setEditor(e);
        // Dev builds only: drive the store from the console or a test (no edit tools yet).
        if (import.meta.env.DEV) Object.assign(window, { circuitForge: e });
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, []);

  if (error) return <div className="splash error">Could not open the circuit: {error}</div>;
  if (!editor) return <div className="splash">Loading…</div>;
  return (
    <EditorContext.Provider value={editor}>
      <SymbolDefs sprite={editor.sprite} />
      <div className="app">
        <Toolbar />
        <main>
          <Schematic />
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

function Toolbar() {
  const { store } = useEditor();
  const undo = useCircuit((s) => s.history.undo.at(-1)?.label);
  const redo = useCircuit((s) => s.history.redo.at(-1)?.label);
  const sim = useCircuit((s) => s.sim);
  const lastError = useCircuit((s) => s.lastError);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) store.getState().undo();
      else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) store.getState().redo();
      else if (e.key === "Escape") store.getState().select(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const ok = sim.status === "ok" || sim.status === "pending" || sim.status === "running" || sim.status === "idle";
  return (
    <header className="toolbar">
      <h1>Circuit Forge</h1>
      <div className="actions">
        <button type="button" disabled={!undo} title={undo ? `Undo ${undo} (Ctrl+Z)` : "Nothing to undo"} onClick={() => store.getState().undo()}>
          Undo
        </button>
        <button type="button" disabled={!redo} title={redo ? `Redo ${redo} (Ctrl+Y)` : "Nothing to redo"} onClick={() => store.getState().redo()}>
          Redo
        </button>
      </div>
      {lastError && <span className="notice">{lastError.message}</span>}
      <span className={ok ? "sim-status" : "sim-status bad"} title={sim.message ?? sim.result?.log.split("\n").slice(-3).join("\n")}>
        <span className="dot" data-status={sim.status} />
        {SIM_TEXT[sim.status] ?? sim.status}
        {sim.result && sim.status === "ok" ? ` · ${sim.result.ms.toFixed(0)} ms` : ""}
      </span>
    </header>
  );
}
