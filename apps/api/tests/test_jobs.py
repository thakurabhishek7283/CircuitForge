"""Generation jobs end to end over a real socket: the SSE stream and its resume, single-writer
editing, cancellation, failures, the timeout, and the reaper (LLD §5, §6, §14)."""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select

from helpers import create_project, envelopes, read_events, user_id
from tutor_api.db.tables import block_attempts, jobs, ops
from tutor_api.jobs import reaper
from tutor_api.jobs.events import alive_key, stream_key
from tutor_api.jobs.runner import Failure
from tutor_api.models.contract import ApiError, ProjectSnapshot
from tutor_api.routers import jobs as jobs_router


@pytest.fixture(autouse=True)
def fresh_script(orchestrator):
    orchestrator.reset()
    yield
    if orchestrator.gate:
        orchestrator.gate.set()  # never leave a job waiting


async def generate(http, headers, pid, prompt="an RC low-pass filter at 1 kHz") -> str:
    r = await http.post(f"/v1/projects/{pid}/generate", json={"prompt": prompt}, headers=headers)
    assert r.status_code == 202, r.text
    return r.json()["job_id"]


async def snapshot(http, headers, pid) -> ProjectSnapshot:
    return ProjectSnapshot.model_validate((await http.get(f"/v1/projects/{pid}", headers=headers)).json())


async def until(predicate, timeout_s: float = 10.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_s
    while not await predicate():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.05)


async def test_a_job_streams_its_block_and_commits_it(http, alice, app):
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    events = await read_events(http, jid, alice)

    names = [e["event"] for e in events]
    assert names[:5] == ["job.state", "job.state", "narration.delta", "narration.delta", "block.ghost"]
    assert names[-2:] == ["job.state", "done"] and events[-2]["data"] == {"state": "done"}
    assert [e["id"] for e in events] == list(range(1, len(events) + 1))
    op_events = [e["data"] for e in events if e["event"] == "op"]
    assert op_events[0]["op"] == "block.begin" and op_events[-1]["op"] == "block.commit"
    assert [o["base_rev"] for o in op_events] == list(range(len(op_events)))
    assert all(o["author"] == "template" and o["job"] == jid and o["block"] == "b1" for o in op_events)
    done = events[-1]["data"]
    assert done == {"rev": len(op_events), "usage": {"in_tokens": 1200, "out_tokens": 300}}

    snap = await snapshot(http, alice, pid)
    assert snap.circuit.rev == snap.project.head_rev == done["rev"] and "b1" in snap.circuit.blocks
    assert snap.active_job is None and [(e.kind, e.block) for e in snap.lesson] == [("narration", "b1")]
    async with app.state.engine.connect() as conn:
        job = (await conn.execute(select(jobs).where(jobs.c.id == uuid.UUID(jid)))).one()
        attempts = (await conn.execute(select(block_attempts).where(block_attempts.c.job_id == job.id))).all()
        authors = (await conn.execute(select(ops.c.author, ops.c.job_id).where(ops.c.project_id == job.project_id))).all()
    assert (job.state, job.model, job.in_tokens, job.error_code) == ("done", "scripted", 1200, None)
    assert job.plan["blocks"][0]["id"] == "b1" and job.finished_at is not None
    assert [(a.block_id, a.attempt) for a in attempts] == [("b1", 1)]
    assert {(a, j) for a, j in authors} == {("template", job.id)}


async def test_a_stream_resumes_after_last_event_id(http, alice):
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    full = await read_events(http, jid, alice)
    tail = await read_events(http, jid, alice, last_event_id=4)
    assert tail == full[4:]
    assert await read_events(http, jid, alice, last_event_id=full[-1]["id"] - 1) == full[-1:]


async def test_the_editor_is_read_only_while_a_job_runs(http, alice, orchestrator, monkeypatch):
    orchestrator.gate = asyncio.Event()
    monkeypatch.setattr(jobs_router, "HEARTBEAT_MS", 200)
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)

    # Everything up to the point the job waits, then a heartbeat (no id: it is not stored).
    head = await read_events(http, jid, alice, stop_at="heartbeat")
    assert head[-1] == {"id": None, "event": "heartbeat", "data": None} and head[-2]["event"] == "op"
    snap = await snapshot(http, alice, pid)
    assert snap.active_job == jid
    r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": snap.project.head_rev, "ops": []}, headers=alice)
    assert r.status_code == 409 and ApiError.model_validate(r.json()).code == "job_running"
    r = await http.post(f"/v1/projects/{pid}/generate", json={"prompt": "another"}, headers=alice)
    assert r.status_code == 409 and ApiError.model_validate(r.json()).code == "job_running"

    orchestrator.gate.set()
    rest = await read_events(http, jid, alice, last_event_id=head[-2]["id"])
    assert rest[-1]["event"] == "done"
    assert (await snapshot(http, alice, pid)).active_job is None
    ok = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": rest[-1]["data"]["rev"], "ops": envelopes(
        [{"op": "part.add", "body": {"refdes": "R9", "part": "resistor_th"}}], rest[-1]["data"]["rev"])}, headers=alice)
    assert ok.status_code == 200, ok.text


async def test_cancel_keeps_committed_blocks(http, alice, orchestrator, app):
    orchestrator.gate = asyncio.Event()  # never set: the job waits until cancelled
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    await until(lambda: _rev_above_zero(http, alice, pid))
    assert (await http.post(f"/v1/jobs/{jid}/cancel", headers=alice)).status_code == 202
    events = await read_events(http, jid, alice)
    assert [e["event"] for e in events[-2:]] == ["job.state", "done"] and events[-2]["data"] == {"state": "cancelled"}
    snap = await snapshot(http, alice, pid)
    assert snap.active_job is None and "b1" in snap.circuit.blocks
    async with app.state.engine.connect() as conn:
        assert (await conn.execute(select(jobs.c.state).where(jobs.c.id == uuid.UUID(jid)))).scalar_one() == "cancelled"
    assert (await http.post(f"/v1/jobs/{jid}/cancel", headers=alice)).status_code == 202  # already over: no-op


async def _rev_above_zero(http, headers, pid) -> bool:
    return (await snapshot(http, headers, pid)).project.head_rev > 0


async def test_a_cancel_from_another_pod_reaches_the_job(http, alice, orchestrator, app):
    """Only the cancel key in Redis, as a pod that does not run the job would set it."""
    orchestrator.gate = asyncio.Event()
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    await until(lambda: _rev_above_zero(http, alice, pid))
    await app.state.redis.set(f"job:{jid}:cancel", "1")
    events = await read_events(http, jid, alice)
    assert events[-2]["data"] == {"state": "cancelled"}


async def test_a_failure_ends_with_an_error_event(http, alice, orchestrator, app):
    orchestrator.fail = Failure("plan_invalid", "no template fits that request")
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    events = await read_events(http, jid, alice)
    assert events[-2]["data"] == {"state": "failed"}
    assert events[-1] == {"id": events[-1]["id"], "event": "error",
                          "data": {"code": "plan_invalid", "message": "no template fits that request", "retryable": False}}
    async with app.state.engine.connect() as conn:
        row = (await conn.execute(select(jobs.c.state, jobs.c.error_code).where(jobs.c.id == uuid.UUID(jid)))).one()
    assert tuple(row) == ("failed", "plan_invalid")


async def test_a_rejected_commit_fails_the_job_and_stores_nothing(http, alice, orchestrator):
    orchestrator.bad_op = True
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    events = await read_events(http, jid, alice)
    assert events[-1]["event"] == "error" and events[-1]["data"]["code"] == "part_not_in_registry"
    assert not any(e["event"] == "op" for e in events)
    assert (await snapshot(http, alice, pid)).project.head_rev == 0


async def test_a_slow_job_times_out(http, alice, orchestrator):
    orchestrator.sleep_s = 30  # the test server's job timeout is 3 s
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    events = await read_events(http, jid, alice)
    assert events[-1]["data"]["code"] == "job_timeout" and events[-1]["data"]["retryable"] is True


async def test_the_reaper_fails_jobs_whose_pod_went_silent(http, alice, app):
    pid = await create_project(http, alice)
    st = app.state
    lost, alive = uuid.uuid4(), uuid.uuid4()
    async with st.engine.begin() as conn:
        for jid, project in ((lost, pid), (alive, await create_project(http, alice))):
            await conn.execute(insert(jobs).values(
                id=jid, project_id=uuid.UUID(project), user_id=uuid.UUID(user_id(alice)), prompt="p", mode="compose",
                state="composing", started_at=datetime.now(UTC) - timedelta(minutes=1)))
    await st.redis.set(alive_key(alive), "1", ex=30)
    assert await reaper.reap_once(st.engine, st.redis, st.events) == [lost]
    assert await reaper.reap_once(st.engine, st.redis, st.events) == []  # once only
    events = await read_events(http, str(lost), alice)
    assert [e["event"] for e in events] == ["job.state", "error"] and events[1]["data"]["code"] == "job_lost"
    await st.redis.delete(alive_key(alive))
    await reaper.reap_once(st.engine, st.redis, st.events)


async def test_an_expired_stream_still_ends_with_the_final_event(http, alice, app):
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    events = await read_events(http, jid, alice)
    await app.state.redis.delete(stream_key(jid))
    assert await read_events(http, jid, alice) == [{"id": None, "event": "done", "data": events[-1]["data"]}]


async def test_another_users_job_does_not_exist(http, alice, bob):
    pid = await create_project(http, alice)
    jid = await generate(http, alice, pid)
    await read_events(http, jid, alice)
    for method, path in [("GET", f"/v1/jobs/{jid}/events"), ("POST", f"/v1/jobs/{jid}/cancel"), ("GET", "/v1/jobs/x/events")]:
        r = await http.request(method, path, headers=bob)
        assert r.status_code == 404 and ApiError.model_validate(r.json()).code == "not_found", (method, path)


async def test_generation_without_an_orchestrator_is_503(http, alice, app, monkeypatch):
    monkeypatch.setattr(app.state.runner, "orchestrator", None)
    pid = await create_project(http, alice)
    r = await http.post(f"/v1/projects/{pid}/generate", json={"prompt": "x"}, headers=alice)
    err = ApiError.model_validate(r.json())
    assert r.status_code == 503 and err.code == "generation_unavailable" and err.retryable


async def test_prompts_are_validated(http, alice):
    pid = await create_project(http, alice)
    for body in ({"prompt": "   "}, {"prompt": "x" * 2001}, {"prompt": "x", "mode": "freestyle"}, {}):
        r = await http.post(f"/v1/projects/{pid}/generate", json=body, headers=alice)
        assert r.status_code == 422 and ApiError.model_validate(r.json()).code == "invalid_request", body


async def test_readiness(http):
    r = await http.get("/readyz")
    assert r.status_code == 200 and r.json() == {"postgres": "ok", "redis": "ok"}
