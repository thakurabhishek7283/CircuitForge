"""Run a circuit-core netlist through the pinned native ngspice (`ngspice -b`, LLD §8).

The engine of the sim_runner worker (`sim_runner.worker`) and of the simulation tests in
tools/sim. The browser worker (apps/web/src/workers/sim.engine.ts) drives the same deck the same
way through the shared-library API, so both return the same vectors, `.meas` values and status
codes.

Two ngspice 47 behaviours shape the driver:

- `.meas` cards in a deck are evaluated only for the *last* analysis that ran
  (frontend/runcoms.c, `do_measure(ci_last_an)`), and not at all in batch mode with `-r`.
  So the driver lifts every `.meas` card out of the deck and replays it after `run` as an
  interactive `meas` command against the plot of its own analysis. Interactive `meas` also
  substitutes earlier scalar results on its right-hand side (e.g. `when vdb(out)=ref-3`).
- `write` evaluates its vector list as an expression and refuses a whole plot if one saved
  vector is empty there (device currents such as `@r1[i]` do not exist in AC), so the deck sets
  `plainwrite`.
"""

from __future__ import annotations

import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

REPO = Path(__file__).resolve().parents[3]
# The registry's model files; the sim_runner image sets SIM_REGISTRY_DIR to its copy of them.
REGISTRY_DIR = Path(os.environ.get("SIM_REGISTRY_DIR") or REPO / "registry")
TIMEOUT_S = 2.0  # LLD §1 hard limit for server simulations
MEMORY_LIMIT = 256 * 2**20  # LLD §8: RLIMIT_AS for one ngspice process

Status = Literal["ok", "no_convergence", "singular_matrix", "timeout", "error"]
Unit = Literal["V", "A", "Hz", "s"]

ANALYSIS_CARDS = {".op": "op", ".dc": "dc", ".ac": "ac", ".tran": "tran"}
PLOTNAME_ANALYSIS = {
    "operating point": "op",
    "dc transfer characteristic": "dc",
    "ac analysis": "ac",
    "transient analysis": "tran",
}
UNITS: dict[str, Unit] = {"voltage": "V", "current": "A", "frequency": "Hz", "time": "s"}

# Log lines -> status (first match wins). Kept in step with STATUS_PATTERNS in sim.engine.ts.
STATUS_PATTERNS: list[tuple[re.Pattern[str], Status]] = [
    (re.compile(r"singular matrix", re.I), "singular_matrix"),
    (re.compile(r"timestep too small", re.I), "no_convergence"),
    (re.compile(r"no convergence|gmin stepping failed|source stepping failed|iteration limit", re.I), "no_convergence"),
]
FAILURE = re.compile(r"simulation\(s\) aborted|timestep too small|analysis not run", re.I)


@dataclass
class Vector:
    name: str
    analysis: str
    unit: Unit
    data: list[float]
    imag: list[float] | None = None


@dataclass
class SimResult:
    hash: str
    vectors: list[Vector]
    meas: dict[str, float]
    status: Status
    log: str
    ms: float
    failed_meas: list[str] = field(default_factory=list)

    def vec(self, name: str, analysis: str) -> Vector:
        for v in self.vectors:
            if v.name == name and v.analysis == analysis:
                return v
        have = sorted(v.name for v in self.vectors if v.analysis == analysis)
        raise KeyError(f"no vector {name!r} in {analysis} (have {have})")


@dataclass
class MeasCard:
    analysis: str
    name: str
    command: str


@dataclass
class Deck:
    """A netlist split into what ngspice loads and what the driver replays after `run`."""

    body: list[str]  # netlist lines without `.meas` cards and without `.end`
    analyses: list[str]  # analysis of each card, in deck order
    plots: list[str]  # ngspice plot name per analysis card: op1, ac1, tran1, ...
    meas: list[MeasCard]


def split_deck(netlist: str) -> Deck:
    body, analyses, meas = [], [], []
    for line in netlist.splitlines():
        words = line.split()
        card = words[0].lower() if words else ""
        if card in (".control", ".endc"):
            raise ValueError("netlists must not contain .control sections")
        if card in (".meas", ".measure"):
            if len(words) < 4:
                raise ValueError(f"incomplete .meas card: {line!r}")
            meas.append(MeasCard(words[1].lower(), words[2].lower(), "meas " + line.split(None, 1)[1]))
        elif card == ".end":
            continue
        else:
            if card in ANALYSIS_CARDS:
                analyses.append(ANALYSIS_CARDS[card])
            body.append(line)
    counts: dict[str, int] = {}
    plots = []
    for a in analyses:
        counts[a] = counts.get(a, 0) + 1
        plots.append(f"{a}{counts[a]}")
    return Deck(body, analyses, plots, meas)


def control_block(deck: Deck) -> list[str]:
    lines = [".control", "set filetype=binary", "set plainwrite", "run"]
    for plot in deck.plots:
        lines += [f"setplot {plot}", f"write {plot}.raw"]
    for m in deck.meas:
        plot = next((p for p, a in zip(deck.plots, deck.analyses) if a == m.analysis), None)
        if plot is not None:
            lines += [f"setplot {plot}", m.command]
    return lines + ["quit", ".endc"]


def canonical_name(raw: str) -> str:
    """`V(N_OUT)` -> `v(n_out)`, `i(@r1[i])` -> `@r1[i]`, `v1#branch` -> `i(v1)`,
    `v(v-sweep)` -> `v-sweep` (the DC sweep scale)."""
    n = raw.lower()
    if n in ("v(v-sweep)", "i(i-sweep)"):
        return n[2:-1]
    if n.startswith("i(@") and n.endswith(")"):
        return n[2:-1]
    if n.endswith("#branch"):
        return f"i({n[: -len('#branch')]})"
    return n


def is_internal(raw: str) -> bool:
    """Nodes and devices inside a model subcircuit (`xu1_a.n1`, `b.xu1_a.bout`): they do not map
    to the IR and change whenever a model does, so results never expose them."""
    return "." in raw


def parse_raw(data: bytes) -> tuple[str, list[tuple[str, str, int | None]], list[list[float]], list[list[float]] | None]:
    """One binary rawfile plot -> (plotname, [(name, type, dims)], real columns, imag columns)."""
    marker = data.find(b"Binary:\n")
    if marker < 0:
        raise ValueError("not a binary rawfile")
    header = data[:marker].decode("latin-1").splitlines()
    plotname, complex_, npoints, variables = "", False, 0, []
    in_vars = False
    for line in header:
        if in_vars and line.startswith(("\t", " ")):
            parts = line.split()
            dims = next((int(p[5:]) for p in parts[3:] if p.startswith("dims=")), None)
            variables.append((parts[1], parts[2], dims))
            continue
        in_vars = False
        key, _, value = line.partition(":")
        value = value.strip()
        if key == "Plotname":
            plotname = value
        elif key == "Flags":
            complex_ = "complex" in value
        elif key == "No. Points":
            npoints = int(value)
        elif key == "Variables":
            in_vars = True
    width = 2 if complex_ else 1
    values = array("d")
    values.frombytes(data[marker + len(b"Binary:\n") :][: npoints * len(variables) * width * 8])
    if sys.byteorder != "little":
        values.byteswap()
    nvars = len(variables)
    real = [[values[(p * nvars + k) * width] for p in range(npoints)] for k in range(nvars)]
    imag = [[values[(p * nvars + k) * width + 1] for p in range(npoints)] for k in range(nvars)] if complex_ else None
    return plotname, variables, real, imag


def raw_plotname(path: Path) -> str:
    """A binary rawfile's plot name, read from its header without loading the values."""
    with path.open("rb") as f:
        head = f.read(4096)
    for line in head.decode("latin-1").splitlines():
        key, _, value = line.partition(":")
        if key == "Plotname":
            return value.strip()
    return ""


def classify(log: str, failed: bool) -> Status:
    if not failed:
        return "ok"
    for pattern, status in STATUS_PATTERNS:
        if pattern.search(log):
            return status
    return "error"


def ngspice_path() -> Path | None:
    """`NGSPICE` env var, else the build in third_party/ngspice/dist/native."""
    if os.environ.get("NGSPICE"):
        return Path(os.environ["NGSPICE"])
    exe = "ngspice.exe" if os.name == "nt" else "ngspice"
    p = REPO / "third_party" / "ngspice" / "dist" / "native" / "bin" / exe
    return p if p.exists() else None


def command(exe: Path, timeout_s: float, limits: bool) -> list[str]:
    """`ngspice -b deck.cir`; with `limits` on POSIX, under RLIMIT_AS and RLIMIT_CPU (LLD §8). The
    limits are set by `sh` before it execs ngspice, because `preexec_fn` is unsafe in a process
    with threads (the worker runs each simulation in a thread)."""
    if not limits or os.name == "nt":
        return [str(exe), "-b", "deck.cir"]
    script = f'ulimit -v {MEMORY_LIMIT // 1024} && ulimit -t {math.ceil(timeout_s)} && exec "$0" -b deck.cir'
    return ["/bin/sh", "-c", script, str(exe)]


# Killed for exceeding RLIMIT_CPU: SIGXCPU at the soft limit, SIGKILL at the hard one.
CPU_KILLED = {-getattr(signal, "SIGXCPU", 24), -signal.SIGKILL} if os.name != "nt" else set()

MEAS_LINE = re.compile(r"^\s*(\S+)\s+=\s+(\S+)")


def simulate(
    netlist: str,
    includes: list[str],
    *,
    hash: str = "",
    timeout_s: float = TIMEOUT_S,
    registry_dir: Path = REGISTRY_DIR,
    ngspice: Path | None = None,
    vectors: bool = True,
    limits: bool = False,
) -> SimResult:
    """Simulate a compiled netlist. `includes` are registry-relative model files (Netlist.includes).

    `vectors=False` skips reading the result vectors (the server needs only `.meas` values and the
    status; parsing a long transient costs up to 100 ms of CPU). `limits` applies the sandbox
    rlimits where the OS has them."""
    exe = ngspice or ngspice_path()
    if exe is None:
        raise FileNotFoundError("ngspice not built: run third_party/ngspice/build-native.sh")
    started = time.perf_counter()
    try:
        deck = split_deck(netlist)
    except ValueError as e:
        return SimResult(hash, [], {}, "error", str(e), 0.0)

    with tempfile.TemporaryDirectory(prefix="sim-") as tmp:
        work = Path(tmp)
        for inc in includes:
            (work / inc).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(registry_dir / inc, work / inc)
        (work / "deck.cir").write_text("\n".join(deck.body + control_block(deck) + [".end", ""]), encoding="utf-8")
        try:
            proc = subprocess.run(
                command(exe, timeout_s, limits), cwd=work, capture_output=True, timeout=timeout_s, check=False
            )
        except subprocess.TimeoutExpired as e:
            log = (e.stdout or b"").decode("utf-8", "replace") + (e.stderr or b"").decode("utf-8", "replace")
            return SimResult(hash, [], {}, "timeout", log, (time.perf_counter() - started) * 1e3)
        log = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
        if limits and proc.returncode in CPU_KILLED:
            return SimResult(hash, [], {}, "timeout", log, (time.perf_counter() - started) * 1e3)

        results: list[Vector] = []
        missing = False
        for plot, analysis in zip(deck.plots, deck.analyses):
            path = work / f"{plot}.raw"
            if not path.exists():
                missing = True
                continue
            if not vectors:
                # `setplot` failed and `write` wrote whatever plot was current
                missing |= PLOTNAME_ANALYSIS.get(raw_plotname(path).lower()) != analysis
                continue
            plotname, variables, real, imag = parse_raw(path.read_bytes())
            if PLOTNAME_ANALYSIS.get(plotname.lower()) != analysis:
                missing = True
                continue
            for k, (name, vtype, dims) in enumerate(variables):
                unit = UNITS.get(vtype)
                if unit is None or dims == 0 or is_internal(name):
                    continue
                n = len(real[k]) if dims is None else dims
                results.append(
                    Vector(canonical_name(name), analysis, unit, real[k][:n], imag[k][:n] if imag else None)
                )

    names = {m.name for m in deck.meas}
    meas: dict[str, float] = {}
    for line in log.splitlines():
        m = MEAS_LINE.match(line)
        if m and m.group(1).lower() in names:
            try:
                meas[m.group(1).lower()] = float(m.group(2))
            except ValueError:
                pass
    failed = proc.returncode != 0 or missing or bool(FAILURE.search(log))
    return SimResult(
        hash,
        results,
        meas,
        classify(log, failed),
        log,
        (time.perf_counter() - started) * 1e3,
        failed_meas=sorted(names - meas.keys()),
    )
