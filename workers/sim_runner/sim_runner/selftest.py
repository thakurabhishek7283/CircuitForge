"""`python -m sim_runner.selftest`: simulate one template verification bench (selftest.json, the
Sallen-Key low-pass compiled by circuit-core) with the sandbox limits on, and compare its `.meas`
results with the recorded ones. Run in the built image (CI) to prove its ngspice, model files and
rlimits work together. Exits non-zero on any difference.

tests/test_worker.py keeps selftest.json equal to what circuit-core compiles today.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from . import ngspice_batch as nb
from .worker import registry_version

FIXTURE = Path(__file__).with_name("selftest.json")
REL_TOL, ABS_TOL = 0.02, 1e-3  # recorded on another build of the same ngspice release


def main() -> int:
    case = json.loads(FIXTURE.read_text(encoding="utf-8"))
    problems = []
    if (have := registry_version(nb.REGISTRY_DIR)) != case["registry_version"]:
        problems.append(f"registry {have}, fixture {case['registry_version']}")
    r = nb.simulate(case["netlist"], case["includes"], hash=case["hash"], vectors=False, limits=True)
    if r.status != "ok":
        problems.append(f"status {r.status}")
    if "can't find the initialization file" in r.log:
        problems.append("ngspice did not find spinit (SPICE_LIB_DIR)")
    for name, want in case["meas"].items():
        got = r.meas.get(name)
        if got is None or not math.isclose(got, want, rel_tol=REL_TOL, abs_tol=ABS_TOL):
            problems.append(f"{name}: {got}, recorded {want}")
    print(f"selftest: {r.status} in {r.ms:.0f} ms, {len(r.meas)} measurements")
    for p in problems:
        print("  FAIL", p)
    if problems:
        print(r.log[-3000:])
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
