"""The orchestrator end to end (LLD §6, §15): jobs started over HTTP and read back from the SSE stream,
on Postgres and Redis (testcontainers) with the sim_runner worker simulating every bench on the
native ngspice. Model replies are replayed from cassettes (tests/cassettes, one per test).

Each test's script is the source of its cassette. After changing a prompt or a script, re-record:
`UPDATE_CASSETTES=1 pytest tests/test_orchestrator.py`, and review the cassette diff (a changed
`key` means the prompt changed). Replaying checks that the cassette still holds the script's
replies, so a script edited without re-recording fails.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select

from helpers import create_project, read_events
from tutor_api.db.tables import block_attempts, jobs
from tutor_api.llm.base import LlmRequest, LlmResponse, OnDelta, ProviderError
from tutor_api.llm.cassette import Recorder, Replayer
from tutor_api.llm.fake import FakeProvider
from tutor_api.llm.gateway import Gateway
from tutor_api.models.contract import ProjectSnapshot
from tutor_api.orchestrator import Orchestrator

CASSETTES = Path(__file__).parent / "cassettes"
RECORD = bool(os.environ.get("UPDATE_CASSETTES"))

pytestmark = pytest.mark.usefixtures("sim_worker")


# ---------------------------------------------------------------- scripts

def plan(*blocks: dict[str, Any], links=(), uncovered=()) -> dict[str, Any]:
    return {"blocks": list(blocks), "links": [{"source": s, "target": t} for s, t in links], "uncovered": list(uncovered)}


def block(id: str, template: str, title: str, purpose: str, **targets: str) -> dict[str, Any]:
    return {"id": id, "template": template, "title": title, "purpose": purpose,
            "targets": [{"name": k, "value": v} for k, v in targets.items()]}


def draft(parts: list[tuple[str, str, dict[str, str]]], nets: dict[str, list[str]]) -> dict[str, Any]:
    return {
        "use_template": False,
        "parts": [{"ref": r, "part": p, "params": [{"name": k, "value": v} for k, v in params.items()]} for r, p, params in parts],
        "nets": [{"name": n, "pins": pins} for n, pins in nets.items()],
    }


USE_TEMPLATE = {"use_template": True, "parts": [], "nets": []}
RC_PURPOSE = "R1 and C1 let low frequencies through and send high ones to ground."
RC_2K = plan(block("b1", "rc_lowpass", "Low-pass filter", RC_PURPOSE, fc_hz="2k"))
RC_NETS = {"in": ["R1.1"], "out": ["R1.2", "C1.1"], "gnd": ["C1.2"]}


def rc(r: str = "8.2k", c: str = "10n", nets: dict[str, list[str]] = RC_NETS) -> dict[str, Any]:
    """An RC low-pass draft: 8.2k and 10n put fc at 1.94 kHz."""
    return draft([("R1", "resistor_th", {"resistance": r}), ("C1", "cap_film", {"capacitance": c})], nets)


BAD_PIN = rc(nets={"in": ["R1.1"], "out": ["R1.2", "C1.X"], "gnd": ["C1.2"]})
NARRATION = "This circuit is a low-pass filter. The signal enters a resistor, and a capacitor shunts the fast parts to ground."


# ---------------------------------------------------------------- harness

class Spy:
    """Sees every request, in recording and in replay; can hold calls of one kind on an event."""

    def __init__(self, inner: Any):
        self.inner = inner
        self.name = inner.name
        self.requests: list[LlmRequest] = []
        self.hold: dict[str, tuple[int, asyncio.Event]] = {}  # kind -> (calls let through, gate)

    def of(self, kind: str) -> list[LlmRequest]:
        return [r for r in self.requests if r.kind == kind]

    async def _gate(self, req: LlmRequest) -> None:
        self.requests.append(req)
        if req.kind in self.hold:
            free, gate = self.hold[req.kind]
            if len(self.of(req.kind)) > free:
                await gate.wait()

    async def complete(self, req: LlmRequest) -> LlmResponse:
        await self._gate(req)
        return await self.inner.complete(req)

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        await self._gate(req)
        return await self.inner.stream(req, on_delta)


def replies(script: dict[str, list[Any]]) -> dict[str, list[tuple[str, str]]]:
    return {kind: [("error", r.code) if isinstance(r, ProviderError) else ("text", r if isinstance(r, str) else json.dumps(r))
                   for r in rs] for kind, rs in script.items() if rs}


def recorded(path: Path) -> dict[str, list[tuple[str, str]]]:
    out: dict[str, list[tuple[str, str]]] = {}
    for it in json.loads(path.read_text(encoding="utf-8"))["interactions"]:
        out.setdefault(it["kind"], []).append(("error", it["error"]["code"]) if "error" in it else ("text", it["response"]["text"]))
    return out


@pytest.fixture
def scenario(request, app, monkeypatch):
    """`scenario(script)` installs an orchestrator whose model is the test's cassette (recorded from
    `script` with UPDATE_CASSETTES=1) and returns the Spy in front of it."""
    made: dict[str, Any] = {}
    path = CASSETTES / (re.sub(r"\W+", "_", request.node.name).strip("_") + ".json")

    def make(script: dict[str, list[Any]]) -> Spy:
        if RECORD:
            provider: Any = Recorder(FakeProvider(script))
        else:
            if not path.exists():
                pytest.fail(f"no cassette {path.name}: record it with UPDATE_CASSETTES=1")
            assert recorded(path) == replies(script), f"{path.name} is stale: re-record with UPDATE_CASSETTES=1"
            provider = Replayer.from_file(path)
        spy = Spy(provider)
        monkeypatch.setattr(app.state.runner, "orchestrator", Orchestrator(Gateway(spy, retries=2, backoff_s=0)))
        made.update(provider=provider, spy=spy)
        return spy

    yield make
    if RECORD and made:
        CASSETTES.mkdir(exist_ok=True)
        made["provider"].save(path)


async def run_job(http, headers, prompt: str, *, mode: str | None = None) -> tuple[str, str, list[dict[str, Any]]]:
    pid = await create_project(http, headers)
    body = {"prompt": prompt} | ({"mode": mode} if mode else {})
    r = await http.post(f"/v1/projects/{pid}/generate", json=body, headers=headers)
    assert r.status_code == 202, r.text
    jid = r.json()["job_id"]
    return pid, jid, await read_events(http, jid, headers)


def named(events, name: str) -> list[Any]:
    return [e["data"] for e in events if e["event"] == name]


def states(events) -> list[str]:
    return [d["state"] + (f":{d['block']}" if "block" in d else "") for d in named(events, "job.state")]


async def snapshot(http, headers, pid) -> ProjectSnapshot:
    return ProjectSnapshot.model_validate((await http.get(f"/v1/projects/{pid}", headers=headers)).json())


async def attempts(app, jid: str) -> list[Any]:
    async with app.state.engine.connect() as conn:
        rows = await conn.execute(select(block_attempts).where(block_attempts.c.job_id == jid)
                                  .order_by(block_attempts.c.block_id, block_attempts.c.attempt))
        return rows.all()


async def job_row(app, jid: str) -> Any:
    async with app.state.engine.connect() as conn:
        return (await conn.execute(select(jobs).where(jobs.c.id == jid))).one()


def ops_of(events, block: str) -> list[dict[str, Any]]:
    return [e for e in named(events, "op") if e.get("block") == block]


# ---------------------------------------------------------------- tests

async def test_a_draft_that_passes_first_time_commits(http, alice, app, scenario):
    spy = scenario({"plan": [RC_2K], "narrate": [NARRATION], "compose": [rc()]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")

    assert states(events) == ["queued", "planning", "composing:b1", "verifying:b1", "committing:b1", "done"]
    names = [e["event"] for e in events]
    assert names[-1] == "done" and "error" not in names
    # The introduction streams before the first op; the block's purpose follows its commit.
    intro = [d["text"] for d in named(events, "narration.delta") if "block" not in d]
    assert "".join(intro) == NARRATION
    assert max(i for i, e in enumerate(events) if e["event"] == "narration.delta" and "block" not in e["data"]) < names.index("op")
    assert names.index("block.ghost") < names.index("op")
    assert named(events, "block.ghost") == [{"id": "b1", "title": "RC low-pass filter", "role": "filter",
                                             "ports": [{"name": "in", "direction": "input"},
                                                       {"name": "out", "direction": "output"},
                                                       {"name": "gnd", "direction": "ground"}]}]

    ops = ops_of(events, "b1")
    assert [o["op"] for o in ops][0] == "block.begin" and ops[-1]["op"] == "block.commit"
    assert {o["author"] for o in ops} == {"llm"} and all(o["job"] == jid for o in ops)
    adds = {o["body"]["refdes"]: o["body"]["params"] for o in ops if o["op"] == "part.add"}
    assert adds == {"R1": {"resistance": "8.2k"}, "C1": {"capacitance": "10n"}}
    (summary,) = named(events, "sim.summary")
    (fc,) = summary["checks"]
    assert summary["block"] == "b1" and fc["name"] == "fc_hz" and fc["pass"]
    assert abs(fc["measured"] - 1941) / 1941 < 0.03, fc
    done = named(events, "done")[0]
    assert done["usage"]["in_tokens"] > 0 and done["usage"]["out_tokens"] > 0

    snap = await snapshot(http, alice, pid)
    assert snap.project.head_rev == done["rev"] == len(ops) and snap.active_job is None
    assert list(snap.circuit.blocks) == ["b1"]
    assert [(e.kind.value, e.block, e.text) for e in snap.lesson] == [
        ("narration", None, NARRATION), ("narration", "b1", RC_PURPOSE)]
    assert snap.lesson[1].refs == ["C1", "R1"]

    (a,) = await attempts(app, jid)
    assert (a.block_id, a.attempt, a.errors) == ("b1", 1, [])
    assert a.ops[0]["draft"]["template"] == "rc_lowpass" and a.ops[0]["draft"]["targets"] == {"fc_hz": "2k"}
    assert a.sim_checks[0]["pass"] and a.latency_ms >= 0
    row = await job_row(app, jid)
    assert row.plan["blocks"][0]["outcome"] == {"how": "draft", "attempts": 1, "errors": []}
    assert row.model == "fake-large" and row.in_tokens == done["usage"]["in_tokens"]

    # One stable prefix for the large model's calls (the provider caches it), a short one for the
    # narrator; the composer's part enum is per block.
    assert spy.of("plan")[0].system == spy.of("compose")[0].system != spy.of("narrate")[0].system
    assert "resistor_th (R)" in spy.of("compose")[0].system and "resistor_th" not in spy.of("narrate")[0].system
    assert "It teaches: C shorts high frequencies to ground" in spy.of("narrate")[0].user
    (compose,) = spy.of("compose")
    assert compose.tier == "large" and spy.of("narrate")[0].tier == "small"
    assert compose.schema["properties"]["parts"]["items"]["properties"]["part"]["enum"] == [
        "cap_elec", "cap_film", "inductor", "opamp_lm358", "opamp_tl072", "resistor_th"]
    assert "Targets: fc_hz = 2kHz." in compose.user and "R1 resistor_th resistance=" in compose.user


async def test_a_wrong_pin_is_repaired(http, alice, app, scenario):
    spy = scenario({"plan": [RC_2K], "narrate": [NARRATION], "compose": [BAD_PIN, rc()]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")

    assert states(events) == ["queued", "planning", "composing:b1", "verifying:b1", "repairing:b1", "composing:b1",
                              "verifying:b1", "committing:b1", "done"]
    assert named(events, "block.repair") == [{"id": "b1", "attempt": 1, "errors": ["pin_not_found"]}]
    retry = spy.of("compose")[1].user
    assert "Your previous attempt:\n" + json.dumps(BAD_PIN) in retry
    assert "- pin_not_found (net out): C1 (cap_film) has no pin X; its pins are 1 2" in retry
    first, second = await attempts(app, jid)
    assert [e["code"] for e in first.errors] == ["pin_not_found"] and first.sim_checks is None
    assert second.errors == [] and second.sim_checks[0]["pass"]
    snap = await snapshot(http, alice, pid)
    assert [(e.kind.value, e.text) for e in snap.lesson if e.kind.value == "repair"] == [
        ("repair", "Low-pass filter: draft 1 had a wiring problem (C1 (cap_film) has no pin X; its pins are 1 2).")]
    assert (await job_row(app, jid)).plan["blocks"][0]["outcome"] == {
        "how": "draft", "attempts": 2, "errors": [["pin_not_found"]]}


async def test_a_spec_miss_goes_back_with_the_measured_value(http, alice, app, scenario):
    spy = scenario({"plan": [RC_2K], "narrate": [NARRATION], "compose": [rc(r="82k"), rc()]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")

    assert named(events, "block.repair") == [{"id": "b1", "attempt": 1, "errors": ["spec_miss"]}]
    retry = spy.of("compose")[1].user
    # 82k and 10n put the corner near 194 Hz, below where the check reads its pass band (a tenth of
    # the target), so the check measures it as 352 Hz: far off either way.
    miss = re.search(r"- spec_miss \(check fc_hz\): Cutoff \(−3 dB\): target 2kHz ±10%, measured (\d+)Hz", retry)
    assert miss and int(miss.group(1)) < 500, retry
    first, second = await attempts(app, jid)
    assert not first.sim_checks[0]["pass"] and second.sim_checks[0]["pass"]
    (summary,) = named(events, "sim.summary")
    assert summary["checks"][0]["pass"]


async def test_replies_that_break_the_schema_are_attempts(http, alice, app, scenario):
    spy = scenario({"plan": [RC_2K], "narrate": [NARRATION],
                    "compose": ["Sure! Here is the block: R1 to C1.", {"use_template": "maybe", "parts": [], "nets": []},
                                USE_TEMPLATE]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")

    assert [d["errors"] for d in named(events, "block.repair")] == [["schema_error"], ["schema_error"]]
    second = spy.of("compose")[1].user
    assert "Your previous attempt:\nSure! Here is the block: R1 to C1." in second
    assert "- schema_error: the reply is not JSON" in second
    third = spy.of("compose")[2].user
    assert "use_template: Input should be a valid boolean" in third
    rows = await attempts(app, jid)
    assert [r.ops for r in rows[:2]] == [[{"reply": "Sure! Here is the block: R1 to C1."}],
                                         [{"reply": json.dumps({"use_template": "maybe", "parts": [], "nets": []})}]]
    assert rows[2].ops == [{"template": {"template": "rc_lowpass", "targets": {"fc_hz": "2k"}, "ports": {}, "id": "b1"}}]
    # The model chose the template: solver values, author `template`, and not a fallback.
    assert {o["author"] for o in ops_of(events, "b1")} == {"template"}
    assert (await job_row(app, jid)).plan["blocks"][0]["outcome"]["how"] == "use_template"


async def test_three_failed_drafts_fall_back_to_the_template(http, alice, app, scenario):
    scenario({"plan": [RC_2K], "narrate": [NARRATION], "compose": [BAD_PIN, BAD_PIN, rc(r="82k")]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")

    assert states(events)[-4:] == ["repairing:b1", "fallback:b1", "committing:b1", "done"]
    assert [d["attempt"] for d in named(events, "block.repair")] == [1, 2, 3]
    assert len(await attempts(app, jid)) == 3
    ops = ops_of(events, "b1")
    assert {o["author"] for o in ops} == {"template"}
    assert named(events, "sim.summary")[0]["checks"][0]["pass"]
    snap = await snapshot(http, alice, pid)
    assert ("note", "b1", "Used the standard RC low-pass filter for this stage.") in [
        (e.kind.value, e.block, e.text) for e in snap.lesson]
    assert (await job_row(app, jid)).plan["blocks"][0]["outcome"] == {
        "how": "fallback", "attempts": 3, "errors": [["pin_not_found"], ["pin_not_found"], ["spec_miss"]],
        "why": "attempts"}


async def test_a_replanned_two_block_circuit_links_source_to_filter(http, alice, app, scenario):
    bad = plan(block("b1", "sine_source", "Signal", "A test signal.", freq_hz="300"),
               block("b2", "rc_lowpass", "Filter", "The filter.", fc_hz="500k"),
               links=[("b1.out", "b2.gnd")])
    good = plan(block("b1", "sine_source", "Signal", "V1 makes a 300 Hz sine wave to test the filter with.", freq_hz="300"),
                block("b2", "rc_lowpass", "Filter", RC_PURPOSE, fc_hz="2k"),
                links=[("b1.out", "b2.in")])
    spy = scenario({"plan": [bad, good], "narrate": [NARRATION], "compose": [USE_TEMPLATE, rc()]})
    pid, jid, events = await run_job(http, alice, "a sine source driving an RC low-pass at 2 kHz")

    replan = spy.of("plan")[1].user
    assert "Your previous plan:\n" in replan
    assert "- link b1.out -> b2.gnd: b2.gnd is ground, not an input; power and ground join through the rails" in replan
    assert [g["id"] for g in named(events, "block.ghost")] == ["b1", "b2"]
    assert named(events, "done")
    snap = await snapshot(http, alice, pid)
    b1, b2 = snap.circuit.blocks["b1"], snap.circuit.blocks["b2"]
    assert {p.name: p.net for p in b2.ports}["in"] == {p.name: p.net for p in b1.ports}["out"] == "B1_OUT"
    # The filter's prompt says what drives its input.
    assert "in → b1.out (net B1_OUT)" in spy.of("compose")[1].user
    row = await job_row(app, jid)
    assert row.plan["rounds"] == 2 and [b["outcome"]["how"] for b in row.plan["blocks"]] == ["use_template", "draft"]


async def test_a_plan_that_stays_invalid_fails_the_job(http, alice, app, scenario):
    bad = plan(block("b1", "rc_lowpass", "Filter", "The filter.", fc_hz="500k"))
    spy = scenario({"plan": [bad, bad, bad]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass at 500 kHz")

    assert len(spy.of("plan")) == 3 and not spy.of("compose")
    (err,) = named(events, "error")
    assert err["code"] == "plan_invalid" and err["retryable"] and "Cutoff frequency must be 10Hz to 100kHz" in err["message"]
    assert not named(events, "op") and (await snapshot(http, alice, pid)).project.head_rev == 0


async def test_a_request_no_template_covers_is_unsupported(http, alice, app, scenario):
    out_of_scope = plan(uncovered=["a microcontroller that reads the temperature"])
    scenario({"plan": [out_of_scope] * 3})
    pid, jid, events = await run_job(http, alice, "an Arduino thermometer")

    (err,) = named(events, "error")
    assert err["code"] == "unsupported_request" and not err["retryable"] and "microcontroller" in err["message"]


@pytest.mark.parametrize("code", ["server_error", "timeout"])
async def test_a_composer_that_does_not_answer_falls_back(http, alice, app, scenario, code):
    """LLD §14: 30 s call timeout or 5xx: retried twice, then the template."""
    down = ProviderError(code, "no answer", retryable=True)
    spy = scenario({"plan": [RC_2K], "narrate": [NARRATION], "compose": [down] * 3})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")

    assert len(spy.of("compose")) == 3 and not named(events, "block.repair")
    assert states(events)[-4:] == ["composing:b1", "fallback:b1", "committing:b1", "done"]
    assert await attempts(app, jid) == []
    assert (await job_row(app, jid)).plan["blocks"][0]["outcome"] == {
        "how": "fallback", "attempts": 0, "errors": [], "why": "llm_unavailable"}


async def test_a_planner_that_does_not_answer_fails_retryable(http, alice, app, scenario):
    scenario({"plan": [ProviderError("rate_limited", "quota", retryable=True)] * 3})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")
    (err,) = named(events, "error")
    assert err["code"] == "llm_unavailable" and err["retryable"]


async def test_a_job_over_its_time_limit_fails(http, alice, app, scenario):
    """The test server's job timeout is 3 s; the composer never answers."""
    spy = scenario({"plan": [RC_2K], "narrate": [NARRATION]})
    spy.hold["compose"] = (0, asyncio.Event())
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz")
    (err,) = named(events, "error")
    assert err["code"] == "job_timeout" and err["retryable"]
    assert states(events)[-1] == "failed" and not named(events, "op")


async def test_cancel_keeps_the_blocks_already_committed(http, alice, app, scenario):
    two = plan(block("b1", "sine_source", "Signal", "A 300 Hz test signal.", freq_hz="300"),
               block("b2", "rc_lowpass", "Filter", RC_PURPOSE, fc_hz="2k"), links=[("b1.out", "b2.in")])
    spy = scenario({"plan": [two], "narrate": [NARRATION], "compose": [USE_TEMPLATE]})
    gate = asyncio.Event()
    spy.hold["compose"] = (1, gate)  # the second block's composer waits
    pid = await create_project(http, alice)
    r = await http.post(f"/v1/projects/{pid}/generate", json={"prompt": "a sine into a 2 kHz low-pass"}, headers=alice)
    jid = r.json()["job_id"]
    first = await read_events(http, jid, alice, stop_at="sim.summary")
    await asyncio.sleep(0.2)  # into the second block's compose call
    assert (await http.post(f"/v1/jobs/{jid}/cancel", headers=alice)).status_code == 202
    rest = await read_events(http, jid, alice, last_event_id=first[-1]["id"])
    gate.set()

    events = first + rest
    assert states(events)[-2:] == ["composing:b2", "cancelled"] and named(events, "done")
    assert [g["id"] for g in named(events, "block.ghost")] == ["b1", "b2"] and not ops_of(events, "b2")
    snap = await snapshot(http, alice, pid)
    assert list(snap.circuit.blocks) == ["b1"] and snap.active_job is None


async def test_template_mode_plans_small_and_never_composes(http, alice, app, scenario):
    """GenerateRequest.mode = templates (the spend breaker's mode, LLD §13). The narrator fails
    here too, which costs the lesson its introduction and nothing else."""
    spy = scenario({"plan": [RC_2K], "narrate": [ProviderError("auth", "bad key", retryable=False)]})
    pid, jid, events = await run_job(http, alice, "an RC low-pass filter at 2 kHz", mode="templates")

    assert spy.of("plan")[0].tier == "small" and not spy.of("compose")
    assert states(events) == ["queued", "planning", "verifying:b1", "committing:b1", "done"]
    assert {o["author"] for o in ops_of(events, "b1")} == {"template"}
    assert named(events, "sim.summary")[0]["checks"][0]["pass"]
    snap = await snapshot(http, alice, pid)
    assert [(e.kind.value, e.block) for e in snap.lesson] == [("narration", "b1")]
    assert (await job_row(app, jid)).plan["blocks"][0]["outcome"] == {"how": "template_mode", "attempts": 0}
