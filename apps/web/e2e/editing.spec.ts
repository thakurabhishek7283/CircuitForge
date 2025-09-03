// The editing flows (LLD §10, §16 Phase 1) in a real browser, on the production bundle.
import { expect, test } from "@playwright/test";
import { EditorPage } from "./editor.ts";

test.describe("building a circuit", () => {
  test("an RC low-pass from nothing: place, wire, ground, simulate, edit a value", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    expect(await ed.parts()).toEqual(["C1", "R1", "V1"]);
    await expect(page.locator(".erc-badge")).toHaveCount(0); // nothing floating, nothing dangling
    await expect(page.locator('g.net[data-net="N1"]')).toBeAttached();
    await expect(page.locator('g.flag[data-net="GND"]')).toHaveCount(2);

    await ed.select("R1");
    const field = page.locator("#v-R1-resistance");
    await field.fill("4k7");
    await expect(page.locator(".field .parsed").first()).toHaveText("= 4.7kΩ");
    await field.press("Enter");
    await expect(page.locator('g.part[data-refdes="R1"] .value')).toHaveText("4.7kΩ");
    await field.fill("4.7 lots");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await field.press("Escape");
    await expect(field).toHaveValue("4.7kΩ");
    await ed.simulated();
  });

  test("every gesture is one undo step, and redo replays them", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    expect(await ed.undoLabel()).toBe("Undo Wire C1.2 to GND (Ctrl+Z)");
    // 3 places + 2 wires + 2 grounds
    for (let i = 0; i < 7; i++) await page.keyboard.press("Control+z");
    await ed.settled();
    expect(await ed.parts()).toEqual([]);
    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
    for (let i = 0; i < 7; i++) await page.keyboard.press("Control+y");
    await ed.settled();
    expect(await ed.parts()).toEqual(["C1", "R1", "V1"]);
    await expect(page.locator('g.flag[data-net="GND"]')).toHaveCount(2);
    await ed.simulated();
  });

  test("a refused wire is explained and changes nothing", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    const rev = await page.locator(".schematic-wrap").getAttribute("data-rev");
    await ed.wire("R1.1", "V1.P");
    await expect(page.locator(".notice")).toContainText("already connected");
    await expect(page.locator(".schematic-wrap")).toHaveAttribute("data-rev", rev!);
  });

  test("deleting a part or a net, with the keyboard; checks report what is left dangling", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    await ed.select("C1");
    await page.keyboard.press("Delete");
    await ed.settled();
    expect(await ed.parts()).toEqual(["R1", "V1"]);
    await expect(page.locator(".erc-badge")).toBeVisible(); // N2 is left with R1.2 alone
    await page.locator(".erc-badge").click();
    await expect(page.locator('.erc li[data-code="dangling_net"]').first()).toContainText("N2");

    await ed.clickAt(await ed.net("N1"));
    await expect(page.locator(".inspector h2")).toHaveText("N1");
    await page.keyboard.press("Delete");
    await ed.settled();
    await expect(page.locator('g.net[data-net="N1"]')).toHaveCount(0);
  });

  test("dragging pins a part where it is dropped; auto-place hands it back", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    const before = await ed.part("C1");
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x + 60, before.y + 40, { steps: 6 });
    await page.mouse.move(before.x + 120, before.y + 80, { steps: 6 });
    await page.mouse.up();
    await ed.settled();
    expect(await ed.undoLabel()).toBe("Undo Move C1 (Ctrl+Z)");
    const after = await ed.part("C1");
    expect(after.x - before.x).toBeGreaterThan(60);
    expect(after.y - before.y).toBeGreaterThan(40);
    await expect(page.locator(".inspector h2")).toHaveText("C1"); // the drop did not deselect it
    // still wired: N2 reaches the moved part
    await expect(page.locator('g.net[data-net="N2"] polyline.wire').first()).toBeAttached();

    await page.getByRole("button", { name: "Auto-place" }).click();
    await ed.settled();
    expect(await ed.undoLabel()).toBe("Undo Auto-place C1 (Ctrl+Z)");
    await expect(page.getByRole("button", { name: "Auto-place" })).toHaveCount(0);
  });

  test("an op-amp the user places shows both units; rails are made on first use", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.place("opamp_tl072", "U1");
    await expect(page.locator('g.part[data-refdes="U1"]')).toHaveCount(2);
    await page.getByLabel("Rail name").fill("VCC");
    await page.getByLabel("Rail voltage").fill("12");
    await page.getByRole("button", { name: "Rail", exact: true }).click();
    await ed.clickAt(await ed.pin("U1.VCC"));
    await ed.settled();
    await page.keyboard.press("Escape");
    await expect(page.locator('g.flag[data-net="VCC"]').first()).toContainText("VCC");
    await expect(page.getByRole("button", { name: "VCC +12 V" })).toBeVisible();
    // Unit B's pins are there to wire.
    await ed.tool("w");
    await expect(page.locator('.pin-targets circle[data-pin="U1.OUT_B"]')).toBeAttached();
  });
});

test.describe("scope and overlays", () => {
  test("probes a net, follows the selection, and runs an AC sweep on request", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    await expect(page.locator(".scope .hint")).toBeVisible();
    await ed.clickAt(await ed.net("N1"));
    await page.getByRole("button", { name: "Probe" }).click();
    await ed.clickAt(await ed.net("N2"));
    await expect(page.locator(".scope .u-legend")).toContainText("V(N1)");
    await expect(page.locator(".scope .u-legend")).toContainText("V(N2)");
    await expect(page.locator(".scope-cursor")).toBeAttached();

    await page.getByRole("tab", { name: "AC sweep" }).click();
    await expect(page.locator(".scope .hint")).toContainText("No AC sweep yet");
    await page.getByRole("button", { name: "Run AC sweep" }).click();
    await ed.simulated();
    await expect(page.locator(".scope .u-legend")).toContainText("|V(N2)|");
    expect(await ed.undoLabel()).toBe("Undo Run AC sweep (Ctrl+Z)");
  });

  test("current dots and voltage colours animate without re-rendering React", async ({ page }) => {
    // Count React commits through the DevTools hook, which React also calls in production builds.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__commits = 0;
      w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onCommitFiberRoot: () => void ((w.__commits as number)++),
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        checkDCE: () => {},
      };
    });
    const ed = new EditorPage(page);
    await ed.open("demo");
    await page.waitForTimeout(500);
    const frame = () => page.locator("canvas.overlay").evaluate((c) => (c as HTMLCanvasElement).toDataURL());
    const commits = () => page.evaluate(() => (window as unknown as { __commits: number }).__commits);
    const c0 = await commits();
    expect(c0).toBeGreaterThan(0); // the hook is live
    const f0 = await frame();
    await page.waitForTimeout(700);
    const f1 = await frame();
    expect(f1).not.toBe(f0); // the overlay moved
    expect(await commits()).toBe(c0); // and React did nothing

    await page.getByRole("button", { name: "Currents" }).click();
    await page.getByRole("button", { name: "Voltages" }).click();
    await page.waitForTimeout(100);
    const blank = await frame();
    await page.waitForTimeout(300);
    expect(await frame()).toBe(blank); // both off: nothing drawn, nothing moving
  });
});
