// The lesson track (LLD §4, §11): what the tutor said about this circuit, block by block, with the
// notes on repairs and standard designs. A running job's narration appears as it streams. Text is
// rendered as plain text, never as HTML (LLD §14).
import { useEffect, useRef } from "react";
import { useCircuit, useEditor, useGen } from "./editorContext.ts";

interface Line {
  key: string;
  block: string | null;
  kind: "narration" | "note" | "repair";
  text: string;
}

export function LessonPanel() {
  const { store } = useEditor();
  const lesson = useGen((s) => s.lesson);
  const live = useGen((s) => (s.phase === "running" || s.phase === "starting" ? s.narration : null));
  const speaking = useGen((s) => s.speaking);
  const blocks = useCircuit((s) => s.blocks);
  const end = useRef<HTMLDivElement>(null);

  const lines: Line[] = [
    ...lesson.map((e) => ({ key: `s${e.seq}`, block: e.block ?? null, kind: e.kind, text: e.text })),
    ...(live ?? []).map((n, i) => ({ key: `l${i}`, block: n.block, kind: "narration" as const, text: n.text.trim() })),
  ];
  const count = lines.length;
  const lastText = lines.at(-1)?.text;

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [count, lastText]);

  if (!count) return null;
  return (
    <section className="lesson" aria-label="Lesson">
      <h3>Lesson</h3>
      <ol>
        {lines.map((l) => (
          <li key={l.key} data-kind={l.kind} className={l.block && l.block === speaking && live ? "speaking" : undefined}>
            {l.block && blocks[l.block] && (
              <button type="button" className="link block-ref" onClick={() => store.getState().select({ kind: "block", id: l.block! })}>
                {blocks[l.block]!.title}
              </button>
            )}
            <span className="text">{l.text}</span>
          </li>
        ))}
      </ol>
      <div ref={end} />
    </section>
  );
}
