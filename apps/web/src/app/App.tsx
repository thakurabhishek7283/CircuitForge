import { useEffect, useState } from "react";
// The demo circuit is circuit-core's own fixture (refreshed with UPDATE_FIXTURES=1 cargo test).
import demoSnapshot from "../../../../crates/circuit-core/tests/fixtures/demo_sallen_key.json?raw";
import { ApiClient, ApiFailure, isOffline, localTokenStore } from "../api/client.ts";
import { API_URL } from "../config.ts";
import type { Circuit, ProjectSnapshot } from "../gen/contract.ts";
import { indexedDbPendingStore } from "../store/pending.ts";
import { Schematic, SymbolDefs } from "../views/schematic/Schematic.tsx";
import { Scope } from "../views/scope/Scope.tsx";
import { bindShortcuts } from "./commands.ts";
import { type Editor, openEditor } from "./editor.ts";
import { EditorContext, type EditorContextValue, useCircuit, useEditor, useGen, useProject, useUi } from "./editorContext.ts";
import { GeneratePanel } from "./GeneratePanel.tsx";
import { Inspector } from "./Inspector.tsx";
import { LessonPanel } from "./LessonPanel.tsx";
import { Palette } from "./Palette.tsx";
import { type ProjectSession, openProject } from "./project.ts";

/** An empty circuit on the demo's registry version. */
function emptySnapshot(): string {
  const { registry_version } = JSON.parse(demoSnapshot) as Circuit;
  const empty: Circuit = { schema_version: 1, registry_version, rev: 0, parts: {}, nets: {}, blocks: {}, analyses: [], hints: [] };
  return JSON.stringify(empty);
}

/** `#demo`: the demo circuit, in this browser only. `#new`: a new project. `#p/<id>`: a project.
 * No hash: the last project opened here, or a new one. */
type Route = { kind: "home" } | { kind: "demo" } | { kind: "new" } | { kind: "project"; id: string };

function parseRoute(hash: string): Route {
  if (hash === "#demo") return { kind: "demo" };
  if (hash === "#new") return { kind: "new" };
  const m = /^#p\/([0-9a-fA-F-]{36})$/.exec(hash);
  return m ? { kind: "project", id: m[1]! } : { kind: "home" };
}

const api = new ApiClient({ base: API_URL, tokens: localTokenStore() });
const pending = indexedDbPendingStore();
const LAST_PROJECT = "circuit-forge.project";

function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

function rememberProject(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    // not remembered: the next visit starts a new project
  }
}

const OFFLINE =
  "The server cannot be reached: you can build and simulate here, but this circuit is not saved and generation is off.";

type Resolved = { kind: "local"; snapshot: string; notice: string | null } | { kind: "project"; snapshot: ProjectSnapshot; notice: string | null };

/** What a route opens, from the server when it answers. */
async function resolve(route: Route): Promise<Resolved> {
  if (route.kind === "demo") return { kind: "local", snapshot: demoSnapshot, notice: null };
  try {
    let notice: string | null = null;
    const id = route.kind === "project" ? route.id : route.kind === "home" ? lastProject() : null;
    if (id) {
      try {
        return { kind: "project", snapshot: await api.getProject(id), notice };
      } catch (e) {
        if (!(e instanceof ApiFailure && (e.status === 404 || e.status === 401))) throw e;
        if (route.kind === "project") notice = "That project could not be opened here (it belongs to another browser, or was deleted), so this is a new one.";
      }
    }
    const project = await api.createProject();
    return { kind: "project", snapshot: await api.getProject(project.id), notice };
  } catch (e) {
    if (isOffline(e)) return { kind: "local", snapshot: emptySnapshot(), notice: OFFLINE };
    throw e;
  }
}

// One resolution per visit: React StrictMode runs the opening effect twice in development, and a
// second run must not create a second project.
const resolving = new Map<string, Promise<Resolved>>();

interface Opened {
  editor: Editor;
  project: ProjectSession | null;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [visit, setVisit] = useState(0);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let editor: Editor | null = null;
    let project: ProjectSession | null = null;
    setOpened(null);
    const key = `${visit} ${JSON.stringify(route)}`;
    let resolved = resolving.get(key);
    if (!resolved) resolving.set(key, (resolved = resolve(route)));
    (async () => {
      const r = await resolved;
      if (cancelled) return;
      editor = await openEditor(r.kind === "project" ? JSON.stringify(r.snapshot.circuit) : r.snapshot);
      if (cancelled) return editor.dispose();
      if (r.kind === "project") {
        const id = r.snapshot.project.id;
        rememberProject(id);
        if (location.hash !== `#p/${id}`) history.replaceState(null, "", `#p/${id}`);
        project = await openProject({
          api,
          store: editor.store,
          gen: editor.gen,
          snapshot: r.snapshot,
          pending,
          reload: (why) => {
            setNotice(why);
            setVisit((v) => v + 1);
          },
          notify: setNotice,
        });
        if (cancelled) {
          project.dispose();
          return editor.dispose();
        }
      }
      if (r.notice) setNotice(r.notice);
      setOpened({ editor, project });
      // Dev builds only: drive the editor from the console.
      if (import.meta.env.DEV) Object.assign(window, { circuitForge: { ...editor, project } });
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      project?.dispose();
      editor?.dispose();
    };
  }, [route, visit]);

  useEffect(() => (opened ? bindShortcuts(opened.editor) : undefined), [opened]);

  // Links to #new, #demo or a project open it without a reload.
  useEffect(() => {
    const onHash = () => {
      setNotice(null);
      setRoute(parseRoute(location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (error) return <div className="splash error">Could not open the circuit: {error}</div>;
  if (!opened) return <div className="splash">Loading…</div>;
  const ctx: EditorContextValue = { ...opened.editor, project: opened.project };
  return (
    <EditorContext.Provider value={ctx}>
      <SymbolDefs sprite={opened.editor.sprite} />
      <div className="app">
        <Toolbar demo={route.kind === "demo"} onRetryServer={() => setVisit((v) => v + 1)} />
        {notice && (
          <div className="banner" role="status">
            <span>{notice}</span>
            <button type="button" className="link" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        <main>
          <Palette />
          <div className="center">
            <GeneratePanel />
            <Schematic />
            <Scope />
          </div>
          <div className="side">
            <Inspector />
            <LessonPanel />
          </div>
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

/** Where this circuit is saved: the server's op log, or nowhere (the demo, or offline). */
function SaveStatus({ demo, onRetryServer }: { demo: boolean; onRetryServer: () => void }) {
  const sync = useProject((s) => s.sync);
  if (!sync) {
    return demo ? (
      <span className="save-status" title="The demo is not saved; New starts a saved project">
        Demo, not saved
      </span>
    ) : (
      <span className="save-status bad">
        Not saved{" "}
        <button type="button" className="link" onClick={onRetryServer}>
          Reconnect
        </button>
      </span>
    );
  }
  const text = {
    saved: "Saved",
    saving: "Saving…",
    offline: `Offline · ${sync.unsent} unsaved`,
    stale: "Reloading…",
  }[sync.state];
  return (
    <span className={sync.state === "offline" ? "save-status bad" : "save-status"} data-state={sync.state}>
      {text}
    </span>
  );
}

function Toolbar({ demo, onRetryServer }: { demo: boolean; onRetryServer: () => void }) {
  const { store, ui } = useEditor();
  const undo = useCircuit((s) => s.history.undo.at(-1)?.label);
  const redo = useCircuit((s) => s.history.redo.at(-1)?.label);
  const sim = useCircuit((s) => s.sim);
  const lastError = useCircuit((s) => s.lastError);
  const generating = useCircuit((s) => s.mode === "generating");
  const phase = useGen((s) => s.phase);
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
  const busy = generating || phase === "starting";
  return (
    <header className="toolbar">
      <h1>Circuit Forge</h1>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => (location.hash = "#new")} title="Start a new circuit">
          New
        </button>
        <button type="button" disabled={busy} aria-pressed={demo} onClick={() => (location.hash = "#demo")} title="Open the Sallen-Key demo">
          Demo
        </button>
        <SaveStatus demo={demo} onRetryServer={onRetryServer} />
      </div>
      <div className="actions">
        <button type="button" disabled={!undo || generating} title={undo ? `Undo ${undo} (Ctrl+Z)` : "Nothing to undo"} onClick={() => store.getState().undo()}>
          Undo
        </button>
        <button type="button" disabled={!redo || generating} title={redo ? `Redo ${redo} (Ctrl+Y)` : "Nothing to redo"} onClick={() => store.getState().redo()}>
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
