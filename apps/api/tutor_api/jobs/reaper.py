"""Marks jobs `failed` whose pod went silent (LLD §5): no liveness key for 30 s. Runs in every API
pod; the conditional UPDATE makes exactly one of them emit the job's final events."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta

from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from ..db.tables import FINAL_STATES, jobs
from .events import EventLog, alive_key
from .runner import ALIVE_TTL_S

log = logging.getLogger("tutor_api.reaper")

LOST = {"code": "job_lost", "message": "the server running this generation stopped responding", "retryable": True}


async def reap_once(engine: AsyncEngine, redis: Redis, events: EventLog) -> list[uuid.UUID]:
    cutoff = datetime.now(UTC) - timedelta(seconds=ALIVE_TTL_S)
    async with engine.connect() as conn:
        candidates = (
            await conn.execute(select(jobs.c.id).where(jobs.c.state.not_in(FINAL_STATES), jobs.c.started_at < cutoff))
        ).scalars().all()
    reaped = []
    for job_id in candidates:
        if await redis.exists(alive_key(job_id)):
            continue
        async with engine.begin() as conn:
            won = (
                await conn.execute(
                    update(jobs)
                    .where(jobs.c.id == job_id, jobs.c.state.not_in(FINAL_STATES))
                    .values(state="failed", error_code=LOST["code"], finished_at=datetime.now(UTC))
                    .returning(jobs.c.id)
                )
            ).one_or_none()
        if won:
            await events.emit(job_id, "job.state", {"state": "failed"})
            await events.emit(job_id, "error", LOST)
            reaped.append(job_id)
            log.warning("reaped job %s", job_id)
    return reaped


async def run_forever(engine: AsyncEngine, redis: Redis, events: EventLog, interval_s: float) -> None:
    while True:
        try:
            await reap_once(engine, redis, events)
        except Exception:  # noqa: BLE001 - try again next round (Redis or Postgres briefly down)
            log.exception("reaper round failed")
        await asyncio.sleep(interval_s)
