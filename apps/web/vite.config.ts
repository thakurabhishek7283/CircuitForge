// Circuit Forge web client: a static bundle for a CDN (LLD §2).
//
// Static assets the app loads at runtime, kept out of the JS bundle:
//   /ngspice/   ngspice.mjs, ngspice.wasm, COPYING   from third_party/ngspice/dist/wasm (build-wasm.sh)
//   /registry/  registry-<ver>.json, registry-<ver>/  from target/registry (bundle_registry example)
// The dev server serves them from those folders; `vite build` copies them into dist/ (registry:
// the manifest's current version). Set VITE_NGSPICE_URL / VITE_REGISTRY_URL to serve them from a
// CDN instead; that part is then left out of dist/.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const app = fileURLToPath(new URL(".", import.meta.url));
const repo = join(app, "../..");
const ngspiceDir = join(repo, "third_party/ngspice/dist/wasm");
const registryDir = join(repo, "target/registry");
const registryVersion = /^version:\s*"?([^"\s]+)"?/m.exec(readFileSync(join(repo, "registry/manifest.yaml"), "utf8"))![1]!;

const TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

interface Mount {
  url: string;
  dir: string;
  /** What `vite build` copies, relative to `dir`. */
  ship: string[];
  howToBuild: string;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function staticAssets(mounts: Mount[]): Plugin {
  return {
    name: "circuit-forge-static-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0]!);
        const mount = mounts.find((m) => url.startsWith(m.url));
        if (!mount) return next();
        const path = normalize(join(mount.dir, url.slice(mount.url.length)));
        if (!path.startsWith(mount.dir + sep) || !existsSync(path) || !statSync(path).isFile()) return next();
        res.setHeader("Content-Type", TYPES[extname(path)] ?? "text/plain; charset=utf-8");
        createReadStream(path).pipe(res);
      });
    },
    generateBundle() {
      for (const m of mounts) {
        for (const item of m.ship) {
          const path = join(m.dir, item);
          if (!existsSync(path)) this.error(`${path} is missing: ${m.howToBuild}`);
          const all = statSync(path).isDirectory() ? files(path) : [path];
          for (const f of all) {
            const fileName = m.url.slice(1) + relative(m.dir, f).split(sep).join("/");
            this.emitFile({ type: "asset", fileName, source: readFileSync(f) });
          }
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, app, "VITE_");
  const mounts: Mount[] = [];
  if (!env.VITE_NGSPICE_URL) {
    mounts.push({
      url: "/ngspice/",
      dir: ngspiceDir,
      ship: ["ngspice.mjs", "ngspice.wasm", "COPYING"],
      howToBuild: "run third_party/ngspice/build-wasm.sh",
    });
  }
  if (!env.VITE_REGISTRY_URL) {
    mounts.push({
      url: "/registry/",
      dir: registryDir,
      ship: [`registry-${registryVersion}.json`, `registry-${registryVersion}`],
      howToBuild: "run cargo run -p circuit-core --example bundle_registry",
    });
  }
  return {
    plugins: [react(), staticAssets(mounts)],
    resolve: {
      // circuit-core's browser build (node crates/circuit-core-wasm/build.mjs); Vite emits its .wasm.
      alias: { "@tutor/core": join(repo, "crates/circuit-core-wasm/pkg/core.js") },
    },
    server: { fs: { allow: [repo] } },
    worker: { format: "es" },
    build: { target: "es2022", sourcemap: true },
    test: { include: ["src/**/*.test.{ts,tsx}"] },
  };
});
