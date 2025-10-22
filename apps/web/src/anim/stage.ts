// The AnimationDirector's stage in the browser: the Web Animations API on the schematic's SVG.
// Items waiting for their turn are hidden by one constructable stylesheet (its rules name them by
// their data attributes), so React renders the drawing as usual and nothing re-renders as they
// appear. While anything is hidden or animating the wrapper has `data-revealing`, which hides the
// simulation overlays: their halos and dots would otherwise give away wires not yet drawn. (Data
// attributes, not classes: React owns the class names and would overwrite them.)
import type { RevealItem, Stage } from "./director.ts";

export const PART_MS = 300;
export const WIRE_MS = 400;
export const FRAME_MS = 250;

const q = (v: string) => `"${CSS.escape(v)}"`;

function selectors(item: RevealItem): string[] {
  switch (item.kind) {
    case "part":
      // The part's units, and the power and ground flags on its pins.
      return [`g.part[data-refdes=${q(item.refdes)}]`, `g.flag[data-pin^=${q(`${item.refdes}.`)}]`];
    case "net":
      return [`g.net[data-net=${q(item.id)}]`, `text.volt[data-net=${q(item.id)}]`];
    case "block":
      return [`g.block[data-block=${q(item.id)}]`];
  }
}

export class DomStage implements Stage {
  private readonly root: HTMLElement;
  private readonly sheet = new CSSStyleSheet();
  private readonly hidden = new Set<string>();
  private readonly running = new Set<Animation>();
  private speed = 1;
  private paused = false;

  constructor(root: HTMLElement) {
    this.root = root;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
  }

  dispose(): void {
    this.revealAll();
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.sheet);
  }

  hide(items: RevealItem[]): void {
    for (const item of items) for (const sel of selectors(item)) this.hidden.add(sel);
    this.update();
  }

  async reveal(item: RevealItem): Promise<void> {
    const sels = selectors(item);
    for (const sel of sels) this.hidden.delete(sel);
    this.update();
    const els = sels.flatMap((sel) => [...this.root.querySelectorAll<SVGGraphicsElement>(sel)]);
    const anims: Animation[] = [];
    if (item.kind === "part") {
      for (const el of els) {
        const grow = el.matches("g.part");
        anims.push(
          this.play(
            el,
            grow
              ? [
                  { opacity: 0, transform: "scale(0.4)" },
                  { opacity: 1, transform: "scale(1.06)", offset: 0.7 },
                  { opacity: 1, transform: "scale(1)" },
                ]
              : [{ opacity: 0 }, { opacity: 1 }],
            PART_MS,
          ),
        );
      }
    } else if (item.kind === "net") {
      for (const el of els) {
        for (const wire of el.querySelectorAll<SVGPolylineElement>("polyline.wire")) {
          const len = Math.max(1, wire.getTotalLength());
          const dash = `${len} ${len}`;
          anims.push(this.play(wire, [{ strokeDasharray: dash, strokeDashoffset: len }, { strokeDasharray: dash, strokeDashoffset: 0 }], WIRE_MS));
        }
        for (const dot of el.querySelectorAll(".junction, text")) {
          anims.push(this.play(dot, [{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }], WIRE_MS));
        }
      }
    } else {
      for (const el of els) anims.push(this.play(el, [{ opacity: 0 }, { opacity: 1 }], FRAME_MS));
    }
    await Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
  }

  revealAll(): void {
    this.hidden.clear();
    for (const a of [...this.running]) a.finish();
    this.running.clear();
    this.update();
  }

  building(block: string, on: boolean): void {
    for (const el of this.root.querySelectorAll(`g.block[data-block=${q(block)}]`)) el.toggleAttribute("data-building", on);
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    for (const a of this.running) a.updatePlaybackRate(speed);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    for (const a of this.running) {
      if (paused) a.pause();
      else a.play();
    }
  }

  private play(el: Element, frames: Keyframe[], ms: number): Animation {
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const a = el.animate(frames, { duration: reduce ? 0 : ms, easing: "ease-out" });
    a.updatePlaybackRate(this.speed);
    if (this.paused) a.pause();
    this.running.add(a);
    const done = () => this.running.delete(a);
    a.finished.then(done, done);
    return a;
  }

  private update(): void {
    this.sheet.replaceSync([...this.hidden].map((sel) => `${sel} { visibility: hidden; }`).join("\n"));
    this.root.toggleAttribute("data-revealing", this.hidden.size > 0 || this.running.size > 0);
  }
}
