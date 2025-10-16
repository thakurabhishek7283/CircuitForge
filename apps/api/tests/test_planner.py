"""Plan validation on its own (no model, no databases): every problem a re-plan is asked to fix, and
the plan a valid one becomes (commit order, block ids, links as port bindings)."""

from __future__ import annotations

import json

import circuit_core as cc
import pytest

from tutor_api.config import REPO
from tutor_api.llm.prompts import Prompts
from tutor_api.orchestrator.planner import validate
from tutor_api.orchestrator.schemas import plan_model


@pytest.fixture(scope="module")
def reg() -> cc.Registry:
    return cc.load_registry_dir(REPO / "registry")


@pytest.fixture(scope="module")
def prompts(reg) -> Prompts:
    return Prompts(reg)


def raw(prompts, blocks, links=(), uncovered=()):
    model = plan_model(tuple(prompts.templates))
    return model.model_validate({
        "blocks": [{"title": "", "purpose": "", "targets": []} | b for b in blocks],
        "links": [{"source": s, "target": t} for s, t in links],
        "uncovered": list(uncovered),
    })


def targets(**kw):
    return [{"name": k, "value": v} for k, v in kw.items()]


def test_a_valid_plan_commits_sources_first_with_their_links_bound(reg, prompts):
    session = cc.Session(reg)
    p = raw(prompts, [
        {"id": "b1", "template": "sallen_key_lp", "title": "Filter", "targets": targets(fc_hz="2k")},
        {"id": "b2", "template": "sine_source", "title": "Signal", "targets": targets(freq_hz="500")},
    ], links=[("b2.out", "b1.in")])
    v = validate(p, session, prompts, 1)
    assert v.problems == [] and v.uncovered == []
    first, second = v.plan.blocks
    # The source commits first, and blocks are numbered in commit order.
    assert (first.plan_id, first.id, first.template) == ("b2", "b1", "sine_source")
    assert (second.plan_id, second.id, second.inputs) == ("b1", "b2", {"in": ("b1", "out")})
    assert second.ghost() == {
        "id": "b2", "title": "Sallen-Key low-pass (2nd order)", "role": "filter",
        "ports": [{"name": n, "direction": d} for n, d in [("in", "input"), ("out", "output"), ("vcc", "power_pos"),
                                                           ("vee", "power_neg"), ("gnd", "ground")]],
    }
    assert session.rev == 0  # validation built the plan in a fork


def test_block_ids_continue_after_the_circuits_own(reg, prompts):
    session = cc.Session(reg)
    ops = cc.unwrap(session.insert_block(json.dumps({"template": "rc_lowpass"})))["ops"]
    cc.unwrap(session.apply_ops(json.dumps(ops), "template"))
    v = validate(raw(prompts, [{"id": "b1", "template": "inverting_amp"}]), session, prompts, 1)
    assert v.plan.blocks[0].id == "b2" and v.plan.blocks[0].plan_id == "b1"


@pytest.mark.parametrize(
    "blocks, links, problem",
    [
        ([], [], "the plan has no blocks"),
        ([{"id": "x1", "template": "rc_lowpass"}], [], "block id 'x1' is not b1, b2, ..."),
        ([{"id": "b1", "template": "rc_lowpass"}, {"id": "b1", "template": "rc_highpass"}], [], "two blocks are called b1"),
        ([{"id": "b1", "template": "rc_lowpass", "targets": targets(fc_hz="1k") * 2}], [], "b1: target fc_hz is given twice"),
        ([{"id": "b1", "template": "rc_lowpass", "targets": targets(fc_hz="500k")}], [],
         "b1 (rc_lowpass): Cutoff frequency must be 10Hz to 100kHz"),
        ([{"id": "b1", "template": "rc_lowpass", "targets": targets(q="2")}], [], "b1 (rc_lowpass): rc_lowpass has no target q"),
        ([{"id": "b1", "template": "rc_lowpass"}], [("b1.out", "b2.in")], "link b1.out -> b2.in: there is no block b2"),
        ([{"id": "b1", "template": "rc_lowpass"}, {"id": "b2", "template": "rc_highpass"}], [("b1.in", "b2.in")],
         "link b1.in -> b2.in: b1.in is input, not an output"),
        ([{"id": "b1", "template": "rc_lowpass"}, {"id": "b2", "template": "rc_highpass"}], [("b1.out", "b2.gnd")],
         "link b1.out -> b2.gnd: b2.gnd is ground, not an input; power and ground join through the rails"),
        ([{"id": "b1", "template": "rc_lowpass"}, {"id": "b2", "template": "rc_highpass"}], [("b1.out", "b2.input")],
         "link b1.out -> b2.input: b2 (rc_highpass) has no port input; its ports are in out gnd"),
        ([{"id": "b1", "template": "rc_lowpass"}], [("b1", "b1.in")], "link b1 -> b1.in: write ports as block.port, e.g. b1.out"),
        ([{"id": "b1", "template": "rc_lowpass"}, {"id": "b2", "template": "rc_highpass"}, {"id": "b3", "template": "sine_source"}],
         [("b1.out", "b2.in"), ("b3.out", "b2.in")], "b2.in is linked twice"),
        ([{"id": "b1", "template": "rc_lowpass"}, {"id": "b2", "template": "rc_highpass"}],
         [("b1.out", "b2.in"), ("b2.out", "b1.in")], "the links make a loop through b1, b2"),
    ],
)
def test_plan_problems(reg, prompts, blocks, links, problem):
    v = validate(raw(prompts, blocks, links), cc.Session(reg), prompts, 1)
    assert v.plan is None and problem in v.problems, v.problems


def test_a_rail_the_circuit_holds_at_another_voltage_is_a_plan_problem(reg, prompts):
    """A divider on a 5 V VCC, then a Sallen-Key that needs VCC at 9..15 V."""
    session = cc.Session(reg)
    ops = cc.unwrap(session.insert_block(json.dumps({"template": "divider_bias", "ports": {"vcc": {"rail": {"net": "VCC", "volts": 5}}}})))["ops"]
    cc.unwrap(session.apply_ops(json.dumps(ops), "template"))
    v = validate(raw(prompts, [{"id": "b1", "template": "sallen_key_lp"}]), session, prompts, 1)
    assert v.plan is None and any(p.startswith("b1 (sallen_key_lp):") and "VCC" in p for p in v.problems), v.problems


def test_uncovered_needs_are_reported_separately(reg, prompts):
    v = validate(raw(prompts, [{"id": "b1", "template": "rc_lowpass"}], uncovered=["a microcontroller"]),
                 cc.Session(reg), prompts, 1)
    assert v.problems == [] and v.plan is not None
    assert v.uncovered == ["no template builds 'a microcontroller': leave it out of the request, or plan it from the templates"]
