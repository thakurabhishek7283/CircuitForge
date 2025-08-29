// Editor commands shared by buttons and keyboard shortcuts.
import { toRot } from "../workers/layout.geometry.ts";
import type { EditorContextValue } from "./editorContext.ts";

/** Turn a part 90° clockwise where it is drawn; this pins it there. */
export function rotatePart({ store, edits }: EditorContextValue, refdes: string): void {
  const sym = Object.values(store.getState().layout?.symbols ?? {}).find((s) => s.refdes === refdes);
  if (sym) edits.pin(refdes, { x: sym.x, y: sym.y, rot: toRot(sym.rot + 90), flip: sym.flip }, `Rotate ${refdes}`);
}

/** Keyboard shortcuts; returns a function that removes them. */
export function bindShortcuts(editor: EditorContextValue): () => void {
  const { store, ui, edits } = editor;
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]")) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const s = store.getState();
    const tool = ui.getState().tool;
    if (mod && key === "z" && !e.shiftKey) s.undo();
    else if (mod && (key === "y" || (key === "z" && e.shiftKey))) s.redo();
    else if (mod || e.altKey) return;
    else if (key === "escape") {
      if (tool.kind === "wire" && tool.from) ui.getState().setTool({ kind: "wire", from: null });
      else if (tool.kind !== "select") ui.getState().setTool({ kind: "select" });
      else s.select(null);
    } else if (key === "delete" || key === "backspace") {
      if (s.selection) edits.remove(s.selection);
    } else if (key === "w") ui.getState().setTool({ kind: "wire", from: null });
    else if (key === "v") ui.getState().setTool({ kind: "select" });
    else if (key === "g") ui.getState().setTool({ kind: "rail", net: "GND", netKind: { kind: "ground" } });
    else if (key === "r" && s.selection?.kind === "part") rotatePart(editor, s.selection.refdes);
    else return;
    e.preventDefault();
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
