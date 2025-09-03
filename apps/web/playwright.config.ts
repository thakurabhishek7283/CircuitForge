// Browser tests of the editing flows (LLD §15: Playwright end-to-end), run against the static
// bundle a CDN would serve: `npm run build`, then `npm run e2e` (vite preview serves dist/).
//
// They drive the system browser through its channel instead of a downloaded build: Edge here and
// on GitHub's Ubuntu runners, where it is preinstalled. PW_CHANNEL=chrome picks Chrome instead.
import { defineConfig } from "@playwright/test";

const port = 4173;

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // CI runners have 4 vCPUs; every test runs its own browser, ngspice and ELK workers.
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    channel: process.env.PW_CHANNEL ?? "msedge",
    viewport: { width: 1400, height: 860 },
    // Tracing records the animating overlay throughout; with one browser per core (8 locally)
    // that starved the pages and every test timed out. CI runs 2 workers and keeps traces of
    // failures; locally pass --trace on when needed.
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
