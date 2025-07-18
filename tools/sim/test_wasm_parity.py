"""Cross-runtime simulation parity (LLD §8: the same pinned ngspice in the browser and on the
server). Every netlist the native bench tests simulate is run again through the browser engine
(apps/web/src/workers/sim.engine.ts on ngspice.wasm, in Node) and the results must agree."""

import json
import math
import os
import shutil
import subprocess

import pytest

import circuits
import test_demo
import test_parts
from ngspice_batch import REPO, simulate as native_simulate

WASM = REPO / "third_party" / "ngspice" / "dist" / "wasm" / "ngspice.mjs"
RUNNER = REPO / "tools" / "sim" / "run_wasm.mts"
NODE = shutil.which("node")

if not (WASM.exists() and NODE) and os.environ.get("REQUIRE_NGSPICE"):
    raise RuntimeError("ngspice.wasm or node missing: run third_party/ngspice/build-wasm.sh")
pytestmark = pytest.mark.skipif(not (WASM.exists() and NODE), reason="ngspice.wasm not built")


def bench_netlists(reg):
    """Run every bench test with the native simulator, recording what it simulated."""
    cases = []

    def recording(netlist, includes, **kw):
        r = native_simulate(netlist, includes, **kw)
        cases.append(({"netlist": netlist, "includes": includes, "hash": kw.get("hash", "")}, r))
        return r

    circuits.simulate, original = recording, circuits.simulate
    try:
        for module in (test_parts, test_demo):
            for name in sorted(dir(module)):
                test = getattr(module, name)
                if name.startswith("test_") and callable(test) and test.__code__.co_varnames[:1] == ("reg",):
                    test(reg)
    finally:
        circuits.simulate = original
    return cases


# Both engines solve to the deck's reltol=1e-3, so they agree only to about that: compilers end
# Newton iterations at slightly different iterates. Measured worst cases (2026-10, ngspice 47,
# all benches): 3.5e-5 of a vector's full scale (inside the LM358 clamp), 1.9e-5 for .meas.
VECTOR_TOL = 2e-4  # of the vector's full scale
MEAS_TOL = 1e-3  # relative, = reltol


def close(a: float, b: float, rel: float, abs_: float) -> bool:
    return math.isclose(a, b, rel_tol=rel, abs_tol=abs_)


def test_wasm_matches_native(reg, tmp_path):
    cases = bench_netlists(reg)
    assert len(cases) >= 15
    (tmp_path / "requests.json").write_text(json.dumps([req for req, _ in cases]), encoding="utf-8")
    subprocess.run(
        [NODE, str(RUNNER), str(tmp_path / "requests.json"), str(tmp_path / "results.json")],
        check=True,
        cwd=REPO,
    )
    wasm_results = json.loads((tmp_path / "results.json").read_text(encoding="utf-8"))

    for (req, native), wasm in zip(cases, wasm_results, strict=True):
        where = req["netlist"].splitlines()[1:4]
        assert wasm["status"] == native.status, (where, wasm["log"][-2000:])
        assert wasm["hash"] == native.hash
        # Fixed grids (op, dc, ac) agree point by point; transient time steps are chosen
        # adaptively and may differ, so tran is compared through its .meas results.
        assert wasm["meas"].keys() == native.meas.keys(), where
        for k, v in native.meas.items():
            assert close(wasm["meas"][k], v, MEAS_TOL, 1e-12), (where, k, wasm["meas"][k], v)
        native_vecs = {(v.analysis, v.name): v for v in native.vectors}
        wasm_vecs = {(v["analysis"], v["name"]): v for v in wasm["vectors"]}
        assert wasm_vecs.keys() == native_vecs.keys(), (where, wasm_vecs.keys() ^ native_vecs.keys())
        for key, nv in native_vecs.items():
            wv = wasm_vecs[key]
            assert wv["unit"] == nv.unit, key
            if key[0] == "tran":
                continue
            assert len(wv["data"]) == len(nv.data), key
            for theirs, ours in ((wv["data"], nv.data), (wv["imag"] or [], nv.imag or [])):
                tol = VECTOR_TOL * max((abs(x) for x in ours), default=0.0) + 1e-15
                for a, b in zip(theirs, ours):
                    assert abs(a - b) <= tol, (where, key, a, b)
