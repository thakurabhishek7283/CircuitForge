"""The verifier (LLD §6, §7): a block request is trial-built by circuit-core (draft checks, `apply()`,
ERC in the block's verification bench), its bench is simulated by sim_runner, and its `.meas`
results become spec checks. Every reason it cannot commit is an error the composer sees."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

import circuit_core as cc
from redis.asyncio import Redis
from sim_runner import client as sim_client
from sim_runner.protocol import SimRefused, SimRequest

from ..jobs.runner import Failure

SIM_WAIT_S = 10.0  # queue wait plus the 2 s run (LLD §1); beyond this the sim service is down


@dataclass
class Verdict:
    trial: dict[str, Any]
    errors: list[dict[str, Any]]  # {code, message, at?}; empty: the block may commit
    checks: list[dict[str, Any]] | None  # spec check results, when the bench simulated


def failed_checks(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`spec_miss` per failed check, with the measured value (LLD §7)."""
    out = []
    for c in checks:
        if c["pass"]:
            continue
        target = f"{c.get('target_display') or c['target']} ±{c['tol_pct']:g}%"
        if c.get("measured") is None:
            got = f"not measured ({c['note']})" if c.get("note") else "not measured"
        else:
            got = f"measured {c.get('measured_display') or c['measured']}"
        out.append({"code": "spec_miss", "message": f"{c['label']}: target {target}, {got}", "at": f"check {c['name']}"})
    return out


async def verify(session: cc.Session, request: dict[str, Any], *, job: str, redis: Redis,
                 registry_version: str) -> Verdict:
    trial = cc.unwrap(await asyncio.to_thread(session.trial_block, json.dumps(request), job))
    if trial["problems"]:
        return Verdict(trial, trial["problems"], None)
    bench = trial["bench"]
    req = SimRequest(bench["text"], bench["includes"], bench["hash"], registry_version)
    try:
        sim = await sim_client.simulate(redis, req, wait_s=SIM_WAIT_S)
    except TimeoutError:
        raise Failure("sim_unavailable", "the simulation service did not answer", retryable=True) from None
    except SimRefused as e:
        raise Failure("sim_refused", f"the simulation service refused the bench: {e.code}: {e.message}") from None
    if sim.status != "ok":
        lines = [ln.strip() for ln in sim.log.splitlines() if ln.strip()]
        why = next((ln for ln in reversed(lines) if "error" in ln.lower() or "abort" in ln.lower()), "")
        return Verdict(trial, [{"code": f"sim_{sim.status}", "message": f"the bench simulation failed ({sim.status}) {why}".strip()}], None)
    checks = cc.unwrap(cc.evaluate_checks(json.dumps(bench["checks"]), json.dumps(sim.meas)))
    return Verdict(trial, failed_checks(checks), checks)
