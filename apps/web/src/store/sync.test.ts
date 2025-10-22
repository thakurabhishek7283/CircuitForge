// Sync against the real core and a scripted API: edits batched as consecutive envelopes, kept and
// retried while the server is unreachable, and a stale project handed back for a reload.
import { describe, expect, it, vi } from "vitest";
import { ApiFailure } from "../api/client.ts";
import type { AppendOps } from "../gen/contract.ts";
import { bundleJson, loadCore, missingArtifacts } from "../test/artifacts.ts";
import { createCircuitStore } from "./circuitStore.ts";
import { createEdits } from "./edits.ts";
import { memoryPendingStore } from "./pending.ts";
import { Sync, type SyncStatus } from "./sync.ts";

const missing = missingArtifacts();

function setup(replies: ((body: AppendOps) => { rev: number } | ApiFailure)[]) {
  const core = loadCore();
  const session = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), null);
  const store = createCircuitStore(session);
  const edits = createEdits(store, session);
  const sent: AppendOps[] = [];
  const api = {
    appendOps: async (_id: string, body: AppendOps) => {
      sent.push(structuredClone(body));
      const r = replies.shift()?.(body) ?? new ApiFailure(0, { code: "offline", message: "down", retryable: true });
      if (r instanceof ApiFailure) throw r;
      return r;
    },
  };
  const pending = memoryPendingStore();
  const stale: ApiFailure[] = [];
  const statuses: SyncStatus[] = [];
  const sync = new Sync({
    store,
    api,
    project: "p",
    pending,
    serverRev: 0,
    onStale: (e) => stale.push(e),
    onStatus: (s) => statuses.push(s),
    intervalMs: 5,
    retryMs: [5],
  });
  return { store, edits, sync, sent, pending, stale, statuses };
}

const ok = (body: AppendOps) => ({ rev: body.base_rev + body.ops.length });
const offline = () => new ApiFailure(0, { code: "offline", message: "down", retryable: true });

describe.skipIf(missing.length > 0)("Sync", () => {
  it("sends the edits of a second as one batch of consecutive envelopes", async () => {
    const { edits, store, sync, sent, pending } = setup([ok]);
    edits.place("resistor_th");
    edits.place("cap_film");
    edits.wire("R1.2", { pin: "C1.1" });
    store.getState().undo();
    await vi.waitFor(() => expect(sync.unsent).toBe(0));
    expect(sent).toHaveLength(1);
    const { base_rev, ops } = sent[0]!;
    expect(base_rev).toBe(0);
    expect(ops.map((o) => [o.seq, o.base_rev, o.op, o.author])).toEqual([
      [1, 0, "part.add", "user"],
      [2, 1, "part.add", "user"],
      [3, 2, "net.connect", "user"],
      [4, 3, "net.disconnect", "user"],
    ]);
    expect(sync.confirmedRev).toBe(4);
    expect(await pending.get("p")).toBeNull();
  });

  it("keeps edits while the server is unreachable and sends them when it answers", async () => {
    let up = false;
    const server = (b: AppendOps) => (up ? ok(b) : offline());
    const { edits, sync, sent, pending, statuses } = setup(Array.from({ length: 50 }, () => server));
    edits.insertBlock({ template: "rc_lowpass", targets: { fc_hz: "2k" } });
    await vi.waitFor(() => expect(statuses.some((s) => s.state === "offline")).toBe(true));
    const stored = await pending.get("p");
    expect(stored?.baseRev).toBe(0);
    expect(stored?.envelopes.every((e) => e.author === "template")).toBe(true);
    await expect(sync.flush()).rejects.toMatchObject({ code: "offline" });
    up = true;
    await vi.waitFor(() => expect(sync.unsent).toBe(0));
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sent.map((b) => b.base_rev))).toEqual(new Set([0]));
    expect(statuses.at(-1)).toEqual({ state: "saved", unsent: 0 });
  });

  it("hands a stale project back for a reload and drops what the server refused", async () => {
    const { edits, sync, stale, pending } = setup([() => new ApiFailure(409, { code: "stale_rev", message: "base_rev 0 but the project is at rev 3" })]);
    edits.place("resistor_th");
    await vi.waitFor(() => expect(stale).toHaveLength(1));
    expect(stale[0]!.code).toBe("stale_rev");
    expect(sync.unsent).toBe(0);
    expect(await pending.get("p")).toBeNull();
  });

  it("flushes on demand (before a job reads the project), and reloads when the two revs part", async () => {
    const { edits, sync, sent, stale } = setup([ok]);
    edits.place("resistor_th");
    await sync.flush();
    expect(sent).toHaveLength(1);
    sync.advance(9); // a job committed blocks this editor never applied
    edits.place("cap_film"); // made at rev 1, not on top of the server's rev 9
    expect(stale.map((e) => e.message)).toEqual(["local rev 1, expected 9"]);
    expect(sync.unsent).toBe(0);
  });
});
