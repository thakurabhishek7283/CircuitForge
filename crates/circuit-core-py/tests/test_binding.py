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



def test_edit_helpers(reg):
    s = cc.Session(reg)
    assert cc.unwrap(s.next_refdes("resistor_th")) == "R1"
    for refdes in ("R1", "R2"):
        cc.unwrap(s.apply(env(s, "part.add", {"refdes": refdes, "part": "resistor_th"})))
    assert cc.unwrap(s.next_refdes("resistor_th")) == "R3"
    ops = cc.unwrap(s.connect("R1.2", json.dumps({"pin": "R2.1"})))
    assert ops == [{"op": "net.connect", "body": {"net": "N1", "pins": ["R1.2", "R2.1"]}}]
    cc.unwrap(s.apply_ops(json.dumps(ops), "user"))
    assert json.loads(s.connect("R2.1", json.dumps({"net": "N1"})))["err"]["code"] == "pin_already_connected"
    netlist = cc.unwrap(s.compile(json.dumps({"interactive": True})))
    assert "\n.op\n.tran 1e-5 1e-2\n" in netlist["text"]
    assert netlist["pin_currents"]["R1.2"] == [{"vector": "@r1[i]", "coeff": -1.0}]


def test_block_templates(reg):
    assert len(reg.template_ids()) == 20 and "sallen_key_lp" in reg.template_ids()
    assert len(cc.unwrap(reg.verify_points("rc_lowpass"))) == 5
    s = cc.Session(reg)
    req = json.dumps({"template": "rc_lowpass", "targets": {"fc_hz": "159"}})
    preview = cc.unwrap(s.preview_block(req))
    assert preview["spec"]["fc_hz"] == {"target": 159.0, "tol_pct": 10.0}
    ins = cc.unwrap(s.insert_block(req))
    cc.unwrap(s.apply_ops(json.dumps(ins["ops"]), "template"))
    netlist = cc.unwrap(s.compile(json.dumps({"interactive": True})))
    assert [c["name"] for c in netlist["checks"]] == ["fc_hz"]
    results = cc.unwrap(cc.evaluate_checks(json.dumps(netlist["checks"]), json.dumps({})))
    assert results[0]["pass"] is False
    assert results[0]["note"] == "needs a signal: connect a sine source to the block's input"
    assert json.loads(s.insert_block(json.dumps({"template": "x"})))["err"]["code"] == "template_not_found"


RC_DRAFT = {"draft": {
    "template": "rc_lowpass", "targets": {"fc_hz": "1k"},
    "parts": [{"ref": "R1", "part": "resistor_th", "params": {"resistance": "1.6k"}},
              {"ref": "C1", "part": "cap_film", "params": {"capacitance": "100n"}}],
    "nets": [{"name": "in", "pins": ["R1.1"]}, {"name": "out", "pins": ["R1.2", "C1.1"]},
             {"name": "gnd", "pins": ["C1.2"]}],
}}


def test_trial_block_and_bench(reg):
    s = cc.Session(reg)
    t = cc.unwrap(s.trial_block(json.dumps(RC_DRAFT), "j_1"))
    assert t["problems"] == [] and t["author"] == "llm" and t["block"] == "b1"
    assert t["bench"]["checks"][0]["name"] == "fc_hz"
    assert s.rev == 0, "a trial changes nothing"
    cc.unwrap(s.apply_ops(json.dumps(t["ops"]), "llm"))
    assert len(cc.unwrap(s.bench_ops("b1"))) == 6
    bad = json.loads(json.dumps(RC_DRAFT))
    bad["draft"]["nets"][1]["pins"].append("C1.3")
    t = cc.unwrap(cc.Session(reg).trial_block(json.dumps(bad)))
    assert [(p["code"], p["at"]) for p in t["problems"]] == [("pin_not_found", "net out")]
    assert json.loads(s.trial_block("{}"))["err"]["code"] == "schema_error"


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
