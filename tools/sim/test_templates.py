"""Template verification (LLD §12 step 2): every block template, instantiated by circuit-core at its
5 verification points (`Registry.verify_points`) inside its `verify` test bench, compiled exactly as
the editor compiles it (interactive analyses, spec checks as `.meas`) and simulated on the pinned
native ngspice, passes every spec check.

When all of them pass, conftest.py writes `target/registry/registry-<version>.verified.json`:
the registry version and bundle hash that were verified (`verified_registry_version`).
"""

from __future__ import annotations

import json
from typing import Any

import shutil
import subprocess

import circuit_core as cc
import pytest

from circuits import Bench
from ngspice_batch import REGISTRY_DIR, REPO, simulate

WASM = REPO / "third_party" / "ngspice" / "dist" / "wasm" / "ngspice.mjs"
NODE = shutil.which("node")

REG = cc.load_registry_dir(REGISTRY_DIR)
TEMPLATES: dict[str, Any] = json.loads(REG.to_json())["templates"]
POINTS = [(tid, k) for tid in TEMPLATES for k in range(5)]

# template id -> point -> check results; read by conftest.py to write the verified stamp.
RESULTS: dict[str, dict[int, list[dict[str, Any]]]] = {}


def request(tid: str, k: int) -> dict[str, Any]:
    """The insert request for verification point k."""
    t = TEMPLATES[tid]
    point = cc.unwrap(REG.verify_points(tid))[k]
    return {
        "template": tid,
        "targets": point["targets"],
        "ports": {p: {"rail": {"net": t["rails"][p]["net"], "volts": v}} for p, v in point["rails"].items()},
    }


def build(tid: str, k: int) -> tuple[Bench, dict[str, Any]]:
    """The template at verification point k, inside its test bench."""
    t = TEMPLATES[tid]
    point = cc.unwrap(REG.verify_points(tid))[k]
    bench = Bench(REG)
    s = bench.session
    req = request(tid, k)
    ins = cc.unwrap(s.insert_block(json.dumps(req)))
    cc.unwrap(s.apply_ops(json.dumps(ins["ops"]), "template"))
    nets = {p["name"]: p["net"] for p in json.loads(s.snapshot())["blocks"][ins["block"]]["ports"]}
    verify = t.get("verify") or {}
    for port, d in verify.get("drive", {}).items():
        r = cc.unwrap(s.next_refdes("vsource_sine"))
        bench.part(r, "vsource_sine", offset=repr(d.get("offset", 0)), amplitude=repr(d["amplitude"]),
                   frequency=repr(d["frequency"]))
        bench.net(nets[port], f"{r}.P").net("GND", f"{r}.N")
    for port, ohms in verify.get("load", {}).items():
        r = cc.unwrap(s.next_refdes("resistor_th"))
        bench.part(r, "resistor_th", resistance=repr(ohms))
        bench.net(nets[port], f"{r}.1").net("GND", f"{r}.2")
    for port, direction in t["ports"].items():
        if direction == "input":
            assert port in verify.get("drive", {}), f"{tid}: input {port} has no drive in its verify bench"
    return bench, point


@pytest.mark.parametrize(("tid", "k"), POINTS, ids=[f"{t}-{k}" for t, k in POINTS])
def test_template_meets_its_spec(tid: str, k: int):
    bench, point = build(tid, k)
    n = bench.netlist(interactive=True)
    r = simulate(n["text"], n["includes"], hash=n["hash"], timeout_s=10)
    assert r.status == "ok", f"{r.status}\n{r.log[-2000:]}"
    results = cc.unwrap(cc.evaluate_checks(json.dumps(n["checks"]), json.dumps(r.meas)))
    assert len(results) == len(TEMPLATES[tid]["checks"])
    RESULTS.setdefault(tid, {})[k] = results
    failed = [
        f"{c['name']}: target {c['target_display']} ±{c['tol_pct']}%, measured "
        f"{c.get('measured_display') or c.get('note')}"
        for c in results
        if not c["pass"]
    ]
    assert not failed, f"{tid} at {point}: " + "; ".join(failed)


@pytest.mark.skipif(not (WASM.exists() and NODE), reason="ngspice.wasm or node missing")
def test_browser_inserts_and_measures_the_same(tmp_path):
    """The WASM core inserts every template with byte-identical ops, and the browser engine
    (sim.engine.ts on ngspice.wasm, replaying the same .meas cards) passes the same checks."""
    reqs = [request(tid, k) for tid, k in POINTS]
    (tmp_path / "inserts.json").write_text(json.dumps(reqs), encoding="utf-8")
    subprocess.run([NODE, str(REPO / "tools/sim/insert_wasm.mjs"), str(tmp_path / "inserts.json"), str(tmp_path / "inserted.json")],
                   check=True, cwd=REPO)
    wasm_inserts = json.loads((tmp_path / "inserted.json").read_text(encoding="utf-8"))
    for req, theirs in zip(reqs, wasm_inserts, strict=True):
        assert theirs == cc.Session(REG).insert_block(json.dumps(req)), req

    netlists = [build(tid, k)[0].netlist(interactive=True) for tid, k in POINTS]
    sims = [{"netlist": n["text"], "includes": n["includes"], "hash": n["hash"]} for n in netlists]
    (tmp_path / "requests.json").write_text(json.dumps(sims), encoding="utf-8")
    subprocess.run([NODE, str(REPO / "tools/sim/run_wasm.mts"), str(tmp_path / "requests.json"), str(tmp_path / "results.json")],
                   check=True, cwd=REPO)
    results = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))
    for (tid, k), n, r in zip(POINTS, netlists, results, strict=True):
        assert r["status"] == "ok", (tid, k, r["log"][-1000:])
        checks = cc.unwrap(cc.evaluate_checks(json.dumps(n["checks"]), json.dumps(r["meas"])))
        failed = [(c["name"], c.get("measured_display") or c.get("note")) for c in checks if not c["pass"]]
        assert not failed, (tid, k, failed)


def test_solver_values_are_deterministic():
    """The same request gives the same ops (the browser and server must agree byte for byte)."""
    for tid in TEMPLATES:
        req = json.dumps({"template": tid})
        a = cc.Session(REG).insert_block(req)
        b = cc.Session(REG).insert_block(req)
        assert a == b and '"ok"' in a, tid
