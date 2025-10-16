"""One generation job (LLD §6): plan; then for each block in signal order: ghost, compose, verify,
repair up to 3 attempts, fall back to the block's template, commit, and report its spec checks.
Narration of the plan streams from the small model while the first block is composed.

Template mode (`GenerateRequest.mode = templates`) plans with the small model and builds every
block from its template, with no composer calls (LLD §13).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import circuit_core as cc

from ..jobs.runner import Failure, JobContext
from ..llm.base import LlmRequest, LlmResponse
from ..llm.gateway import Gateway, LlmUnavailable
from ..llm.prompts import Prompts
from ..retrieval.parts import candidates
from . import composer, planner, repair
from .planner import Plan, PlannedBlock
from .verifier import verify

log = logging.getLogger("tutor_api.orchestrator")

MAX_ATTEMPTS = 3  # LLD §1: 3 repair attempts per block
NARRATE_MAX_TOKENS = 400
NARRATION_WAIT_S = 5.0  # how long the first commit waits for the narration to finish


@dataclass
class Orchestrator:
    gateway: Gateway
    narrate: bool = True
    prompts: dict[str, Prompts] = field(default_factory=dict)  # per registry version

    def prompts_for(self, reg: cc.Registry) -> Prompts:
        if reg.version not in self.prompts:
            self.prompts[reg.version] = Prompts(reg)
        return self.prompts[reg.version]

    async def run(self, ctx: JobContext) -> None:
        await Job(self, ctx).run()


class Job:
    def __init__(self, orch: Orchestrator, ctx: JobContext):
        self.orch = orch
        self.gw = orch.gateway
        self.ctx = ctx
        self.reg = ctx.regs.get(ctx.registry_version)
        self.prompts = orch.prompts_for(self.reg)
        self.prompt = ctx.request.prompt
        self.level = str(ctx.request.level or "beginner")
        self.templates_only = str(ctx.request.mode or "compose") == "templates"
        self.nets: dict[str, dict[str, str]] = {}  # committed block -> port -> net
        self.lessons = asyncio.Lock()  # lesson_track seq is max + 1: one writer at a time

    def usage(self, resp: LlmResponse) -> None:
        self.ctx.add_usage(resp.model, resp.usage.in_tokens, resp.usage.out_tokens)

    async def lesson(self, kind: str, text: str, block: str | None = None, refs: list[str] | None = None) -> None:
        async with self.lessons:
            await self.ctx.lesson(kind, text, block, refs)

    async def run(self) -> None:
        ctx = self.ctx
        await ctx.set_state("planning")
        session = await ctx.session()
        try:
            plan = await planner.plan(
                self.gw, self.prompts, session, prompt=self.prompt, level=self.level,
                tier="small" if self.templates_only else "large", on_usage=self.usage,
            )
        except planner.PlanFailed as e:
            if e.unsupported:
                raise Failure("unsupported_request", "That needs something the block library cannot build yet: "
                              + "; ".join(e.problems), retryable=False) from None
            raise Failure("plan_invalid", "No valid plan after re-planning: " + "; ".join(e.problems[:5]),
                          retryable=True) from None
        except LlmUnavailable as e:
            raise Failure("llm_unavailable", f"The model is not answering: {e}", retryable=True) from None
        await ctx.set_plan(plan.to_json())

        narration = asyncio.create_task(self.narrate(plan)) if self.orch.narrate else None
        try:
            for i, block in enumerate(plan.blocks):
                await ctx.emit("block.ghost", block.ghost())
                verdict = await self.build(plan, block)
                if i == 0 and narration is not None:
                    # Narration first, then the first block's ops, unless the narrator is slow.
                    await asyncio.wait([narration], timeout=NARRATION_WAIT_S)
                await self.commit(block, verdict)
                await ctx.set_plan(plan.to_json())
        finally:
            if narration is not None:
                narration.cancel()  # no-op once it has finished
                (outcome,) = await asyncio.gather(narration, return_exceptions=True)
                if isinstance(outcome, Exception):
                    log.error("job %s: narration crashed: %r", ctx.job_id, outcome)

    # ------------------------------------------------------------------ narration

    async def narrate(self, plan: Plan) -> None:
        """Best effort: a narration that fails leaves the lesson without an introduction, nothing else."""
        text: list[str] = []

        async def delta(piece: str) -> None:
            text.append(piece)
            await self.ctx.narrate(piece)

        req = LlmRequest("narrate", "small", self.prompts.narrator,
                         self.prompts.narrate(prompt=self.prompt, level=self.level, plan=[b.brief() for b in plan.blocks]),
                         max_tokens=NARRATE_MAX_TOKENS, temperature=0.5)
        try:
            resp = await self.gw.stream(req, delta)
            self.usage(resp)
        except LlmUnavailable as e:
            log.warning("job %s: narration failed: %s", self.ctx.job_id, e)
        if "".join(text).strip():
            await self.lesson("narration", "".join(text).strip())

    # ------------------------------------------------------------------ blocks

    def bindings(self, block: PlannedBlock) -> dict[str, Any]:
        return {port: {"net": self.nets[src][sport]} for port, (src, sport) in block.inputs.items()}

    def port_text(self, block: PlannedBlock, preview: dict[str, Any]) -> dict[str, str]:
        t = self.prompts.templates[block.template]
        out = {}
        for port, direction in block.ports.items():
            if port in block.inputs:
                src, sport = block.inputs[port]
                out[port] = f"{src}.{sport} (net {self.nets[src][sport]})"
            elif port in t["rails"]:
                volts = preview["rails"].get(port, t["rails"][port]["volts"])
                out[port] = f"rail {t['rails'][port]['net']} at {volts:g} V"
            elif direction == "ground":
                out[port] = "ground (GND)"
            elif direction == "input":
                out[port] = "a new net; nothing drives it in this circuit"
            else:
                out[port] = "a new net"
        return out

    async def build(self, plan: Plan, block: PlannedBlock):
        """The verdict to commit: the model's block when one passes within 3 attempts, else the
        template's (the fallback)."""
        ctx = self.ctx
        ports = self.bindings(block)
        base = composer.template_request(block, ports)
        session = await ctx.session()
        if self.templates_only:
            await ctx.set_state("verifying", block.id)
            verdict = await self.verify(session, {"template": base})
            block.outcome = {"how": "template_mode", "attempts": 0}
            return self.must_apply(block, verdict)

        preview = cc.unwrap(session.preview_block(json.dumps(base)))
        cands = candidates(self.prompts.bundle, block.template)
        last: dict[str, Any] | None = None
        history: list[list[str]] = []
        why = "attempts"
        for attempt in range(1, MAX_ATTEMPTS + 1):
            await ctx.set_state("composing", block.id)
            started = time.perf_counter()
            try:
                c = await composer.compose(
                    self.gw, self.prompts, prompt=self.prompt, plan=[b.brief() for b in plan.blocks], block=block,
                    ports=ports, port_text=self.port_text(block, preview), preview=preview,
                    circuit=session.circuit_text(), candidates=cands, last=last,
                )
            except LlmUnavailable as e:
                log.warning("job %s: composer unavailable for %s: %s", ctx.job_id, block.id, e)
                why = "llm_unavailable"
                break
            self.usage(c.response)
            if c.request is None:
                errors = [{"code": "schema_error", "message": str(c.error)}]
                verdict = None
                recorded: list[Any] = [{"reply": c.response.text[:4000]}]
            else:
                await ctx.set_state("verifying", block.id)
                verdict = await self.verify(session, c.request)
                errors = verdict.errors
                recorded = [c.request]
            await ctx.record_attempt(
                block.id, attempt, recorded, errors, verdict.checks if verdict else None,
                latency_ms=round((time.perf_counter() - started) * 1e3),
            )
            if not errors:
                block.outcome = {"how": c.choice, "attempts": attempt, "errors": history}
                return verdict
            history.append(repair.codes(errors))
            await ctx.emit("block.repair", {"id": block.id, "attempt": attempt, "errors": repair.codes(errors)})
            await self.lesson("repair", repair.for_student(block.title, attempt, errors), block.id)
            last = {"output": composer.reply_text(c.response), "problems": repair.for_model(errors)}
            await ctx.set_state("repairing", block.id)  # then composing again, or the fallback (LLD §6)

        await ctx.set_state("fallback", block.id)
        verdict = await self.verify(session, {"template": base})
        block.outcome = {"how": "fallback", "attempts": len(history), "errors": history, "why": why}
        await self.lesson("note", f"Used the standard {block.block_title} for this stage.", block.id)
        return self.must_apply(block, verdict)

    async def verify(self, session: cc.Session, request: dict[str, Any]):
        return await verify(session, request, job=str(self.ctx.job_id), redis=self.ctx.redis,
                            registry_version=self.ctx.registry_version)

    @staticmethod
    def must_apply(block: PlannedBlock, verdict):
        """A template block commits on its own checks' word (they are reported, not enforced): the
        template is verified across its range in CI. Its ops must apply, which the plan checked."""
        if verdict.trial["problems"]:
            raise Failure("fallback_failed", f"{block.id} ({block.template}) cannot be built: "
                          + "; ".join(p["message"] for p in verdict.trial["problems"]), retryable=True)
        return verdict

    async def commit(self, block: PlannedBlock, verdict) -> None:
        ctx, trial = self.ctx, verdict.trial
        await ctx.set_state("committing", block.id)
        await ctx.commit(trial["ops"], author=trial["author"], block=trial["block"])
        begin = trial["ops"][0]["body"]
        self.nets[block.id] = {p["name"]: p["net"] for p in begin["ports"]}
        if verdict.checks is not None:
            await ctx.emit("sim.summary", {"block": block.id, "checks": verdict.checks})
        if block.purpose:
            await ctx.narrate(block.purpose + " ", block.id)
            await self.lesson("narration", block.purpose, block.id, sorted(trial["refdes"].values()))
