"""The batch driver itself: deck handling, `.meas` replay, result shapes and status codes."""

import pytest
from pytest import approx

from circuits import Bench, ac, op, tran
from sim_runner.ngspice_batch import canonical_name, classify, simulate, split_deck


def rc(reg) -> Bench:
    b = Bench(reg).part("V1", "vsource_sine").part("R1", "resistor_th", resistance="1k")
    b.part("C1", "cap_film", capacitance="159n")
    return b.net("N_IN", "V1.P", "R1.1").net("N_OUT", "R1.2", "C1.1").net("GND", "V1.N", "C1.2")


def test_meas_for_every_analysis_not_only_the_last(reg):
    """ngspice evaluates deck .meas cards only for the last analysis; the replay covers all."""
    r = rc(reg).analyses(op(), ac(10, 100e3), tran(10e-6, 2e-3)).simulate(extra="""
        .meas ac fc when vdb(n_out)=-3
        .meas tran vpk max v(n_out) from=1m to=2m
    """)
    assert r.status == "ok"
    assert r.meas["fc"] == approx(1001, rel=0.01) and 0.6 < r.meas["vpk"] < 0.75
    assert {v.analysis for v in r.vectors} == {"op", "ac", "tran"}


def test_failed_meas_is_reported_not_fatal(reg):
    r = rc(reg).analyses(ac(10, 100e3)).simulate(extra=".meas ac never when vdb(n_out)=10")
    assert r.status == "ok" and "never" not in r.meas and r.failed_meas == ["never"]


def test_result_shapes(reg):
    r = rc(reg).analyses(op(), ac(10, 100e3, 10)).simulate()
    out = r.vec("v(n_out)", "ac")
    assert out.unit == "V" and out.imag is not None and len(out.data) == len(out.imag) == 41
    assert r.vec("frequency", "ac").unit == "Hz"
    assert r.vec("i(v1)", "op").unit == "A" and r.vec("@r1[i]", "op").unit == "A"
    assert not any(v.name == "@r1[i]" for v in r.vectors if v.analysis == "ac")  # empty in AC
    assert r.hash and r.ms > 0


def test_model_internals_are_not_exposed(reg):
    r = Bench(reg).part("U1", "reg_lm7805").part("V1", "vsource_dc", voltage="9") \
        .net("N_IN", "V1.P", "U1.IN").net("GND", "V1.N", "U1.GND").net("N_OUT", "U1.OUT").simulate()
    assert r.status == "ok"
    assert all("." not in v.name for v in r.vectors), [v.name for v in r.vectors]


def test_singular_matrix(reg):
    """Two ideal sources in parallel (ERC004): the user may build it; the sim must say why it fails."""
    b = Bench(reg).part("V1", "vsource_dc", voltage="5").part("V2", "vsource_dc", voltage="3")
    r = b.net("N_A", "V1.P", "V2.P").net("GND", "V1.N", "V2.N").simulate()
    assert r.status == "singular_matrix", r.log


def test_floating_node_and_the_shunt(reg):
    """ERC003: a node reached only through a capacitor. ngspice 47 still gets there through every
    stepping method and finally its transient operating point; the compiler's 1 GΩ shunt (user
    circuits) makes the same circuit solve directly."""
    b = rc(reg).part("C2", "cap_film").net("N_OUT", "C2.1").net("N_FLOAT", "C2.2")
    plain = b.simulate()
    assert plain.status == "ok" and "singular matrix" in plain.log and "Transient op" in plain.log
    shunted = b.simulate(shunt_floating=True)
    assert shunted.status == "ok" and "singular matrix" not in shunted.log
    assert shunted.vec("v(n_float)", "op").data[0] == approx(0, abs=1e-6)


def test_timeout(reg):
    n = rc(reg).analyses(tran(1e-8, 0.09)).netlist()  # 9M steps, just under the core's limit
    r = simulate(n["text"], n["includes"], timeout_s=0.5)
    assert r.status == "timeout" and r.vectors == []


def test_unknown_model_is_an_error(reg):
    n = rc(reg).netlist()
    r = simulate(n["text"].replace("C1 n_out 0", "XC1 n_out 0 NOSUCH"), n["includes"])
    assert r.status == "error"


def test_control_sections_are_refused():
    r = simulate("* t\n.control\nshell echo hi\n.endc\n.end\n", [])
    assert r.status == "error" and "control" in r.log


@pytest.mark.parametrize(
    "log, failed, status",
    [
        ("anything", False, "ok"),
        ("Warning: singular matrix:  check node n_a\nop simulation(s) aborted", True, "singular_matrix"),
        ("doAnalyses: TRAN:  Timestep too small; time = 1e-3", True, "no_convergence"),
        ("Warning: source stepping failed\nrun simulation(s) aborted", True, "no_convergence"),
        ("Error on line 3: unknown model", True, "error"),
    ],
)
def test_status_mapping(log, failed, status):
    assert classify(log, failed) == status


def test_deck_split_and_names():
    deck = split_deck("* t\nR1 a 0 1\n.op\n.tran 1u 1m\n.ac dec 1 1 10\n.meas ac x find vdb(a) at=1\n.end\n")
    assert deck.plots == ["op1", "tran1", "ac1"] and deck.analyses == ["op", "tran", "ac"]
    assert [m.command for m in deck.meas] == ["meas ac x find vdb(a) at=1"]
    assert all(not line.lower().startswith((".meas", ".end")) for line in deck.body)
    assert canonical_name("V(N_OUT)") == "v(n_out)" and canonical_name("i(@r1[i])") == "@r1[i]"
    assert canonical_name("v1#branch") == "i(v1)" and canonical_name("v(v-sweep)") == "v-sweep"
