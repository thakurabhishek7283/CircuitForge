"""Template benches compiled by circuit-core, as the API's verifier gets them."""

from __future__ import annotations

import json
from typing import Any

import circuit_core as cc

from sim_runner.protocol import SimRequest


def bench(reg: cc.Registry, template: str, point: int | None = None) -> dict[str, Any]:
    """A template block's verification bench, as the API gets it: `trial_block(...).bench`. At
    verification point `point`, or at the template's default targets."""
    insert: dict[str, Any] = {"template": template}
    if point is not None:
        t = json.loads(reg.to_json())["templates"][template]
        p = cc.unwrap(reg.verify_points(template))[point]
        insert["targets"] = p["targets"]
        insert["ports"] = {k: {"rail": {"net": t["rails"][k]["net"], "volts": v}} for k, v in p["rails"].items()}
    trial = cc.unwrap(cc.Session(reg).trial_block(json.dumps({"template": insert})))
    assert trial["problems"] == [], trial["problems"]
    return trial["bench"]


def request(netlist: dict[str, Any], version: str, **kw: Any) -> SimRequest:
    return SimRequest(netlist["text"], netlist["includes"], netlist["hash"], version, **kw)
