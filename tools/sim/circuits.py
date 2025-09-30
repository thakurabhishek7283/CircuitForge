"""Build test circuits through circuit-core (ops -> Session.apply -> compile) and simulate them.

Netlists always come from the circuit-core compiler, never written by hand, so these tests
exercise exactly what the browser and sim_runner will run.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import circuit_core as cc

from sim_runner.ngspice_batch import REPO, SimResult, simulate

DEMO_FIXTURE = REPO / "crates" / "circuit-core" / "tests" / "fixtures" / "demo_sallen_key.json"


class Bench:
    """A user-authored circuit, built op by op."""

    def __init__(self, reg: cc.Registry, snapshot: str | None = None):
        self.session = cc.Session(reg, snapshot)

    def op(self, name: str, body: dict[str, Any]) -> Bench:
        s = self.session
        env = {"v": 1, "seq": s.rev + 1, "op": name, "author": "user", "base_rev": s.rev, "body": body}
        cc.unwrap(s.apply(json.dumps(env)))
        return self

    def part(self, refdes: str, part: str, **params: str) -> Bench:
        return self.op("part.add", {"refdes": refdes, "part": part, "params": params})

    def net(self, net: str, *pins: str, volts: float | None = None) -> Bench:
        body: dict[str, Any] = {"net": net, "pins": list(pins)}
        if volts is not None:
            body["kind"] = {"kind": "power", "volts": volts}
        return self.op("net.connect", body)

    def analyses(self, *analyses: dict[str, Any]) -> Bench:
        return self.op("analysis.set", {"analyses": list(analyses)})

    def netlist(self, **opts: Any) -> dict[str, Any]:
        return cc.unwrap(self.session.compile(json.dumps(opts)))

    def simulate(self, *, extra: str = "", **opts: Any) -> SimResult:
        """Compile and simulate. `extra` cards (e.g. hand-written `.meas`) go before `.end`."""
        n = self.netlist(**opts)
        text = n["text"]
        if extra:
            text = text.replace("\n.end\n", "\n" + extra.strip() + "\n.end\n")
        return simulate(text, n["includes"], hash=n["hash"])


def op() -> dict[str, Any]:
    return {"type": "op"}


def ac(f_start: float, f_stop: float, points_per_decade: int = 50) -> dict[str, Any]:
    return {"type": "ac", "points_per_decade": points_per_decade, "f_start": f_start, "f_stop": f_stop}


def tran(t_step: float, t_stop: float) -> dict[str, Any]:
    return {"type": "tran", "t_step": t_step, "t_stop": t_stop}


def dc(source: str, start: float, stop: float, step: float) -> dict[str, Any]:
    return {"type": "dc", "source": source, "start": start, "stop": stop, "step": step}


def demo_snapshot() -> str:
    return Path(DEMO_FIXTURE).read_text(encoding="utf-8")
