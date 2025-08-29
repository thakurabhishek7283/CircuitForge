// Layout scheduling: only topology changes re-lay out, the newest request wins, and `layoutRev`
// says which rev the drawing shows.
import { describe, expect, it } from "vitest";
import type { Layout, LayoutInput } from "../workers/layout.types.ts";
import { bundleJson, demoJson, loadCore, missingArtifacts } from "../test/artifacts.ts";
import { createCircuitStore } from "./circuitStore.ts";
import { attachLayout } from "./layoutSync.ts";

const fake = (parts: number) => ({ stats: { parts } }) as unknown as Layout;

describe.skipIf(missingArtifacts().length > 0)("layout sync", () => {
  it("tracks the rev the layout shows, skipping value edits and superseded results", async () => {
    const core = loadCore();
    const store = createCircuitStore(new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), demoJson()));
    const requests: { input: LayoutInput; resolve: (l: Layout) => void }[] = [];
    attachLayout(store, (input) => new Promise((resolve) => requests.push({ input, resolve })));
    const s = () => store.getState();

    expect(requests).toHaveLength(1);
    requests[0]!.resolve(fake(8));
    await Promise.resolve();
    expect(s().layoutRev).toBe(s().rev);

    // A value edit does not re-lay out, but the drawing is current for the new rev.
    s().apply({ op: "part.set_param", body: { refdes: "R1", key: "resistance", value: "1k" } });
    expect(requests).toHaveLength(1);
    expect(s().layoutRev).toBe(s().rev);

    // Two topology edits: the first result is superseded and ignored.
    s().apply({ op: "part.add", body: { refdes: "R9", part: "resistor_th" } });
    s().apply({ op: "part.add", body: { refdes: "R10", part: "resistor_th" } });
    expect(requests).toHaveLength(3);
    expect(s().layoutRev).toBeLessThan(s().rev);
    requests[1]!.resolve(fake(9));
    await Promise.resolve();
    expect(s().layoutRev).toBeLessThan(s().rev);
    requests[2]!.resolve(fake(10));
    await Promise.resolve();
    expect(s().layout).toEqual(fake(10));
    expect(s().layoutRev).toBe(s().rev);
  });
});
