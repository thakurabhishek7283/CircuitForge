// Editor UI state that is not part of the circuit: the active tool, scope probes and overlay
// switches. Kept apart from the circuit store, which mirrors the core.
import { createStore, type StoreApi } from "zustand/vanilla";
import type { NetKind } from "../gen/contract.ts";

export type Tool =
  | { kind: "select" }
  /** `from`: the pin the wire starts at, once the first click picked it. */
  | { kind: "wire"; from: string | null }
  /** Click pins to put them on a supply rail (created on first use). */
  | { kind: "rail"; net: string; netKind: NetKind };

export type Probe = { kind: "net"; id: string } | { kind: "pin"; ref: string };

export type ScopeTab = "tran" | "ac";

export interface UiState {
  tool: Tool;
  probes: Probe[];
  overlays: { voltage: boolean; current: boolean };
  scope: { open: boolean; tab: ScopeTab };
  setTool(tool: Tool): void;
  addProbe(p: Probe): void;
  removeProbe(p: Probe): void;
  toggleOverlay(which: "voltage" | "current"): void;
  setScope(scope: Partial<UiState["scope"]>): void;
}

export type UiStore = StoreApi<UiState>;

export const sameProbe = (a: Probe, b: Probe): boolean =>
  a.kind === b.kind && (a.kind === "net" ? a.id === (b as typeof a).id : a.ref === (b as typeof a).ref);

/** At most this many probes, one colour each. */
export const MAX_PROBES = 6;

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    tool: { kind: "select" },
    probes: [],
    overlays: { voltage: true, current: true },
    scope: { open: true, tab: "tran" },
    setTool: (tool) => set({ tool }),
    addProbe: (p) =>
      set((s) => (s.probes.some((q) => sameProbe(p, q)) ? s : { probes: [...s.probes, p].slice(-MAX_PROBES) })),
    removeProbe: (p) => set((s) => ({ probes: s.probes.filter((q) => !sameProbe(p, q)) })),
    toggleOverlay: (which) => set((s) => ({ overlays: { ...s.overlays, [which]: !s.overlays[which] } })),
    setScope: (scope) => set((s) => ({ scope: { ...s.scope, ...scope } })),
  }));
}
