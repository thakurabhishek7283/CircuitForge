"""What the API and the worker exchange through Redis: the arq queue and task, the request and
result shapes, the result cache key and the JSON serializer.

arq pickles jobs and results by default, which would let anything that can write to Redis run
code in the worker; both sides use JSON instead.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from typing import Any

from .ngspice_batch import TIMEOUT_S, Status

QUEUE = "arq:sim"
TASK = "simulate"
CACHE_TTL_S = 24 * 3600  # LLD §8
KEEP_RESULT_S = 5  # the arq result only has to outlive the waiting clients' next poll
LOG_TAIL = 4000  # characters of the ngspice log kept in a result


def cache_key(registry_version: str, hash: str) -> str:
    """`sim:{registry_version}:{hash}`. The netlist hash alone (LLD §8 `sim:{hash}`) does not cover
    the model files a netlist includes, which can change with the registry version."""
    return f"sim:{registry_version}:{hash}"


@dataclass(frozen=True)
class SimRequest:
    """A compiled circuit-core netlist (`Netlist.text`, `.includes`, `.hash`)."""

    netlist: str
    includes: list[str]
    hash: str
    registry_version: str
    timeout_s: float = TIMEOUT_S


@dataclass
class SimSummary:
    """A server simulation result: status and `.meas` values, no vectors. The API combines `meas`
    into spec checks with `circuit_core.evaluate_checks`."""

    hash: str
    status: Status
    meas: dict[str, float]
    failed_meas: list[str]
    log: str  # the last LOG_TAIL characters
    ms: float
    cached: bool = False

    def to_json(self) -> str:
        return json.dumps({k: v for k, v in asdict(self).items() if k != "cached"})

    @staticmethod
    def from_json(text: str | bytes, *, cached: bool = False) -> SimSummary:
        return SimSummary(**json.loads(text), cached=cached)


class SimRefused(Exception):
    """The worker refused a request without simulating it (`hash_mismatch`, `registry_mismatch`,
    `include_invalid`, `netlist_too_large`), or failed to run it (`internal`)."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def dumps(obj: Any) -> bytes:
    return json.dumps(obj, separators=(",", ":")).encode()


def loads(data: bytes) -> Any:
    return json.loads(data)
