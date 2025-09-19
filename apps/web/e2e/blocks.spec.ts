// The Phase 1 gate (LLD §16): "students build and simulate an op-amp filter unaided", both ways a
// first-year student would: from a verified block, and part by part with rails as supplies.
import { expect, test } from "@playwright/test";
import { EditorPage } from "./editor.ts";

test.describe("op-amp filter, the Phase 1 gate", () => {
  test("from a block: say the cutoff, insert, drive it, read the checks and the Bode plot", async ({ page }) => {
    test.setTimeout(60_000);
    const ed = new EditorPage(page);
    await ed.open("new");
    await expect(page.locator(".inspector h2")).toHaveText("Start a circuit");

    await page.click('button[data-template="sallen_key_lp"]');
    const form = page.getByRole("form", { name: "Insert Sallen-Key low-pass (2nd order)" });
    await form.getByLabel("Cutoff frequency").fill("1M");
    await expect(form.getByRole("alert")).toContainText("Cutoff frequency must be 10Hz to 20kHz");
    await expect(form.getByRole("button", { name: "Insert block" })).toBeDisabled();
    await form.getByLabel("Cutoff frequency").fill("2k");
    await expect(form.getByLabel("Solved part values")).toContainText("R1");
    await form.getByRole("button", { name: "Insert block" }).click();
    await ed.settled();

    // One block, its rails made, and checks waiting for a signal.
    await expect(page.locator('g.block[data-block="b1"]')).toBeVisible();
    await expect(page.locator('g.flag[data-net="VCC"]').first()).toBeVisible();
    await expect(page.locator(".inspector h2")).toHaveText("Sallen-Key low-pass (2nd order)");
    await expect(page.locator(".inspector .notes")).toContainText("needs a signal");
    await expect(page.locator('tspan[data-check="fc_hz"]')).toHaveClass(/unknown/);
    expect(await ed.undoLabel()).toBe("Undo Insert Sallen-Key low-pass (2nd order) (Ctrl+Z)");

    // Drive its input with a sine source block, bound to the filter's input net.
    await page.click('button[data-template="sine_source"]');
    const src = page.getByRole("form", { name: "Insert Sine signal source" });
    await src.getByLabel("out").selectOption({ label: "B1_IN: Sallen-Key low-pass (2nd order) in" });
    await src.getByRole("button", { name: "Insert block" }).click();
    await ed.settled();
    await ed.simulated();

    // Checks pass, shown on the frame and in the inspector; the scope shows the response.
    await expect(page.locator('tspan[data-check="fc_hz"]')).toHaveClass(/pass/);
    await expect(page.locator('tspan[data-check="q"]')).toHaveClass(/pass/);
    await page.locator('g.block[data-block="b1"] text').click();
    await expect(page.locator('.checks tr[data-check="fc_hz"]')).toHaveAttribute("data-pass", "true");
    await expect(page.getByRole("tab", { name: "AC sweep" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".scope .u-legend")).toContainText("|V(B1_OUT)|");

    // Retuning a part moves the measurement out of tolerance: the badge says so.
    await ed.select("C1");
    await page.locator("#v-C1-capacitance").fill("100n");
    await page.locator("#v-C1-capacitance").press("Enter");
    await ed.simulated();
    await expect(page.locator('tspan[data-check="fc_hz"]')).toHaveClass(/fail/);
    await page.keyboard.press("Control+z");
    await ed.simulated();
    await expect(page.locator('tspan[data-check="fc_hz"]')).toHaveClass(/pass/);
  });

  test("part by part: an RC low-pass buffered by an op-amp, powered by its rails", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("new");
    await ed.buildRc();
    await ed.place("opamp_tl072", "U1");
    await ed.wire("C1.1", "U1.INP_A");
    await ed.wire("U1.OUT_A", "U1.INM_A");
    for (const [name, volts, pin] of [["VCC", "12", "U1.VCC"], ["VEE", "-12", "U1.VEE"]] as const) {
      await page.getByLabel("Rail name").fill(name);
      await page.getByLabel("Rail voltage").fill(volts);
      await page.getByRole("button", { name: "Rail", exact: true }).click();
      await ed.clickAt(await ed.pin(pin));
      await ed.settled();
      await page.keyboard.press("Escape");
    }
    // A DC offset on the source: the buffer's output follows it only if the rails power it.
    await ed.select("V1");
    await page.locator("#v-V1-offset").fill("1");
    await page.locator("#v-V1-offset").press("Enter");
    await ed.simulated();
    await ed.select("U1");
    await expect(page.locator('tr[data-pin="U1.OUT_A"] td.num').first()).toHaveText(/^(1|0\.99\d*|1\.00\d*) V$/);
    // The rails are supplies, so nothing lacks a DC path; only unit B, unused, is mentioned.
    await page.locator(".erc-badge").click();
    await expect(page.locator(".erc li")).toHaveCount(1);
    await expect(page.locator('.erc li[data-code="unused_unit"]')).toBeVisible();
  });

  test("the demo's template block shows its checks", async ({ page }) => {
    const ed = new EditorPage(page);
    await ed.open("demo");
    await expect(page.locator('g.block[data-block="b3"] tspan[data-check="fc_hz"]')).toHaveClass(/pass/);
    await expect(page.locator('g.block[data-block="b3"] tspan[data-check="q"]')).toHaveClass(/pass/);
  });
});
