"""The sim_runner worker (LLD §8): an arq task that simulates one circuit-core netlist on the pinned
native ngspice, under the sandbox rlimits, with results cached in Redis by registry version and
netlist hash.

Run with `arq sim_runner.worker.WorkerSettings`. Settings come from the environment:
REDIS_URL, SIM_CONCURRENCY (default: one ngspice per CPU core), NGSPICE and SIM_REGISTRY_DIR.

One asyncio process runs up to SIM_CONCURRENCY simulations at once, each an ngspice subprocess
waited on from a thread; the Python side only writes the deck and reads `.meas` lines, so it does
not need a process per core.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Any

from arq import func
from arq.connections import RedisSettings

from . import ngspice_batch as nb
from .protocol import CACHE_TTL_S, KEEP_RESULT_S, LOG_TAIL, QUEUE, TASK, SimRefused, SimRequest, SimSummary
from .protocol import cache_key, dumps, loads

log = logging.getLogger("sim_runner")

MAX_NETLIST = 1 << 20  # bytes; the 300-part limit (LLD §1) compiles to well under 100 KB
INCLUDE_CARD = re.compile(r"^\s*\.(include|inc|lib)\s+(\S+)", re.I | re.M)
VERSION_LINE = re.compile(r'^version:\s*"?([^"\s]+)"?\s*$', re.M)


def registry_version(registry_dir: Path) -> str:
    """The version in the registry's manifest.yaml: the models this worker simulates with."""
    m = VERSION_LINE.search((registry_dir / "manifest.yaml").read_text(encoding="utf-8"))
    if not m:
        raise RuntimeError(f"no version in {registry_dir / 'manifest.yaml'}")
    return m.group(1)


def check(req: SimRequest, version: str, registry_dir: Path) -> None:
    """Refuse what circuit-core's compiler would never produce. Netlists come from the API, which
    compiles them itself; this keeps a bad request from reading files or poisoning the cache."""
    if len(req.netlist.encode()) > MAX_NETLIST:
        raise SimRefused("netlist_too_large", f"netlist is over {MAX_NETLIST} bytes")
    if hashlib.sha256(req.netlist.encode()).hexdigest() != req.hash:
        raise SimRefused("hash_mismatch", "hash is not the sha256 of the netlist")
    if req.registry_version != version:
        raise SimRefused("registry_mismatch", f"worker has registry {version}, request wants {req.registry_version}")
    root = registry_dir.resolve()
    for inc in req.includes:
        path = (root / inc).resolve()
        if Path(inc).is_absolute() or not path.is_relative_to(root) or not path.is_file():
            raise SimRefused("include_invalid", f"{inc!r} is not a registry model file")
    for m in INCLUDE_CARD.finditer(req.netlist):
        if m.group(2) not in req.includes:
            raise SimRefused("include_invalid", f"netlist includes {m.group(2)!r}, which is not in includes")


async def simulate(ctx: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    """`{"ok": SimSummary}` or `{"err": {code, message}}`. Never raises, so the JSON result always
    says why (arq can only serialize an exception by pickling it)."""
    try:
        req = SimRequest(**body)
        check(req, ctx["registry_version"], ctx["registry_dir"])
        key = cache_key(req.registry_version, req.hash)
        redis = ctx["redis"]
        if hit := await redis.get(key):
            return {"ok": loads(hit) | {"cached": True}}
        r = await asyncio.to_thread(
            nb.simulate,
            req.netlist,
            req.includes,
            hash=req.hash,
            timeout_s=min(req.timeout_s, ctx["max_timeout_s"]),
            registry_dir=ctx["registry_dir"],
            ngspice=ctx["ngspice"],
            vectors=False,
            limits=True,
        )
        summary = SimSummary(r.hash, r.status, r.meas, r.failed_meas, r.log[-LOG_TAIL:], round(r.ms, 1))
        # A timeout depends on the machine's load, not only on the netlist.
        if summary.status != "timeout":
            await redis.set(key, summary.to_json(), ex=CACHE_TTL_S)
        return {"ok": loads(summary.to_json().encode()) | {"cached": False}}
    except SimRefused as e:
        return {"err": {"code": e.code, "message": e.message}}
    except Exception as e:  # noqa: BLE001 - reported to the caller, which decides
        log.exception("simulation failed")
        return {"err": {"code": "internal", "message": f"{type(e).__name__}: {e}"}}


async def startup(ctx: dict[str, Any]) -> None:
    exe = nb.ngspice_path()
    if exe is None or not exe.exists():
        raise RuntimeError("ngspice not found: set NGSPICE or build third_party/ngspice/build-native.sh")
    ctx["ngspice"] = exe
    ctx["registry_dir"] = nb.REGISTRY_DIR
    ctx["registry_version"] = registry_version(nb.REGISTRY_DIR)
    ctx["max_timeout_s"] = float(os.environ.get("SIM_MAX_TIMEOUT_S") or nb.TIMEOUT_S)
    log.info("sim_runner: ngspice %s, registry %s", exe, ctx["registry_version"])


class WorkerSettings:
    functions = [func(simulate, name=TASK, timeout=30, max_tries=2)]
    queue_name = QUEUE
    redis_settings = RedisSettings.from_dsn(os.environ.get("REDIS_URL") or "redis://localhost:6379/0")
    max_jobs = int(os.environ.get("SIM_CONCURRENCY") or os.cpu_count() or 1)
    keep_result = KEEP_RESULT_S
    poll_delay = 0.02  # queue polling; arq's default 0.5 s would add up to that much to every run
    health_check_interval = 10
    job_serializer = staticmethod(dumps)
    job_deserializer = staticmethod(loads)
    on_startup = startup
