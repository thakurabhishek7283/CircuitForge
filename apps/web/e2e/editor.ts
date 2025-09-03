// Driving the editor the way a user does: clicks on pins, parts and wires at their screen
// positions, read back from the drawn SVG.
import { expect, type Page } from "@playwright/test";

export interface Point {
  x: number;
  y: number;
}

export class EditorPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async open(start: "new" | "demo"): Promise<void> {
    await this.page.goto(start === "new" ? "/#new" : "/");
    await expect(this.page.locator(".palette")).toBeVisible();
    if (start === "demo") await this.simulated();
  }

  /** Wait for a successful simulation of the current circuit. */
  async simulated(): Promise<void> {
    await expect(this.page.locator(".sim-status .dot")).toHaveAttribute("data-status", "ok");
  }

  async place(part: string, refdes: string): Promise<void> {
    await this.page.click(`button[data-part="${part}"]`);
    await expect(this.page.locator(`g.part[data-refdes="${refdes}"]`).first()).toBeVisible();
    await this.settled();
  }

  /** Layout runs in a worker: wait until the drawing shows the circuit's current rev. */
  async settled(): Promise<void> {
    await expect
      .poll(() => this.page.locator(".schematic-wrap").evaluate((el) => (el as HTMLElement).dataset.rev === (el as HTMLElement).dataset.layoutRev))
      .toBe(true);
  }

  async pin(ref: string): Promise<Point> {
    const target = this.page.locator(`.pin-targets circle[data-pin="${ref}"]`).first();
    await expect(target).toBeAttached();
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async part(refdes: string): Promise<Point> {
    const box = (await this.page.locator(`g.part[data-refdes="${refdes}"] use`).first().boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** The middle of a net's longest drawn segment. */
  async net(id: string): Promise<Point> {
    return this.page.evaluate((id) => {
      const pl = document.querySelector<SVGPolylineElement>(`g.net[data-net="${id}"] polyline.wire`)!;
      let best = { x: 0, y: 0 };
      let len = -1;
      for (let i = 1; i < pl.points.numberOfItems; i++) {
        const a = pl.points.getItem(i - 1);
        const b = pl.points.getItem(i);
        const l = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (l > len) {
          len = l;
          best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
      }
      const m = pl.getScreenCTM()!;
      return { x: m.a * best.x + m.c * best.y + m.e, y: m.b * best.x + m.d * best.y + m.f };
    }, id);
  }

  async clickAt(p: Point): Promise<void> {
    await this.page.mouse.move(p.x, p.y, { steps: 3 });
    await this.page.mouse.click(p.x, p.y);
  }

  /** Wire tool: from a pin to a pin. */
  async wire(from: string, to: string): Promise<void> {
    await this.tool("w");
    await this.clickAt(await this.pin(from));
    await this.clickAt(await this.pin(to));
    await this.settled();
  }

  /** Put pins on ground with the ground tool. */
  async ground(...pins: string[]): Promise<void> {
    await this.tool("g");
    for (const p of pins) {
      await this.clickAt(await this.pin(p));
      await this.settled();
    }
    await this.tool("v");
  }

  async tool(key: "w" | "g" | "v"): Promise<void> {
    await this.page.locator(".schematic").hover({ position: { x: 5, y: 5 } });
    await this.page.keyboard.press(key);
  }

  async select(refdes: string): Promise<void> {
    await this.tool("v");
    await this.clickAt(await this.part(refdes));
    await expect(this.page.locator(".inspector h2")).toHaveText(refdes);
  }

  async undoLabel(): Promise<string | null> {
    return this.page.getByRole("button", { name: "Undo" }).getAttribute("title");
  }

  /** Refdes of every drawn part. */
  async parts(): Promise<string[]> {
    const all = await this.page.locator("g.part").evaluateAll((gs) => gs.map((g) => (g as SVGGElement).dataset.refdes!));
    return [...new Set(all)].sort();
  }

  /** The RC low-pass the tests build: V1 (1 V, 1 kHz) -> R1 -> C1 -> ground. */
  async buildRc(): Promise<void> {
    await this.place("vsource_sine", "V1");
    await this.place("resistor_th", "R1");
    await this.place("cap_film", "C1");
    await this.wire("V1.P", "R1.1");
    await this.wire("R1.2", "C1.1");
    await this.ground("V1.N", "C1.2");
    await this.simulated();
  }
}
