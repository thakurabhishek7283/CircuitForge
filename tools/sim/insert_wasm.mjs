// Template parity, WASM side: insert blocks with the Node build of @tutor/core and write each
// result string (`insertBlock`; with `"bench": true`, then `benchOps` on the inserted block).
// Driven by test_templates.py, which compares them with PyO3's.
// usage: node tools/sim/insert_wasm.mjs <requests.json> <results.json>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const repo = join(import.meta.dirname, "../..");
const [requestsPath, resultsPath] = process.argv.slice(2);
const version = /^version:\s*"?([^"\s]+)"?/m.exec(readFileSync(join(repo, "registry/manifest.yaml"), "utf8"))[1];
const core = createRequire(import.meta.url)(join(repo, "crates/circuit-core-wasm/pkg-node/core.js"));
const registry = core.CoreRegistry.fromJson(readFileSync(join(repo, `target/registry/registry-${version}.json`), "utf8"));
const results = JSON.parse(readFileSync(requestsPath, "utf8")).map(({ req, bench }) => {
  const session = new core.CoreSession(registry);
  let out = session.insertBlock(JSON.stringify(req));
  if (bench) {
    session.applyOps(JSON.stringify(JSON.parse(out).ok.ops), "template");
    out = session.benchOps(JSON.parse(out).ok.block);
  }
  session.free();
  return out;
});
writeFileSync(resultsPath, JSON.stringify(results));
