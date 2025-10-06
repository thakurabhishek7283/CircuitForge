"""Runs generation jobs (LLD §5, §6): one asyncio task per job in the pod that accepted
`/generate`, with a liveness key, cancellation from any pod, the 120 s job timeout, and the final
events and job row written exactly once.

The orchestrator (planner, composer, verifier: Phase 2 part 4) plugs in through `Orchestrator`;
everything it does to the project goes through `JobContext`.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

import circuit_core as cc
from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine
from redis.asyncio import Redis

from .. import projects
from ..config import Settings
from ..db.tables import FINAL_STATES, block_attempts, jobs
from ..errors import ApiException
from ..models.contract import GenerateRequest
from .events import EventLog, alive_key, cancel_key

log = logging.getLogger("tutor_api.jobs")

ALIVE_TTL_S = 30  # LLD §5: a job silent for 30 s is reaped
ALIVE_EVERY_S = 5.0
CANCEL_POLL_S = 0.25


class Orchestrator(Protocol):
    async def run(self, ctx: JobContext) -> None: ...


@dataclass
class Failure(Exception):
    """Ends a job as `failed` with this error (the `error` event and `jobs.error_code`)."""

    code: str
    message: str
    retryable: bool = False


@dataclass
class JobContext:
    """What an orchestrator may do to its job and project."""

    job_id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    request: GenerateRequest
    engine: AsyncEngine
    redis: Redis
    events: EventLog
    regs: projects.Registries
    settings: Settings
    registry_version: str
    in_tokens: int = 0
    out_tokens: int = 0
    model: str | None = None
    rev: int = 0
    cancel_requested: bool = False
    work: asyncio.Task | None = field(default=None, repr=False)  # the orchestrator's task

    async def emit(self, event: str, data: Any = None) -> int:
        return await self.events.emit(self.job_id, event, data)

    async def set_state(self, state: str, block: str | None = None) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(
                update(jobs).where(jobs.c.id == self.job_id, jobs.c.state.not_in(FINAL_STATES)).values(state=state)
            )
        await self.emit("job.state", {"state": state} | ({"block": block} if block else {}))

    async def session(self) -> cc.Session:
        """The project's circuit at head (to trial blocks against); changes go through `commit`."""
        async with self.engine.connect() as conn:
            row = await projects.get_owned(conn, str(self.project_id), self.user_id)
            return await projects.load_session(conn, self.regs, row)

    async def commit(self, ops: list[dict[str, Any]], *, author: str, block: str | None = None) -> int:
        """Apply bare ops to the project as this job's envelopes, store them, then stream each as an
        `op` event. Atomic: a rejected op stores nothing. Returns the new rev."""
        async with self.engine.begin() as conn:
            row = await projects.get_owned(conn, str(self.project_id), self.user_id, lock=True)
            base = row.head_rev
            envelopes = []
            for i, op in enumerate(ops):
                env = {"v": 1, "seq": base + i + 1, **op, "author": author, "job": str(self.job_id), "base_rev": base + i}
                if block and op.get("op") != "narrate":
                    env["block"] = block
                envelopes.append(env)
            done = await projects.append(
                conn, self.regs, row, envelopes, base_rev=base, snapshot_every=self.settings.snapshot_every,
                job_id=self.job_id,
            )
        for env in done.envelopes:
            await self.emit("op", env)
        self.rev = done.rev
        return done.rev

    async def narrate(self, text: str, block: str | None = None) -> None:
        await self.emit("narration.delta", {"text": text} | ({"block": block} if block else {}))

    async def lesson(self, kind: str, text: str, block: str | None = None, refs: list[str] | None = None) -> None:
        async with self.engine.begin() as conn:
            await projects.add_lesson(conn, self.project_id, kind, text, block, refs or [])

    async def set_plan(self, plan: Any) -> None:
        async with self.engine.begin() as conn:
            await conn.execute(update(jobs).where(jobs.c.id == self.job_id).values(plan=plan))

    def add_usage(self, model: str, in_tokens: int, out_tokens: int) -> None:
        self.model = model
        self.in_tokens += in_tokens
        self.out_tokens += out_tokens

    async def record_attempt(
        self, block_id: str, attempt: int, ops: list[Any], errors: list[Any], sim_checks: Any = None,
        latency_ms: int | None = None,
    ) -> None:
        """One composer attempt, failures included (LLD §11 `block_attempts`)."""
        async with self.engine.begin() as conn:
            await conn.execute(
                insert(block_attempts).values(
                    job_id=self.job_id, block_id=block_id, attempt=attempt, ops=ops, errors=errors,
                    sim_checks=sim_checks, latency_ms=latency_ms,
                )
            )


class JobRunner:
    def __init__(self, *, engine: AsyncEngine, redis: Redis, regs: projects.Registries, settings: Settings,
                 orchestrator: Orchestrator | None):
        self.engine = engine
        self.redis = redis
        self.events = EventLog(redis)
        self.regs = regs
        self.settings = settings
        self.orchestrator = orchestrator
        self.tasks: dict[uuid.UUID, tuple[asyncio.Task, JobContext]] = {}

    async def start(self, user: uuid.UUID, project_id: str, req: GenerateRequest) -> uuid.UUID:
        if self.orchestrator is None:
            raise ApiException(503, "generation_unavailable", "generation is not available on this server", retryable=True)
        job_id = uuid.uuid4()
        async with self.engine.begin() as conn:
            row = await projects.get_owned(conn, project_id, user, lock=True)
            try:
                async with conn.begin_nested():
                    await conn.execute(
                        insert(jobs).values(
                            id=job_id, project_id=row.id, user_id=user, prompt=req.prompt,
                            mode=str(req.mode or "compose"), state="queued", started_at=datetime.now(UTC),
                        )
                    )
            except IntegrityError:
                raise ApiException(409, "job_running", "a generation job is already running on this project") from None
        ctx = JobContext(
            job_id=job_id, project_id=row.id, user_id=user, request=req, engine=self.engine, redis=self.redis,
            events=self.events, regs=self.regs, settings=self.settings, registry_version=row.registry_version,
            rev=row.head_rev,
        )
        await self.redis.set(alive_key(job_id), "1", ex=ALIVE_TTL_S)
        await ctx.emit("job.state", {"state": "queued"})
        ctx.work = asyncio.create_task(self._orchestrate(ctx), name=f"job {job_id}")
        task = asyncio.create_task(self._run(ctx), name=f"job {job_id} runner")
        self.tasks[job_id] = (task, ctx)
        task.add_done_callback(lambda _: self.tasks.pop(job_id, None))
        return job_id

    async def cancel(self, user: uuid.UUID, job_id: uuid.UUID) -> None:
        """Ask the job to stop, wherever it runs: its pod polls the cancel key."""
        async with self.engine.connect() as conn:
            owner = (await conn.execute(select(jobs.c.user_id).where(jobs.c.id == job_id))).scalar_one_or_none()
        if owner != user:
            raise ApiException(404, "not_found", "job not found")
        await self.redis.set(cancel_key(job_id), "1", ex=int(self.settings.job_timeout_s * 2))
        if local := self.tasks.get(job_id):
            local[1].cancel_requested = True
            local[1].work.cancel()

    async def _watch(self, ctx: JobContext, task: asyncio.Task) -> None:
        last_alive = time.monotonic()
        while True:
            await asyncio.sleep(CANCEL_POLL_S)
            if await self.redis.exists(cancel_key(ctx.job_id)):
                ctx.cancel_requested = True
                task.cancel()
                return
            if time.monotonic() - last_alive >= ALIVE_EVERY_S:
                await self.redis.set(alive_key(ctx.job_id), "1", ex=ALIVE_TTL_S)
                last_alive = time.monotonic()

    async def _run(self, ctx: JobContext) -> None:
        work = ctx.work
        watcher = asyncio.create_task(self._watch(ctx, work))
        failure: Failure | None = None
        try:
            await work
            state = "done"
        except asyncio.CancelledError:
            if ctx.cancel_requested:
                state = "cancelled"
            else:  # the server is shutting down
                state, failure = "failed", Failure("server_shutdown", "the server restarted during generation", True)
        except TimeoutError:
            state, failure = "failed", Failure("job_timeout", f"generation took over {self.settings.job_timeout_s:.0f} s", True)
        except Failure as f:
            state, failure = "failed", f
        except ApiException as e:
            state, failure = "failed", Failure(e.error.code, e.error.message, bool(e.error.retryable))
        except Exception as e:  # noqa: BLE001 - every job ends with a final event
            log.exception("job %s failed", ctx.job_id)
            state, failure = "failed", Failure("internal", f"{type(e).__name__}: {e}", True)
        finally:
            watcher.cancel()
        await self._finish(ctx, state, failure)

    async def _orchestrate(self, ctx: JobContext) -> None:
        async with asyncio.timeout(self.settings.job_timeout_s):
            await self.orchestrator.run(ctx)

    async def _finish(self, ctx: JobContext, state: str, failure: Failure | None) -> None:
        """Write the final state once (the reaper may have got there first) and the last events."""
        async with self.engine.begin() as conn:
            won = (
                await conn.execute(
                    update(jobs)
                    .where(jobs.c.id == ctx.job_id, jobs.c.state.not_in(FINAL_STATES))
                    .values(
                        state=state, error_code=failure.code if failure else None, finished_at=datetime.now(UTC),
                        in_tokens=ctx.in_tokens, out_tokens=ctx.out_tokens, model=ctx.model,
                    )
                    .returning(jobs.c.id)
                )
            ).one_or_none()
            if won is None:
                return
            row = await projects.get_owned(conn, str(ctx.project_id), ctx.user_id, lock=True)
            await projects.write_snapshot(conn, self.regs, row)
        await ctx.emit("job.state", {"state": state})
        if failure:
            await ctx.emit("error", {"code": failure.code, "message": failure.message, "retryable": failure.retryable})
        else:
            await ctx.emit("done", {"rev": row.head_rev, "usage": {"in_tokens": ctx.in_tokens, "out_tokens": ctx.out_tokens}})
        await self.redis.delete(alive_key(ctx.job_id), cancel_key(ctx.job_id))

    async def shutdown(self) -> None:
        """Stop every local job; each still ends as `failed` (`server_shutdown`, retryable)."""
        running = list(self.tasks.values())
        for _, ctx in running:
            ctx.work.cancel()
        await asyncio.gather(*(t for t, _ in running), return_exceptions=True)
