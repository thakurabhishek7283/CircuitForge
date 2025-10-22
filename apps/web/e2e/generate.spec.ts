// Generation against the real API (project `api`, see playwright.config.ts): jobs planned, composed,
// verified and committed by the orchestrator with scripted model replies (apps/api/fake/script.json;
// a word in each prompt picks its scenario), streamed over SSE and played by the AnimationDirector.
import { expect, type Page, test } from "@playwright/test";
import { EditorPage } from "./editor.ts";

declare global {
  interface Window {
    __seen: { ghosts: string[]; building: string[]; revealing: boolean };
  }
}

/** Record what flickers by too fast to poll for: ghosts, blocks being built, the reveal. */
async function watch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen = { ghosts: [] as string[], building: [] as string[], revealing: false };
    window.__seen = seen;
    new MutationObserver(() => {
      for (const g of document.querySelectorAll<SVGGElement>("g.ghost")) {
        const key = `${g.dataset.ghost}:${g.dataset.state}`;
        if (!seen.ghosts.includes(key)) seen.ghosts.push(key);
      }
      for (const b of document.querySelectorAll<SVGGElement>("g.block[data-building]")) {
        if (!seen.building.includes(b.dataset.block!)) seen.building.push(b.dataset.block!);
      }
      if (document.querySelector("[data-revealing]")) seen.revealing = true;
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
}

async function newProject(page: Page): Promise<string> {
  await page.goto("/#new");
  await expect(page).toHaveURL(/#p\/[0-9a-f-]{36}$/);
  await expect(page.locator(".save-status")).toHaveText("Saved");
  return page.url();
}

async function generate(page: Page, prompt: string, speed?: string): Promise<void> {
  await page.getByLabel("Describe a circuit").fill(prompt);
  await page.getByRole("button", { name: "Generate" }).click();
  if (speed) await page.locator(".progress .speed").getByRole("button", { name: speed }).click();
}

const progress = (page: Page) => page.locator(".progress");
const planItem = (page: Page, block: string) => page.locator(`.progress .plan li[data-block="${block}"]`);
const blocks = (page: Page) => page.locator("g.block").evaluateAll((gs) => gs.map((g) => (g as SVGGElement).dataset.block));

test("a generated circuit arrives block by block, then edits and saves like any other", async ({ page }) => {
  await watch(page);
  const editor = new EditorPage(page);
  const url = await newProject(page);
  await generate(page, "e2e-build a sine source into a 2 kHz low-pass filter, buffered");

  // Read-only while the job runs (LLD §4: single writer).
  await expect(progress(page)).toHaveAttribute("data-phase", "running");
  await expect(page.locator('button[data-part="resistor_th"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByLabel("Describe a circuit")).toBeDisabled();

  await expect(progress(page)).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
  await expect(progress(page).locator(".status")).toHaveText("Done: 3 block(s) added.");
  // The filter's first draft has a wrong pin; the second is right. (On failure, say what went wrong.)
  const repairs = await page.locator('.lesson li[data-kind="repair"]').allTextContents();
  await expect(planItem(page, "b2"), repairs.join(" | ")).toContainText("RC low-pass filter · 1 fix");
  expect(await blocks(page)).toEqual(["b1", "b2", "b3"]);
  const seen = await page.evaluate(() => window.__seen);
  expect(seen.ghosts.map((g) => g.split(":")[0])).toEqual(expect.arrayContaining(["b1", "b2", "b3"]));
  expect(seen.building).toEqual(["b1", "b2", "b3"]);
  expect(seen.revealing).toBe(true);
  await expect(page.locator("g.ghost")).toHaveCount(0);
  await expect(page.locator("[data-revealing]")).toHaveCount(0);

  // Spec badges, the lesson with its repair note, and a simulation of the whole circuit.
  await expect(page.locator('g.block[data-block="b2"] tspan[data-check="fc_hz"]')).toHaveClass(/pass/);
  await expect(page.locator('g.block[data-block="b3"] tspan[data-check="gain"]')).toHaveClass(/pass/);
  const lesson = page.locator(".lesson");
  await expect(lesson).toContainText("This circuit filters a test signal.");
  await expect(lesson.locator('li[data-kind="repair"]')).toContainText("C1 (cap_film) has no pin X");
  await expect(lesson).toContainText("U1 copies the filtered signal");
  await editor.simulated();

  // Unlocked: one undo removes the whole last block; edits sync to the project.
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toHaveAttribute("title", "Undo Generate Voltage follower (op-amp buffer) (Ctrl+Z)");
  await undo.click();
  await editor.settled();
  expect(await blocks(page)).toEqual(["b1", "b2"]);
  await editor.select("R1");
  await page.locator("#v-R1-resistance").fill("10k");
  await page.locator("#v-R1-resistance").press("Enter");
  await expect(page.locator(".save-status")).toHaveText("Saved");

  // The server has all of it.
  await page.goto("about:blank");
  await page.goto(url);
  await editor.settled();
  expect(await blocks(page)).toEqual(["b1", "b2"]);
  expect(await editor.parts()).toEqual(["C1", "R1", "V1"]);
  await expect(page.locator('g.part[data-refdes="R1"] .value')).toHaveText("10kΩ");
  await expect(page.locator(".lesson")).toContainText("R1 and C1 let low frequencies through");
});

test("cancel keeps the blocks already added and drops the rest", async ({ page }) => {
  await newProject(page);
  await generate(page, "e2e-cancel a sine source into a 2 kHz low-pass filter, buffered", "4×");
  // The filter's composer is held (60 s) once the source has been added.
  await expect(planItem(page, "b1")).toHaveAttribute("data-status", "committed", { timeout: 20_000 });
  await expect(page.locator('g.ghost[data-ghost="b2"]')).toHaveAttribute("data-state", "composing");
  await page.getByRole("button", { name: "Cancel" }).click();

  await expect(progress(page)).toHaveAttribute("data-phase", "cancelled");
  await expect(planItem(page, "b2")).toHaveAttribute("data-status", "discarded");
  await expect(page.locator("g.ghost")).toHaveCount(0);
  expect(await blocks(page)).toEqual(["b1"]);
  await expect(page.locator('button[data-part="resistor_th"]')).toBeEnabled();
  await expect(page.locator(".banner")).toHaveCount(0); // the cancel was accepted, nothing to report
});

test("a failure worth retrying offers Retry, which runs the request again", async ({ page }) => {
  await newProject(page);
  await generate(page, "e2e-retry a sine source into a 2 kHz low-pass filter, buffered");
  await expect(progress(page)).toHaveAttribute("data-phase", "failed");
  await expect(progress(page).locator(".status")).toHaveText("The model is not answering.");
  await expect(page.locator('button[data-part="resistor_th"]')).toBeEnabled(); // unlocked after a failure

  await progress(page).getByRole("button", { name: "Retry" }).click();
  await page.locator(".progress .speed").getByRole("button", { name: "4×" }).click();
  await expect(progress(page)).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
  expect(await blocks(page)).toEqual(["b1", "b2", "b3"]);
});

test("a request no block can build fails without a retry", async ({ page }) => {
  await newProject(page);
  await generate(page, "e2e-unsupported an Arduino thermometer");
  await expect(progress(page)).toHaveAttribute("data-phase", "failed");
  await expect(progress(page).locator(".status")).toHaveText("That needs something the block library cannot build yet.");
  await expect(progress(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(progress(page).locator(".error-detail")).toContainText("microcontroller");
});

test("a reload during a job stays read-only and catches up from the stream", async ({ page }) => {
  await newProject(page);
  await generate(page, "e2e-reload a sine source into a 2 kHz low-pass filter, buffered", "4×");
  // The filter's composer is held 4 s once the source has been added: reload in between.
  await expect(planItem(page, "b1")).toHaveAttribute("data-status", "committed", { timeout: 20_000 });
  await page.reload();

  await expect(progress(page)).toHaveAttribute("data-phase", "running");
  await expect(page.locator('button[data-part="resistor_th"]')).toBeDisabled();
  await expect(progress(page)).toHaveAttribute("data-phase", "done", { timeout: 20_000 });
  expect(await blocks(page)).toEqual(["b1", "b2", "b3"]);
  await expect(page.locator('button[data-part="resistor_th"]')).toBeEnabled();
  // The reload's snapshot held b1: it was not applied a second time (one undo step per block since).
  await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute("title", /Generate Voltage follower/);
});

test("edits made while the API is unreachable are kept and saved when it answers again", async ({ page }) => {
  const editor = new EditorPage(page);
  const url = await newProject(page);
  await page.route("**/v1/projects/*/ops", (route) => route.abort("connectionrefused"));
  await editor.place("resistor_th", "R1");
  await expect(page.locator(".save-status")).toHaveText("Offline · 1 unsaved");

  // Still unreachable after a reload: the edit comes back from IndexedDB.
  await page.reload();
  await expect(page.locator('g.part[data-refdes="R1"]')).toBeVisible();
  await editor.place("cap_film", "C1");
  await expect(page.locator(".save-status")).toHaveText(/Offline · 2 unsaved/);

  await page.unroute("**/v1/projects/*/ops");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator(".save-status")).toHaveText("Saved");
  await page.goto("about:blank");
  await page.goto(url);
  await editor.settled();
  expect(await editor.parts()).toEqual(["C1", "R1"]);
});
