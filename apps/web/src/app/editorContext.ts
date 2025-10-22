import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { CircuitState } from "../store/circuitStore.ts";
import type { UiState } from "../store/uiStore.ts";
import type { GenerationState } from "../store/generationStore.ts";
import type { Editor } from "./editor.ts";
import type { ProjectSession, ProjectState } from "./project.ts";

export type EditorContextValue = Omit<Editor, "dispose"> & {
  /** The server project this circuit is, or null (the demo, or the server cannot be reached). */
  project?: ProjectSession | null;
};

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside <EditorContext>");
  return ctx;
}

export function useCircuit<T>(selector: (s: CircuitState) => T): T {
  return useStore(useEditor().store, selector);
}

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(useEditor().ui, selector);
}

export function useGen<T>(selector: (s: GenerationState) => T): T {
  return useStore(useEditor().gen, selector);
}

const NO_PROJECT = { getState: () => null, subscribe: () => () => {} };

/** The open project's state (sync status, title), or null for a local circuit. */
export function useProject<T>(selector: (s: ProjectState) => T): T | null {
  const project = useEditor().project;
  return useStore((project?.state ?? NO_PROJECT) as never, (s: ProjectState | null) => (s ? selector(s) : null));
}
