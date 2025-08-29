// Re-layout after edits (LLD §10: op → core → store patch → layout). Only topology and pinned
// placements matter, so a value edit never triggers a layout; the newest request wins.
import { toLayoutInput } from "../workers/layoutClient.ts";
import type { Layout, LayoutInput } from "../workers/layout.types.ts";
import type { CircuitStore } from "./circuitStore.ts";

export type LayoutFn = (input: LayoutInput) => Promise<Layout | null>;

export function attachLayout(store: CircuitStore, layout: LayoutFn, onError: (e: unknown) => void = console.error): () => void {
  let lastKey = "";
  let latest = 0;
  let inFlight = false;
  const update = () => {
    const state = store.getState();
    const input = toLayoutInput(state);
    const key = JSON.stringify(input);
    if (key === lastKey) {
      // Same topology: the current layout (or the one on its way) already shows this rev.
      if (!inFlight && state.layoutRev !== state.rev) state.setLayout(state.layout, state.rev);
      return;
    }
    lastKey = key;
    const ticket = ++latest;
    inFlight = true;
    layout(input).then(
      (l) => {
        if (ticket !== latest) return;
        inFlight = false;
        // Any topology change since would have taken a newer ticket, so this is current.
        if (l) store.getState().setLayout(l, store.getState().rev);
      },
      (e: unknown) => {
        if (ticket === latest) inFlight = false;
        onError(e);
      },
    );
  };
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.rev !== prev.rev || s.parts !== prev.parts || s.nets !== prev.nets || s.blocks !== prev.blocks) update();
  });
  update();
  return unsubscribe;
}
