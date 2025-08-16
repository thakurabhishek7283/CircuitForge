import { createContext, useContext } from "react";
import { useStore } from "zustand";
import type { Registry } from "../gen/contract.ts";
import type { CircuitState, CircuitStore } from "../store/circuitStore.ts";

export interface EditorContextValue {
  store: CircuitStore;
  registry: Registry;
  /** The registry's symbol sprite sheet (sanitized by the core at bundle time). */
  sprite: string;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside <EditorContext>");
  return ctx;
}

export function useCircuit<T>(selector: (s: CircuitState) => T): T {
  return useStore(useEditor().store, selector);
}
