// A generation job's events as the server streams them (apps/api jobs/runner.py, orchestrator/job.py),
// built with the real core: each block is a template inserted into a scratch session, its ops wrapped
// as the job's envelopes (author llm, consecutive base_rev), between its ghost and its sim.summary.
import type { InsertBlock, Inserted, JobEvent, Op, OpEnvelope } from "../gen/contract.ts";
import type { CoreModule } from "../core/types.ts";
import { expectOk } from "../core/types.ts";
import { bundleJson } from "./artifacts.ts";

export const JOB = "6f1c2b9e-0000-4000-8000-000000000001";

export function envelopes(ops: Op[], baseRev: number, block: string, author: OpEnvelope["author"] = "llm"): OpEnvelope[] {
  return ops.map((op, i) => ({ v: 1, seq: baseRev + i + 1, ...op, author, job: JOB, block, base_rev: baseRev + i }) as OpEnvelope);
}

export interface JobScript {
  events: JobEvent[];
  /** Each block's envelopes, in commit order. */
  blocks: { id: string; title: string; envelopes: OpEnvelope[] }[];
  rev: number;
}

/** A job that builds `blocks` onto `snapshot` (null: an empty circuit) and ends with `done`. */
export function jobScript(core: CoreModule, blocks: InsertBlock[], snapshot: string | null = null): JobScript {
  const scratch = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), snapshot);
  const events: JobEvent[] = [
    { event: "job.state", data: { state: "queued" } },
    { event: "job.state", data: { state: "planning" } },
  ];
  const built: JobScript["blocks"] = [];
  blocks.forEach((req, i) => {
    const ins = expectOk<Inserted>(scratch.insertBlock(JSON.stringify(req)), "insertBlock");
    const begin = ins.ops[0]!;
    if (begin.op !== "block.begin") throw new Error("not a block");
    const envs = envelopes(ins.ops, scratch.rev, ins.block);
    for (const env of envs) expectOk(scratch.apply(JSON.stringify(env)), "apply");
    built.push({ id: ins.block, title: begin.body.title, envelopes: envs });
    events.push(
      { event: "block.ghost", data: { id: ins.block, title: begin.body.title, role: begin.body.role, ports: (begin.body.ports ?? []).map((p) => ({ name: p.name, direction: p.direction })) } },
      ...(i === 0 ? [{ event: "narration.delta", data: { text: "An introduction. " } } as JobEvent] : []),
      { event: "job.state", data: { state: "composing", block: ins.block } },
      { event: "job.state", data: { state: "committing", block: ins.block } },
      ...envs.map((data) => ({ event: "op", data }) as JobEvent),
      { event: "sim.summary", data: { block: ins.block, checks: [] } },
      { event: "narration.delta", data: { block: ins.block, text: `What ${ins.block} does. ` } },
    );
  });
  events.push({ event: "job.state", data: { state: "done" } }, { event: "done", data: { rev: scratch.rev, usage: { in_tokens: 10, out_tokens: 2 } } });
  return { events, blocks: built, rev: scratch.rev };
}
