"""Every registry part, simulated in a small circuit built through circuit-core, with its
behaviour checked against hand calculation or datasheet values (LLD §12: models must be verified
before a registry version ships)."""

import math

from pytest import approx

from circuits import Bench, ac, dc, op, tran
from sim_runner.ngspice_batch import SimResult

COVERED: set[str] = set()


def covers(*parts: str):
    COVERED.update(parts)
    return lambda f: f


def ok(r: SimResult) -> SimResult:
    assert r.status == "ok", r.log[-3000:]
    assert not r.failed_meas, f"failed .meas {r.failed_meas}\n{r.log[-3000:]}"
    return r


def opv(r: SimResult, name: str) -> float:
    return r.vec(name, "op").data[0]


def at(r: SimResult, name: str, analysis: str, x: float) -> float:
    """Value of a real vector at scale value x (linear interpolation)."""
    scale = {"dc": "v-sweep", "tran": "time"}[analysis]
    xs, ys = r.vec(scale, analysis).data, r.vec(name, analysis).data
    eps = 1e-9 * max(abs(xs[0]), abs(xs[-1]), 1.0)
    for i in range(1, len(xs)):
        if xs[i - 1] - eps <= x <= xs[i] + eps:
            t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
            return ys[i - 1] + t * (ys[i] - ys[i - 1])
    raise ValueError(f"{x} outside {analysis} scale")


def crossings(r: SimResult, name: str, level: float, after: float = 0.0) -> tuple[list[float], list[float]]:
    """Times where a tran vector rises / falls through `level`, after `after` seconds."""
    ts, ys = r.vec("time", "tran").data, r.vec(name, "tran").data
    rises, falls = [], []
    for i in range(1, len(ts)):
        if ts[i] <= after or (ys[i - 1] < level) == (ys[i] < level):
            continue
        t = ts[i - 1] + (level - ys[i - 1]) * (ts[i] - ts[i - 1]) / (ys[i] - ys[i - 1])
        (rises if ys[i] > ys[i - 1] else falls).append(t)
    return rises, falls


def supplies(b: Bench, vcc: float, vee: float | None = None) -> Bench:
    """VCC (and optionally a negative VEE) against GND."""
    b.part("V91", "vsource_dc", voltage=str(vcc)).net("VCC", "V91.P", volts=vcc).net("GND", "V91.N")
    if vee is not None:
        b.part("V92", "vsource_dc", voltage=str(-vee)).net("GND", "V92.P").net("VEE", "V92.N", volts=vee)
    return b


@covers("resistor_th", "vsource_dc")
def test_divider(reg):
    b = supplies(Bench(reg), 10.0)
    b.part("R1", "resistor_th", resistance="10k").part("R2", "resistor_th", resistance="30k")
    b.net("VCC", "R1.1").net("N_MID", "R1.2", "R2.1").net("GND", "R2.2")
    r = ok(b.simulate())
    assert opv(r, "v(n_mid)") == approx(7.5, rel=1e-6)
    assert opv(r, "@r1[i]") == approx(0.25e-3, rel=1e-6)
    assert opv(r, "i(v91)") == approx(-0.25e-3, rel=1e-6)


@covers("vsource_sine")
def test_sine_source(reg):
    b = Bench(reg).part("V1", "vsource_sine", amplitude="2", frequency="1k", offset="0.5")
    b.part("R1", "resistor_th", resistance="1k").net("N_SIG", "V1.P", "R1.1").net("GND", "V1.N", "R1.2")
    b.analyses(op(), ac(100, 10e3, 10), tran(5e-6, 3e-3))
    r = ok(b.simulate(extra="""
        .meas tran vmax max v(n_sig) from=1m to=3m
        .meas tran vmin min v(n_sig) from=1m to=3m
        .meas tran t1 when v(n_sig)=0.5 rise=1
        .meas tran t2 when v(n_sig)=0.5 rise=2
    """))
    assert opv(r, "v(n_sig)") == approx(0.5)  # the offset is the DC value
    assert r.meas["vmax"] == approx(2.5, abs=0.01) and r.meas["vmin"] == approx(-1.5, abs=0.01)
    assert 1 / (r.meas["t2"] - r.meas["t1"]) == approx(1000, rel=0.005)
    assert r.vec("v(n_sig)", "ac").data[0] == approx(2.0)  # AC magnitude = amplitude


@covers("cap_film")
def test_rc_lowpass(reg):
    b = Bench(reg).part("V1", "vsource_sine").part("R1", "resistor_th", resistance="1k")
    b.part("C1", "cap_film", capacitance="159n")
    b.net("N_IN", "V1.P", "R1.1").net("N_OUT", "R1.2", "C1.1").net("GND", "V1.N", "C1.2")
    b.analyses(ac(10, 100e3))
    r = ok(b.simulate(extra=".meas ac fc when vdb(n_out)=-3"))
    assert r.meas["fc"] == approx(1 / (2 * math.pi * 1e3 * 159e-9), rel=0.01)


@covers("cap_elec")
def test_coupling_highpass_and_charge(reg):
    b = Bench(reg).part("V1", "vsource_sine", offset="5").part("C1", "cap_elec", capacitance="10u")
    b.part("R1", "resistor_th", resistance="1k")
    b.net("N_IN", "V1.P", "C1.P").net("N_OUT", "C1.N", "R1.1").net("GND", "V1.N", "R1.2")
    b.analyses(op(), ac(0.1, 1e3))
    r = ok(b.simulate(extra=".meas ac fc when vdb(n_out)=-3"))
    assert r.meas["fc"] == approx(1 / (2 * math.pi * 1e3 * 10e-6), rel=0.01)
    assert opv(r, "v(n_out)") == approx(0, abs=1e-6)  # blocks the 5 V offset


@covers("inductor")
def test_rl_lowpass(reg):
    b = Bench(reg).part("V1", "vsource_sine").part("L1", "inductor", inductance="10m")
    b.part("R1", "resistor_th", resistance="62.83")
    b.net("N_IN", "V1.P", "L1.1").net("N_OUT", "L1.2", "R1.1").net("GND", "V1.N", "R1.2")
    b.analyses(op(), ac(10, 100e3))
    r = ok(b.simulate(extra=".meas ac fc when vdb(n_out)=-3"))
    assert r.meas["fc"] == approx(62.83 / (2 * math.pi * 10e-3), rel=0.01)
    assert opv(r, "@l1[i]") == approx(0, abs=1e-9)


def diode_bench(reg, part: str, vcc: float, r: str, reverse: bool = False) -> SimResult:
    b = supplies(Bench(reg), vcc).part("D1", part).part("R1", "resistor_th", resistance=r)
    if reverse:  # cathode up: Zener operation
        b.net("VCC", "R1.1").net("N_D", "R1.2", "D1.K").net("GND", "D1.A")
    else:
        b.net("VCC", "R1.1").net("N_D", "R1.2", "D1.A").net("GND", "D1.K")
    return ok(b.simulate())


@covers("diode_1n4148")
def test_1n4148_forward_drop(reg):
    r = diode_bench(reg, "diode_1n4148", 5.0, "1k")
    assert 0.6 <= opv(r, "v(n_d)") <= 0.75  # datasheet: 0.62-0.72 V at 5 mA
    assert opv(r, "@d1[id]") == approx((5 - opv(r, "v(n_d)")) / 1e3, rel=1e-3)


@covers("led_red")
def test_red_led_at_20ma(reg):
    r = diode_bench(reg, "led_red", 5.0, "150")
    vf, i = opv(r, "v(n_d)"), opv(r, "@d1[id]")
    assert 1.8 <= vf <= 2.1, vf
    assert i == approx(0.02, rel=0.1)


@covers("zener_5v1")
def test_zener_regulates(reg):
    r = diode_bench(reg, "zener_5v1", 12.0, "1k", reverse=True)
    assert opv(r, "v(n_d)") == approx(5.1, abs=0.2)  # about 7 mA, near the 1N4733 test current


@covers("npn_2n3904")
def test_npn_divider_bias(reg):
    b = supplies(Bench(reg), 12.0).part("Q1", "npn_2n3904")
    for refdes, value in [("R1", "47k"), ("R2", "10k"), ("R3", "4.7k"), ("R4", "1k")]:
        b.part(refdes, "resistor_th", resistance=value)
    b.net("VCC", "R1.1", "R3.1").net("N_B", "R1.2", "R2.1", "Q1.B").net("N_C", "R3.2", "Q1.C")
    b.net("N_E", "Q1.E", "R4.1").net("GND", "R2.2", "R4.2")
    r = ok(b.simulate())
    vbe = opv(r, "v(n_b)") - opv(r, "v(n_e)")
    ic, ib = opv(r, "@q1[ic]"), opv(r, "@q1[ib]")
    assert 0.6 <= vbe <= 0.75
    assert ic == approx(1.4e-3, rel=0.15)  # (Vb - Vbe) / RE
    assert 100 <= ic / ib <= 450  # datasheet hFE 100-300 at 10 mA; this model runs higher at 1 mA
    assert 4.0 <= opv(r, "v(n_c)") <= 7.0  # biased mid-rail, not saturated


@covers("pnp_2n3906")
def test_pnp_divider_bias(reg):
    b = supplies(Bench(reg), 12.0).part("Q1", "pnp_2n3906")
    for refdes, value in [("R1", "10k"), ("R2", "47k"), ("R3", "4.7k"), ("R4", "1k")]:
        b.part(refdes, "resistor_th", resistance=value)
    b.net("VCC", "R1.1", "R4.1").net("N_B", "R1.2", "R2.1", "Q1.B").net("N_E", "R4.2", "Q1.E")
    b.net("N_C", "Q1.C", "R3.1").net("GND", "R2.2", "R3.2")
    r = ok(b.simulate())
    veb = opv(r, "v(n_e)") - opv(r, "v(n_b)")
    ic, ib = -opv(r, "@q1[ic]"), -opv(r, "@q1[ib]")
    assert 0.6 <= veb <= 0.75
    assert ic == approx(1.4e-3, rel=0.15)
    assert 80 <= ic / ib <= 300
    assert 4.0 <= opv(r, "v(n_c)") <= 8.0


@covers("opamp_tl072")
def test_tl072_gain_follower_and_clipping(reg):
    """Unit A: non-inverting gain 10. Unit B: follower. Split ±12 V supply."""
    b = supplies(Bench(reg), 12.0, -12.0).part("U1", "opamp_tl072")
    b.part("V1", "vsource_sine", amplitude="1.5", frequency="1k")
    b.part("R1", "resistor_th", resistance="9k").part("R2", "resistor_th", resistance="1k")
    b.part("R3", "resistor_th", resistance="10k").part("R4", "resistor_th", resistance="10k")
    b.net("N_IN", "V1.P", "U1.INP_A", "U1.INP_B").net("GND", "V1.N", "R2.2", "R3.2", "R4.2")
    b.net("N_FB", "U1.INM_A", "R1.2", "R2.1").net("N_OA", "U1.OUT_A", "R1.1", "R3.1")
    b.net("N_OB", "U1.OUT_B", "U1.INM_B", "R4.1")
    b.net("VCC", "U1.VCC").net("VEE", "U1.VEE")
    b.analyses(op(), ac(10, 10e6), tran(2e-6, 3e-3))
    r = ok(b.simulate(extra="""
        .meas ac g_in find vdb(n_in) at=1k
        .meas ac g_a find vdb(n_oa) at=1k
        .meas ac g_b find vdb(n_ob) at=1k
        .meas ac fc_a when vdb(n_oa)=g_a-3
        .meas tran a_max max v(n_oa) from=1m to=3m
        .meas tran a_min min v(n_oa) from=1m to=3m
        .meas tran b_max max v(n_ob) from=1m to=3m
    """))
    assert abs(opv(r, "v(n_oa)")) < 1e-3 and abs(opv(r, "v(n_ob)")) < 1e-3
    assert r.meas["g_a"] - r.meas["g_in"] == approx(20.0, abs=0.1)
    assert r.meas["g_b"] - r.meas["g_in"] == approx(0.0, abs=0.05)
    assert r.meas["fc_a"] == approx(3e6 / 10, rel=0.2)  # GBW 3 MHz / noise gain 10
    assert r.meas["a_max"] == approx(10.5, abs=0.3) and r.meas["a_min"] == approx(-10.5, abs=0.3)  # clips 1.5 V in
    assert r.meas["b_max"] == approx(1.5, abs=0.02)
    assert opv(r, "i(v91)") == approx(-2 * 24 / 21.4e3, rel=0.05)  # 1.1 mA per unit at ±12 V


@covers("opamp_lm358")
def test_lm358_single_supply_swing(reg):
    """Single 5 V supply. Unit A: follower; unit B: gain 2. DC sweep of the input."""
    b = supplies(Bench(reg), 5.0).part("U1", "opamp_lm358").part("V1", "vsource_dc", voltage="1")
    b.part("R1", "resistor_th", resistance="10k").part("R2", "resistor_th", resistance="10k")
    b.net("N_IN", "V1.P", "U1.INP_A", "U1.INP_B").net("GND", "V1.N", "R2.2", "U1.VEE")
    b.net("N_OA", "U1.OUT_A", "U1.INM_A").net("N_FB", "U1.INM_B", "R1.2", "R2.1").net("N_OB", "U1.OUT_B", "R1.1")
    b.net("VCC", "U1.VCC")
    b.analyses(op(), dc("V1", 0.0, 5.0, 0.05))
    r = ok(b.simulate())
    assert opv(r, "v(n_oa)") == approx(1.0, abs=1e-3) and opv(r, "v(n_ob)") == approx(2.0, abs=2e-3)
    assert at(r, "v(n_oa)", "dc", 0.0) == approx(0.02, abs=0.02)  # reaches ground
    assert at(r, "v(n_oa)", "dc", 5.0) == approx(3.5, abs=0.1)  # VCC - 1.5 V
    assert at(r, "v(n_ob)", "dc", 1.5) == approx(3.0, abs=0.01)
    assert at(r, "v(n_ob)", "dc", 3.0) == approx(3.5, abs=0.1)


@covers("reg_lm7805")
def test_lm7805_regulation_and_dropout(reg):
    b = Bench(reg).part("V1", "vsource_dc", voltage="12").part("U1", "reg_lm7805")
    b.part("R1", "resistor_th", resistance="50")
    b.net("N_VIN", "V1.P", "U1.IN").net("GND", "V1.N", "U1.GND", "R1.2").net("N_OUT", "U1.OUT", "R1.1")
    b.analyses(op(), dc("V1", 0.0, 15.0, 0.1))
    r = ok(b.simulate())
    assert opv(r, "v(n_out)") == approx(5.0, rel=0.02)  # 100 mA load
    assert -opv(r, "i(v1)") == approx(0.1 + 0.005, rel=0.1)  # load + ~5 mA quiescent
    assert at(r, "v(n_out)", "dc", 15.0) == approx(5.0, rel=0.02)
    assert at(r, "v(n_out)", "dc", 7.5) == approx(5.0, rel=0.02)
    assert at(r, "v(n_out)", "dc", 6.0) == approx(4.0, abs=0.3)  # in dropout: about VIN - 2 V


def ne555_astable(reg, reset_net: str = "VCC") -> Bench:
    """Classic astable: RA = 1k, RB = 10k, C = 100n -> f = 1.44 / ((RA + 2 RB) C) ≈ 686 Hz."""
    b = supplies(Bench(reg), 9.0).part("U1", "timer_ne555")
    b.part("R1", "resistor_th", resistance="1k").part("R2", "resistor_th", resistance="10k")
    b.part("R3", "resistor_th", resistance="10k")
    b.part("C1", "cap_film", capacitance="100n").part("C2", "cap_film", capacitance="10n")
    b.net("VCC", "U1.VCC", "R1.1").net(reset_net, "U1.RESET").net("N_DIS", "R1.2", "R2.1", "U1.DIS")
    b.net("N_TH", "R2.2", "U1.THR", "U1.TRIG", "C1.1").net("N_CTRL", "U1.CTRL", "C2.1")
    b.net("N_OUT", "U1.OUT", "R3.1").net("GND", "U1.GND", "C1.2", "C2.2", "R3.2")
    return b


@covers("timer_ne555")
def test_ne555_astable(reg):
    b = ne555_astable(reg).analyses(tran(1e-6, 12e-3))
    r = ok(b.simulate(extra="""
        .meas tran th_max max v(n_th) from=4m to=12m
        .meas tran th_min min v(n_th) from=4m to=12m
        .meas tran out_max max v(n_out) from=4m to=12m
    """))
    rises, falls = crossings(r, "v(n_out)", 4.0, after=4e-3)
    assert len(rises) >= 4, (rises, falls)
    period = (rises[-1] - rises[0]) / (len(rises) - 1)
    high = next(f for f in falls if f > rises[0]) - rises[0]
    assert 1 / period == approx(1.44 / (21e3 * 100e-9), rel=0.1)
    assert high / period == approx(11 / 21, abs=0.05)  # duty = (RA + RB) / (RA + 2 RB)
    assert r.meas["th_max"] == approx(6.0, abs=0.3) and r.meas["th_min"] == approx(3.0, abs=0.3)
    assert r.meas["out_max"] == approx(9.0 - 1.7, abs=0.3)  # output high ≈ VCC - 1.7 V
    # the sourced output current comes in through the VCC pin (supply current minus RA's)
    def vcc_pin(t: float) -> float:
        return -at(r, "i(v91)", "tran", t) - at(r, "@r1[i]", "tran", t)

    assert vcc_pin(rises[1] + period / 4) - vcc_pin(falls[-1] + period / 8) == approx(7.3 / 10e3, rel=0.05)


def test_ne555_reset_holds_output_low(reg):
    r = ok(ne555_astable(reg, reset_net="GND").analyses(op(), tran(1e-6, 5e-3)).simulate(
        extra=".meas tran out_max max v(n_out)"))
    assert abs(opv(r, "v(n_out)")) < 0.01 and r.meas["out_max"] < 0.01


def test_ne555_operating_point_alone(reg):
    """An astable has no stable DC state; ngspice falls back to a transient operating point."""
    r = ok(ne555_astable(reg).analyses(op()).simulate())
    assert 0 <= opv(r, "v(n_th)") <= 9


def test_every_registry_part_is_simulated(reg):
    assert set(reg.part_ids()) == COVERED

