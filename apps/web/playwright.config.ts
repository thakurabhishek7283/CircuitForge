// Browser tests (LLD §15: Playwright end-to-end), run against the static bundle a CDN would serve:
// `npm run build`, then `npm run e2e` (vite preview serves dist/). Two projects:
//
// - `local`: the editing flows with the API down (every /v1 request answers 503): editing and
//   simulation work without a server (LLD §14).
// - `api`: generation flows against the real API (tools/e2e/stack.py: Postgres and Redis in Docker,
//   the sim_runner worker on the native ngspice, LLM_PROVIDER=fake with apps/api/fake/script.json),
//   through a second preview server that proxies /v1 to it. E2E_API=0 leaves them out.
//
// They drive the system browser through its channel instead of a downloaded build: Edge here and
// on GitHub's Ubuntu runners, where it is preinstalled. PW_CHANNEL=chrome picks Chrome instead.
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const localPort = 4173;
const apiPreviewPort = 4174;
const apiPort = Number(process.env.E2E_API_PORT ?? 8100);
const withApi = process.env.E2E_API !== "0";
const repo = join(import.meta.dirname, "../..");
const python = join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");

const preview = (port: number, apiOrigin: string) => ({
  command: `npx vite preview --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  env: { API_ORIGIN: apiOrigin },
  reuseExistingServer: !process.env.CI,
});

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // Every test runs its own browser, ngspice and ELK workers. CI runners have 4 vCPUs. Locally a
  // fixed 4 (E2E_WORKERS to change it), not Playwright's default of half the logical CPUs: on a
  // 24-thread machine 12 browsers starting at once (each compiling ngspice's 4.5 MB WASM) held the
  // CPU at 91-99% and pushed a first layout or simulation past its 10 s expectation; the Phase 1
  // flows alone failed 4-8 of 11 in each of three runs. 4 workers: 3 of 3 full runs clean.
  workers: process.env.CI ? 2 : Number(process.env.E2E_WORKERS ?? 4),
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    channel: process.env.PW_CHANNEL ?? "msedge",
    viewport: { width: 1400, height: 860 },
    // Tracing records the animating overlay throughout; with one browser per core (8 locally)
    // that starved the pages and every test timed out. CI runs 2 workers and keeps traces of
    // failures; locally pass --trace on when needed.
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  projects: [
    { name: "local", testIgnore: /generate\.spec\.ts/, use: { baseURL: `http://localhost:${localPort}` } },
    ...(withApi ? [{ name: "api", testMatch: /generate\.spec\.ts/, use: { baseURL: `http://localhost:${apiPreviewPort}` } }] : []),
  ],
  webServer: [
    preview(localPort, "none"),
    ...(withApi
      ? [
          {
            // A fresh API per run: the fake script's one-shot rules (a failure, then a retry) are state.
            command: `"${python}" ${join(repo, "tools/e2e/stack.py")} --port ${apiPort}`,
            url: `http://127.0.0.1:${apiPort}/healthz`,
            timeout: 180_000,
            reuseExistingServer: false,
            stdout: "pipe" as const,
          },
          preview(apiPreviewPort, `http://127.0.0.1:${apiPort}`),
        ]
      : []),
  ],
});
