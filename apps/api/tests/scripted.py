"""A scripted orchestrator for the API tests: one RC low-pass block from its template, through the
same JobContext calls the real orchestrator (Phase 2 part 4) makes. Tests steer it per job."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import circuit_core as cc

from tutor_api.jobs.runner import Failure, JobContext

GHOST = {
    "id": "b1",
    "title": "RC low-pass filter",
    "role": "filter",
    "ports": [{"name": "in", "direction": "input"}, {"name": "out", "direction": "output"}],
}


@dataclass
class Scripted:
    gate: asyncio.Event | None = None  # when set: wait for it after committing the block
    fail: Failure | None = None  # raise this after committing
    sleep_s: float = 0.0  # sleep this long first (timeouts)
    bad_op: bool = False  # commit a block with an op circuit-core rejects
    contexts: list[JobContext] = field(default_factory=list)

    def reset(self) -> None:
        self.gate, self.fail, self.sleep_s, self.bad_op = None, None, 0.0, False

    async def run(self, ctx: JobContext) -> None:
        self.contexts.append(ctx)
        if self.sleep_s:
            await asyncio.sleep(self.sleep_s)
        await ctx.set_state("planning")
        await ctx.narrate("A first-order low-pass filter: ")
        await ctx.narrate("a resistor into a capacitor.")
        await ctx.set_plan({"blocks": [GHOST]})
        await ctx.emit("block.ghost", GHOST)
        s = await ctx.session()
        trial = cc.unwrap(s.trial_block(json.dumps({"template": {"template": "rc_lowpass"}}), str(ctx.job_id)))
        ops = trial["ops"]
        if self.bad_op:
            ops = ops + [{"op": "part.add", "body": {"refdes": "R99", "part": "no_such_part"}}]
        await ctx.set_state("committing", "b1")
        await ctx.commit(ops, author=trial["author"], block=trial["block"])
        await ctx.record_attempt("b1", 1, ops, [], latency_ms=5)
        await ctx.lesson("narration", "A first-order low-pass filter: a resistor into a capacitor.", "b1")
        ctx.add_usage("scripted", 1200, 300)
        if self.gate:
            await self.gate.wait()
        if self.fail:
            raise self.fail
