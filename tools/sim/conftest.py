import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import circuit_core as cc  # noqa: E402
from sim_runner.ngspice_batch import REGISTRY_DIR, REPO, ngspice_path  # noqa: E402


def ngspice_version() -> str:
    for line in (REPO / "third_party" / "ngspice" / "pin.env").read_text(encoding="utf-8").splitlines():
        if line.startswith("NGSPICE_VERSION="):
            return line.split("=", 1)[1].strip().strip('"')
    return "unknown"


def pytest_collection_modifyitems(config, items):
    """No ngspice: skip locally, fail in CI (REQUIRE_NGSPICE=1) so the gate can't pass silently."""
    if ngspice_path() is not None:
        return
    msg = "ngspice not built: run third_party/ngspice/build-native.sh"
    if os.environ.get("REQUIRE_NGSPICE"):
        raise pytest.UsageError(msg)
    for item in items:
        item.add_marker(pytest.mark.skip(reason=msg))


@pytest.fixture(scope="session")
def reg() -> cc.Registry:
    return cc.load_registry_dir(REGISTRY_DIR)


def _template_results():
    mod = sys.modules.get("test_templates")
    return (mod.RESULTS, mod.TEMPLATES, mod.REG) if mod else (None, None, None)


def pytest_terminal_summary(terminalreporter):
    """Worst spec error per template check over its verification points."""
    results, templates, _ = _template_results()
    if not results:
        return
    tr = terminalreporter
    tr.section("template verification: worst |measured - target| / target per check")
    for tid in templates:
        worst: dict[str, float] = {}
        for checks in results.get(tid, {}).values():
            for c in checks:
                err = abs(c["measured"] - c["target"]) / abs(c["target"]) * 100 if "measured" in c else float("inf")
                worst[c["name"]] = max(worst.get(c["name"], 0.0), err)
        points = len(results.get(tid, {}))
        tr.write_line(f"{tid:18} {points}/5  " + "  ".join(f"{k} {v:.1f}%" for k, v in worst.items()))


def pytest_sessionfinish(session, exitstatus):
    """All templates verified at all points: stamp the bundle (LLD §12 step 2,
    `verified_registry_version`). The web build ships only a stamped bundle in CI."""
    results, templates, reg = _template_results()
    if not results or exitstatus != 0:
        return
    complete = all(len(results.get(t, {})) == 5 for t in templates) and all(
        c["pass"] for pts in results.values() for checks in pts.values() for c in checks
    )
    if not complete:
        return
    bundle = reg.to_json()
    stamp = {
        "registry_version": reg.version,
        "bundle_sha256": hashlib.sha256(bundle.encode("utf-8")).hexdigest(),
        "ngspice": ngspice_version(),
        "templates": {
            tid: {"version": templates[tid]["version"], "points": 5, "checks": [c["name"] for c in templates[tid]["checks"]]}
            for tid in templates
        },
    }
    out = REPO / "target" / "registry" / f"registry-{reg.version}.verified.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8", newline="\n")
