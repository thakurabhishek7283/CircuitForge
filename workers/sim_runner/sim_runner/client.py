"""Enqueue a simulation and await its summary (the API's `sim/client.py`, LLD §2).

A cached result is returned without a queue round trip. The arq job id is the cache key, so
identical requests in flight at the same time run ngspice once and all receive that result.
"""

from __future__ import annotations

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from arq.jobs import Job, ResultNotFound

from .protocol import QUEUE, TASK, SimRefused, SimRequest, SimSummary, cache_key, dumps, loads

POLL_S = 0.02  # how often a waiting caller polls for the result; arq's default is 0.5 s
EXPIRES_S = 60  # a job no worker has started by then is dropped (arq's default is 24 h)


async def connect(redis_url: str) -> ArqRedis:
    return await create_pool(
        RedisSettings.from_dsn(redis_url), job_serializer=dumps, job_deserializer=loads, default_queue_name=QUEUE
    )


async def simulate(redis: ArqRedis, req: SimRequest, *, wait_s: float = 10.0) -> SimSummary:
    """The summary of `req`, from the cache or the worker. Raises `SimRefused` when the worker
    refuses or fails the request, `TimeoutError` when no result arrives within `wait_s` (the
    queue is backed up or no worker is running)."""
    key = cache_key(req.registry_version, req.hash)
    if hit := await redis.get(key):
        return SimSummary.from_json(hit, cached=True)
    body = {
        "netlist": req.netlist,
        "includes": req.includes,
        "hash": req.hash,
        "registry_version": req.registry_version,
        "timeout_s": req.timeout_s,
    }
    for _ in range(2):
        job = await redis.enqueue_job(TASK, body, _job_id=key, _queue_name=QUEUE, _expires=EXPIRES_S)
        job = job or Job(key, redis, _queue_name=QUEUE, _deserializer=loads)  # already in flight
        try:
            out = await job.result(timeout=wait_s, poll_delay=POLL_S)
            break
        except ResultNotFound:
            # The in-flight job finished and its result expired between the enqueue and the first
            # poll; by now it is cached, or it was a timeout and is enqueued again.
            if hit := await redis.get(key):
                return SimSummary.from_json(hit, cached=True)
    else:
        raise TimeoutError(f"no result for {key}")
    if "err" in out:
        raise SimRefused(out["err"]["code"], out["err"]["message"])
    return SimSummary(**out["ok"])
