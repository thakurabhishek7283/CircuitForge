"""Binding-level tests for the Python package. Core semantics are covered by the Rust tests and the
cross-runtime parity gate; these cover what only exists on the Python side."""

import json
import threading
import time
from pathlib import Path

import pytest

import circuit_core as cc

REGISTRY_DIR = Path(__file__).resolve().parents[3] / "registry"


@pytest.fixture(scope="module")
def reg() -> cc.Registry:
    return cc.load_registry_dir(REGISTRY_DIR)


def env(session: cc.Session, op: str, body: dict, author: str = "user") -> str:
    return json.dumps({"v": 1, "seq": session.rev + 1, "op": op, "author": author, "base_rev": session.rev, "body": body})


def test_registry_loads_and_round_trips(reg):
    manifest = (REGISTRY_DIR / "manifest.yaml").read_text(encoding="utf-8")
    assert f'version: "{reg.version}"' in manifest
    assert "opamp_tl072" in reg.part_ids()
    again = cc.Registry.from_json(reg.to_json())
    assert again.to_json() == reg.to_json()


def test_bad_registry_and_snapshot_raise(reg):
    with pytest.raises(ValueError):
        cc.Registry.from_json("{}")
    with pytest.raises(ValueError, match="unknown placeholder"):
        cc.Registry.from_yaml_docs(
            "t",
            [("r.yaml", 'id: r\ncategory: R\ntitle: t\nsymbol: symbols/r.svg\npins: [{name: "1", num: 1, type: passive}]\n'
                        'spice: {line: "{x}"}\n')],
            [],
        )
    with pytest.raises(ValueError, match="symbols/r.svg is missing"):
        cc.Registry.from_yaml_docs("t", [("r.yaml", 'id: r\ncategory: R\ntitle: t\nsymbol: symbols/r.svg\npins: []\n')], [])
    with pytest.raises(ValueError, match="registry_mismatch"):
        cc.Session(reg, json.dumps({"schema_version": 1, "registry_version": "old", "rev": 0, "parts": {}, "nets": {},
                                    "blocks": {}, "analyses": [], "hints": []}))


def test_apply_unwrap_undo_and_snapshot(reg):
    s = cc.Session(reg)
    ok = cc.unwrap(s.apply(env(s, "part.add", {"refdes": "R1", "part": "resistor_th", "params": {"resistance": "4k7"}})))
    assert ok["rev"] == 1 and ok["patch"]["parts_upserted"] == ["R1"]
    data = cc.unwrap(s.changes(json.dumps(ok["patch"])))
    assert data["parts"]["R1"]["params"]["resistance"]["display"] == "4.7kΩ"
    with pytest.raises(cc.OpRejected) as e:
        cc.unwrap(s.apply(env(s, "part.add", {"refdes": "R1", "part": "resistor_th"})))
    assert e.value.error["code"] == "refdes_conflict"

    restored = cc.Session(reg, s.snapshot())
    assert restored.snapshot() == s.snapshot()
    cc.unwrap(s.apply_ops(json.dumps(ok["inverse"]), "user"))
    assert json.loads(s.snapshot())["parts"] == {}
    assert json.loads(restored.snapshot())["parts"]["R1"]["params"]["resistance"]["display"] == "4.7kΩ"


def test_fork_is_independent(reg):
    s = cc.Session(reg)
    f = s.fork()
    cc.unwrap(f.apply(env(f, "part.add", {"refdes": "R1", "part": "resistor_th"})))
    assert s.rev == 0 and f.rev == 1


def test_compile_erc_text_and_quantity(reg):
    s = cc.Session(reg)
    for op, body in [
        ("part.add", {"refdes": "V1", "part": "vsource_dc", "params": {"voltage": "5"}}),
        ("part.add", {"refdes": "R1", "part": "resistor_th"}),
        ("net.connect", {"net": "VCC", "pins": ["V1.P", "R1.1"], "kind": {"kind": "power", "volts": 5.0}}),
        ("net.connect", {"net": "GND", "pins": ["V1.N", "R1.2"]}),
    ]:
        cc.unwrap(s.apply(env(s, op, body)))
    netlist = cc.unwrap(s.compile())
    assert "R1 vcc 0 1e4" in netlist["text"] and len(netlist["hash"]) == 64
    assert cc.unwrap(s.erc("user_edit")) == []
    assert "R1 resistor_th resistance=10kΩ 1:VCC 2:GND" in s.circuit_text()
    assert cc.unwrap(cc.parse_quantity("2u2", "farad"))["si"] == pytest.approx(2.2e-6)


def test_heavy_calls_release_the_gil(reg):
    """A trial batch must not block other Python threads (the API's event loop)."""
    s = cc.Session(reg)
    batch = "[" + ",".join(
        json.dumps({"v": 1, "seq": i, "op": "part.add", "author": "llm", "base_rev": 0,
                    "body": {"refdes": f"R{i}", "part": "resistor_th"}})
        for i in range(1, 301)
    ) + "]"
    ticks = 0
    done = threading.Event()

    def ticker():
        nonlocal ticks
        while not done.is_set():
            ticks += 1
            time.sleep(0)

    t = threading.Thread(target=ticker)
    t.start()
    for _ in range(20):
        trial = cc.unwrap(s.apply_all(batch))
    done.set()
    t.join()
    assert len(trial["circuit"]["parts"]) == 300 and trial["errors"] == []
    assert ticks > 0
