from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Request, Response
from fastapi.sse import EventSourceResponse, ServerSentEvent
from sqlalchemy import select

from ..auth import User
from ..db.tables import FINAL_STATES, jobs, projects
from ..errors import not_found
from ..jobs.events import TERMINAL

router = APIRouter(prefix="/v1/jobs", tags=["jobs"])

HEARTBEAT_MS = 15_000  # LLD §5: a heartbeat every 15 s while nothing else happens


async def owned_job(job_id: str, request: Request, user: User) -> Any:
    try:
        jid = uuid.UUID(job_id)
    except ValueError:
        raise not_found("job") from None
    async with request.app.state.engine.connect() as conn:
        row = (await conn.execute(select(jobs).where(jobs.c.id == jid, jobs.c.user_id == user))).one_or_none()
    if row is None:
        raise not_found("job")
    return row


Job = Annotated[Any, Depends(owned_job)]


async def final_event(request: Request, job_id: uuid.UUID) -> ServerSentEvent | None:
    """The job's last event rebuilt from Postgres, for a finished job whose stream has expired."""
    async with request.app.state.engine.connect() as conn:
        row = (
            await conn.execute(
                select(jobs.c.state, jobs.c.error_code, jobs.c.in_tokens, jobs.c.out_tokens, projects.c.head_rev)
                .join(projects, projects.c.id == jobs.c.project_id)
                .where(jobs.c.id == job_id)
            )
        ).one()
    if row.state not in FINAL_STATES:
        return None
    if row.state == "failed":
        data = {"code": row.error_code or "failed", "message": "generation failed", "retryable": False}
        return ServerSentEvent(event="error", data=data)
    usage = {"in_tokens": row.in_tokens, "out_tokens": row.out_tokens}
    return ServerSentEvent(event="done", data={"rev": row.head_rev, "usage": usage})


@router.get("/{job_id}/events", response_class=EventSourceResponse)
async def job_events(
    job: Job, request: Request, last_event_id: Annotated[str | None, Header()] = None
) -> AsyncIterator[ServerSentEvent]:
    """The job's events after `Last-Event-ID` (all of them without it), ending with `done` or
    `error`. `id` is the event's seq; heartbeats carry none, so they never move the resume point."""
    events = request.app.state.events
    after = int(last_event_id) if last_event_id and last_event_id.isdigit() else 0
    while True:
        if not await events.exists(job.id) and (last := await final_event(request, job.id)):
            yield last  # the stream expired (1 h) after the job ended
            return
        batch = await events.read(job.id, after, block_ms=HEARTBEAT_MS)
        for e in batch:
            yield ServerSentEvent(id=str(e.seq), event=e.event, raw_data=e.data)
            after = e.seq
            if e.event in TERMINAL:
                return
        if not batch:
            if await request.is_disconnected():
                return
            yield ServerSentEvent(event="heartbeat")


@router.post("/{job_id}/cancel", status_code=202)
async def cancel(job: Job, request: Request, user: User) -> Response:
    if job.state not in FINAL_STATES:
        await request.app.state.runner.cancel(user, job.id)
    return Response(status_code=202)
