"""The worker end to end on Redis 7 and native ngspice: template benches compiled by circuit-core
(as the API's verifier gets them from `trial_block`), the cache, in-flight de-duplication, the
refusals, and the sandbox limits."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
from dataclasses import replace
from pathlib import Path

import circuit_core as cc
import pytest
from arq.worker import Worker

from benches import bench, request
from sim_runner import client, selftest
from sim_runner import ngspice_batch as nb
from sim_runner import worker as w
from sim_runner.protocol import QUEUE, SimRefused, cache_key


@pytest.fixture
async def pool(redis_url):
    """An arq pool on an empty Redis, with a worker consuming the queue in the background."""
    redis = await client.connect(redis_url)
    await redis.flushdb()
    s = w.WorkerSettings
    worker = Worker(
        functions=s.functions,
        queue_name=QUEUE,
        redis_pool=redis,
        max_jobs=4,
        keep_result=s.keep_result,
        poll_delay=s.poll_delay,
        job_serializer=s.job_serializer,
        job_deserializer=s.job_deserializer,
        on_startup=s.on_startup,
        handle_signals=False,
    )
    main = asyncio.create_task(worker.async_run())
    yield redis
    # Worker.close() signals itself with SIGUSR1, which Windows lacks.
    tasks = [main, *worker.tasks.values()]
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await redis.aclose()


@pytest.fixture
def runs(monkeypatch):
    """Counts the ngspice runs the worker starts."""
    calls: list[str] = []
    real = nb.simulate

    def counted(*a, **kw):
        calls.append(kw.get("hash", ""))
        return real(*a, **kw)

    monkeypatch.setattr(w.nb, "simulate", counted)
    return calls


async def test_template_bench_passes_its_checks_through_the_worker(pool, runs, reg, version):
    n = bench(reg, "sallen_key_lp", 0)
    first = await client.simulate(pool, request(n, version))
    assert first.status == "ok" and not first.cached, first.log
    assert first.meas and not first.failed_meas and first.hash == n["hash"]
    checks = cc.unwrap(cc.evaluate_checks(json.dumps(n["checks"]), json.dumps(first.meas)))
    assert checks and all(c["pass"] for c in checks), checks

    again = await client.simulate(pool, request(n, version))
    assert again.cached and again.meas == first.meas and runs == [n["hash"]]
    assert await pool.ttl(cache_key(version, n["hash"])) > 23 * 3600


async def test_identical_requests_in_flight_run_once(pool, runs, reg, version):
    n = bench(reg, "mfb_bandpass", 2)
    results = await asyncio.gather(*(client.simulate(pool, request(n, version)) for _ in range(6)))
    assert len(runs) == 1
    assert all(r.status == "ok" and r.meas == results[0].meas for r in results)


async def test_different_requests_run_concurrently(pool, runs, reg, version):
    """max_jobs ngspice processes at once: four benches take about as long as the slowest."""
    ns = [bench(reg, t, 1) for t in ("rc_lowpass", "inverting_amp", "sallen_key_hp", "schmitt_trigger")]
    results = await asyncio.gather(*(client.simulate(pool, request(n, version)) for n in ns))
    assert sorted(runs) == sorted(n["hash"] for n in ns)
    assert all(r.status == "ok" for r in results), [r.log[-500:] for r in results]


def rehash(n: dict, text: str) -> dict:
    return n | {"text": text, "hash": hashlib.sha256(text.encode()).hexdigest()}


@pytest.mark.parametrize(
    "case, code",
    [
        ("hash", "hash_mismatch"),
        ("registry", "registry_mismatch"),
        ("include_path", "include_invalid"),
        ("include_card", "include_invalid"),
        ("size", "netlist_too_large"),
    ],
)
async def test_refused_requests_are_not_simulated_or_cached(pool, runs, reg, version, case, code):
    n = bench(reg, "rc_lowpass", 0)
    req = request(n, version)
    if case == "hash":
        req = replace(req, hash="0" * 64)
    elif case == "registry":
        req = replace(req, registry_version="1999.01.0")
    elif case == "include_path":
        req = replace(req, includes=["../manifest.yaml"])
    elif case == "include_card":
        req = request(rehash(n, n["text"].replace("\n", "\n.include /etc/passwd\n", 1)), version)
    else:
        req = request(rehash(n, n["text"] + "*" * (1 << 20)), version)
    with pytest.raises(SimRefused) as e:
        await client.simulate(pool, req)
    assert e.value.code == code
    assert runs == [] and await pool.get(cache_key(req.registry_version, req.hash)) is None


async def test_a_timeout_is_reported_and_not_cached(pool, runs, reg, version):
    n = bench(reg, "rc_lowpass", 0)
    # 900k steps: seconds of CPU, but within RLIMIT_AS (ngspice allocates every vector for all
    # stop/step points up front; see the next test).
    text = re.sub(r"(?m)^\.tran .*$", ".tran 1e-7 0.09", n["text"])
    req = request(rehash(n, text), version, timeout_s=0.5)
    r = await client.simulate(pool, req)
    assert r.status == "timeout" and not r.cached
    assert await pool.get(cache_key(version, req.hash)) is None


@pytest.mark.skipif(os.name == "nt", reason="rlimits are POSIX")
async def test_a_run_over_the_memory_limit_fails_at_once(pool, reg, version):
    """9M transient points need about 72 MB per vector: under RLIMIT_AS ngspice's malloc fails
    within milliseconds, an `error` that names the cause, instead of running into the timeout."""
    n = bench(reg, "rc_lowpass", 0)
    text = re.sub(r"(?m)^\.tran .*$", ".tran 1e-8 0.09", n["text"])
    r = await client.simulate(pool, request(rehash(n, text), version, timeout_s=0.5))
    assert r.status == "error" and "Not enough memory" in r.log and r.ms < 400, (r.ms, r.log[-500:])


async def test_no_worker_is_a_timeout(redis_url, reg, version):
    redis = await client.connect(redis_url)
    await redis.flushdb()
    with pytest.raises(TimeoutError):
        await client.simulate(redis, request(bench(reg, "rc_lowpass", 0), version), wait_s=0.3)


@pytest.mark.parametrize("template", ["sallen_key_lp", "schmitt_trigger", "astable_555"])
def test_meas_only_mode_matches_the_full_driver(ngspice, reg, template):
    n = bench(reg, template, 0)
    full = nb.simulate(n["text"], n["includes"], hash=n["hash"], timeout_s=10)
    lean = nb.simulate(n["text"], n["includes"], hash=n["hash"], timeout_s=10, vectors=False)
    assert full.vectors and not lean.vectors
    assert (lean.status, lean.meas, lean.failed_meas) == (full.status, full.meas, full.failed_meas)


@pytest.mark.skipif(os.name == "nt", reason="rlimits are POSIX")
def test_the_sandbox_limits_reach_ngspice(tmp_path):
    fake = tmp_path / "ngspice"
    fake.write_text('#!/bin/sh\nulimit -v\nulimit -t\necho "$@"\n', encoding="utf-8")
    fake.chmod(0o755)
    out = subprocess.run(nb.command(fake, 1.5, True), cwd=tmp_path, capture_output=True, text=True, check=True)
    assert out.stdout.split("\n")[:3] == [str(nb.MEMORY_LIMIT // 1024), "2", "-b deck.cir"]
    assert nb.command(fake, 1.5, False) == [str(fake), "-b", "deck.cir"]


def test_selftest_fixture_is_current(reg, version):
    """selftest.json is the Sallen-Key bench as circuit-core compiles it today. Regenerate with
    SIM_UPDATE_SELFTEST=1 (records the measurements on the local ngspice)."""
    n = bench(reg, "sallen_key_lp", 0)
    fixture = selftest.FIXTURE
    if os.environ.get("SIM_UPDATE_SELFTEST"):
        r = nb.simulate(n["text"], n["includes"], hash=n["hash"], timeout_s=10, vectors=False)
        assert r.status == "ok" and not r.failed_meas
        case = {"registry_version": version, "hash": n["hash"], "includes": n["includes"], "netlist": n["text"],
                "meas": r.meas}
        fixture.write_text(json.dumps(case, indent=1) + "\n", encoding="utf-8", newline="\n")
    case = json.loads(Path(fixture).read_text(encoding="utf-8"))
    assert (case["registry_version"], case["hash"], case["includes"], case["netlist"]) == (
        version, n["hash"], n["includes"], n["text"]), "stale: rerun with SIM_UPDATE_SELFTEST=1"
    assert sorted(case["meas"]) == sorted(m["name"] for m in n["meas"])


def test_selftest_passes(ngspice):
    assert selftest.main() == 0
