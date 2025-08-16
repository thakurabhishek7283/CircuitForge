// Re-layout after edits (LLD §10: op → core → store patch → layout). Only topology and pinned
// placements matter, so a value edit never triggers a layout; the newest request wins.
import { toLayoutInput } from "../workers/layoutClient.ts";
import type { Layout, LayoutInput } from "../workers/layout.types.ts";
import type { CircuitStore } from "./circuitStore.ts";

export type LayoutFn = (input: LayoutInput) => Promise<Layout | null>;

export function attachLayout(store: CircuitStore, layout: LayoutFn, onError: (e: unknown) => void = console.error): () => void {
  let lastKey = "";
  let latest = 0;
  const update = () => {
    const input = toLayoutInput(store.getState());
    const key = JSON.stringify(input);
    if (key === lastKey) return;
    lastKey = key;
    const ticket = ++latest;
    layout(input).then((l) => {
      if (l && ticket === latest) store.getState().setLayout(l);
    }, onError);
  };
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.parts !== prev.parts || s.nets !== prev.nets || s.blocks !== prev.blocks) update();
  });
  update();
  return unsubscribe;
}
