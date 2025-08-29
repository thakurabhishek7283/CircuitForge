import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { CircuitState } from "../store/circuitStore.ts";
import type { UiState } from "../store/uiStore.ts";
import type { Editor } from "./editor.ts";

export type EditorContextValue = Omit<Editor, "dispose">;

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
