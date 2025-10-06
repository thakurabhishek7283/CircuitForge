"""A job's events in the Redis Stream `job:{id}:events` (LLD §5): written before anyone sees them,
so a reconnect with `Last-Event-ID` loses nothing, and any API pod can serve any stream.

Entry ids are `0-<seq>`: Redis assigns the next seq (`XADD … 0-*`), so the job's own pod and the
reaper in another pod can both append, and the SSE `id` is the plain integer seq.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis

from ..models.contract import JobEvent

STREAM_TTL_S = 3600
STREAM_MAXLEN = 5000
TERMINAL = ("done", "error")  # the last event of every job


def stream_key(job_id: uuid.UUID | str) -> str:
    return f"job:{job_id}:events"


def alive_key(job_id: uuid.UUID | str) -> str:
    return f"job:{job_id}:alive"


def cancel_key(job_id: uuid.UUID | str) -> str:
    return f"job:{job_id}:cancel"


@dataclass(frozen=True)
class Event:
    seq: int
    event: str
    data: str | None  # JSON text, as stored


class EventLog:
    def __init__(self, redis: Redis):
        self.redis = redis

    async def emit(self, job_id: uuid.UUID, event: str, data: Any = None) -> int:
        """Append one event; returns its seq. The event must be a valid wire `JobEvent`."""
        doc = {"event": event} if data is None else {"event": event, "data": data}
        JobEvent.model_validate(doc)
        fields = {"event": event, "data": "" if data is None else json.dumps(data, separators=(",", ":"))}
        key = stream_key(job_id)
        async with self.redis.pipeline(transaction=True) as p:
            p.xadd(key, fields, id="0-*", maxlen=STREAM_MAXLEN, approximate=True)
            p.expire(key, STREAM_TTL_S)
            entry_id, _ = await p.execute()
        return int(entry_id.split(b"-")[1])

    async def read(self, job_id: uuid.UUID, after: int, *, block_ms: int | None, count: int = 200) -> list[Event]:
        """Events with seq > `after`, waiting up to `block_ms` for the first one (None: no wait)."""
        out = await self.redis.xread({stream_key(job_id): f"0-{after}"}, count=count, block=block_ms)
        events = []
        for _, entries in out or []:
            for entry_id, fields in entries:
                data = fields.get(b"data", b"").decode()
                events.append(Event(int(entry_id.split(b"-")[1]), fields[b"event"].decode(), data or None))
        return events

    async def exists(self, job_id: uuid.UUID) -> bool:
        return bool(await self.redis.exists(stream_key(job_id)))
