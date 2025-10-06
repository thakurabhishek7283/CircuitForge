"""Projects, the op log and tenancy (LLD §5, §11, §14)."""

from __future__ import annotations

import json
import uuid

import circuit_core as cc
from sqlalchemy import select

from helpers import create_project, envelopes
from tutor_api.db.tables import ops as ops_table
from tutor_api.db.tables import projects as projects_table
from tutor_api.models.contract import ApiError, AppendOk, Project, ProjectSnapshot

RC = [
    {"op": "part.add", "body": {"refdes": "R1", "part": "resistor_th", "params": {"resistance": "1k"}}},
    {"op": "part.add", "body": {"refdes": "C1", "part": "cap_film", "params": {"capacitance": "100n"}}},
    {"op": "net.connect", "body": {"net": "N_OUT", "pins": ["R1.2", "C1.1"]}},
]


def error(r) -> ApiError:
    return ApiError.model_validate(r.json())


async def test_every_route_needs_a_valid_token(http, alice):
    r = await http.post("/v1/projects")
    assert r.status_code == 401 and error(r).code == "unauthorized"
    r = await http.post("/v1/projects", headers={"Authorization": "Bearer nonsense"})
    assert r.status_code == 401 and error(r).code == "unauthorized"
    forged = alice["Authorization"][:-4] + "AAAA"
    assert (await http.post("/v1/projects", headers={"Authorization": forged})).status_code == 401


async def test_create_and_open_a_project(http, alice, app):
    r = await http.post("/v1/projects", json={"title": "  My filter "}, headers=alice)
    assert r.status_code == 201
    p = Project.model_validate(r.json())
    assert p.title == "My filter" and p.head_rev == 0 and p.registry_version == app.state.regs.current.version
    snap = ProjectSnapshot.model_validate((await http.get(f"/v1/projects/{p.id}", headers=alice)).json())
    assert snap.circuit.rev == 0 and snap.circuit.registry_version == p.registry_version
    assert snap.lesson == [] and snap.active_job is None and snap.project == p
    untitled = Project.model_validate((await http.post("/v1/projects", headers=alice)).json())
    assert untitled.title == "Untitled circuit"


async def test_user_ops_are_applied_by_the_core_and_stored(http, alice):
    pid = await create_project(http, alice)
    r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": 0, "ops": envelopes(RC, 0)}, headers=alice)
    assert r.status_code == 200, r.text
    assert AppendOk.model_validate(r.json()).rev == 3
    snap = ProjectSnapshot.model_validate((await http.get(f"/v1/projects/{pid}", headers=alice)).json())
    assert snap.project.head_rev == snap.circuit.rev == 3
    assert set(snap.circuit.parts) == {"R1", "C1"}
    assert sorted(p.root for p in snap.circuit.nets["N_OUT"].pins) == ["C1.1", "R1.2"]


async def test_a_stale_base_rev_is_409(http, alice):
    pid = await create_project(http, alice)
    await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": 0, "ops": envelopes(RC[:1], 0)}, headers=alice)
    r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": 0, "ops": envelopes(RC[1:2], 0)}, headers=alice)
    assert r.status_code == 409 and error(r).code == "stale_rev"


async def test_a_rejected_op_stores_nothing(http, alice, app):
    pid = await create_project(http, alice)
    bad = RC[:1] + [{"op": "part.add", "body": {"refdes": "Q1", "part": "no_such_part"}}]
    r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": 0, "ops": envelopes(bad, 0)}, headers=alice)
    assert r.status_code == 422 and error(r).code == "part_not_in_registry" and error(r).message.startswith("op 1:")
    async with app.state.engine.connect() as conn:
        head = (await conn.execute(select(projects_table.c.head_rev).where(projects_table.c.id == uuid.UUID(pid)))).scalar_one()
        stored = (await conn.execute(select(ops_table.c.seq).where(ops_table.c.project_id == uuid.UUID(pid)))).all()
    assert head == 0 and stored == []


async def test_users_cannot_write_llm_ops_or_narration(http, alice):
    pid = await create_project(http, alice)
    cases = [
        (envelopes(RC[:1], 0, author="llm"), "author_invalid"),
        ([envelopes(RC[:1], 0)[0] | {"job": "j_1"}], "job_invalid"),
        (envelopes([{"op": "narrate", "body": {"refs": [], "text": "hi"}}], 0), "unknown_op"),
    ]
    for batch, code in cases:
        r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": 0, "ops": batch}, headers=alice)
        assert r.status_code == 422 and error(r).code == code, r.text
    r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": 0, "ops": [], "extra": 1}, headers=alice)
    assert r.status_code == 422 and error(r).code == "invalid_request"


async def test_another_users_project_does_not_exist(http, alice, bob):
    pid = await create_project(http, alice)
    for method, path, body in [
        ("GET", f"/v1/projects/{pid}", None),
        ("POST", f"/v1/projects/{pid}/ops", {"base_rev": 0, "ops": envelopes(RC[:1], 0)}),
        ("POST", f"/v1/projects/{pid}/generate", {"prompt": "an RC filter"}),
        ("GET", "/v1/projects/not-a-uuid", None),
    ]:
        r = await http.request(method, path, json=body, headers=bob)
        assert r.status_code == 404 and error(r).code == "not_found", (method, path, r.text)
    assert (await http.get(f"/v1/projects/{pid}", headers=alice)).status_code == 200


async def test_snapshots_fold_to_the_same_circuit_in_the_same_order(http, alice, app):
    """Every 5 ops (test setting) the project is snapshotted; a reload from snapshot + later ops is
    the circuit the client built, part order included (snapshots are `json`, not `jsonb`)."""
    local = cc.Session(app.state.regs.current)
    ins = cc.unwrap(local.insert_block(json.dumps({"template": "sallen_key_lp"})))
    batches = [(ins["ops"], "template"), ([{"op": "part.add", "body": {"refdes": "R10", "part": "resistor_th"}}], "user"),
               ([{"op": "part.add", "body": {"refdes": "C9", "part": "cap_film"}}], "user")]
    pid = await create_project(http, alice)
    rev = 0
    for ops, author in batches:
        batch = envelopes(ops, rev, author)
        for env in batch:
            cc.unwrap(local.apply(json.dumps(env)))
        r = await http.post(f"/v1/projects/{pid}/ops", json={"base_rev": rev, "ops": batch}, headers=alice)
        assert r.status_code == 200, r.text
        rev = r.json()["rev"]
    async with app.state.engine.connect() as conn:
        row = (await conn.execute(select(projects_table).where(projects_table.c.id == uuid.UUID(pid)))).one()
    assert row.snapshot_rev >= 5 and row.snapshot_rev < row.head_rev == local.rev
    served = (await http.get(f"/v1/projects/{pid}", headers=alice)).json()["circuit"]
    assert json.dumps(served) == json.dumps(json.loads(local.snapshot()))
    assert list(served["parts"])[-2:] == ["R10", "C9"]
