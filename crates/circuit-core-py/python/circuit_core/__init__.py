"""Python binding of the Rust circuit-core crate (LLD §2).

The native layer speaks JSON strings so it matches the WASM build byte for byte; the helpers
here add dict-level convenience for the API server. Never re-implement IR logic in Python:
every IR change goes through ``Session.apply``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ._native import Registry, Session, core_version, evaluate_checks, parse_quantity

__all__ = [
    "Registry",
    "Session",
    "OpRejected",
    "core_version",
    "evaluate_checks",
    "parse_quantity",
    "load_registry_dir",
    "unwrap",
]


class OpRejected(Exception):
    """An ``{"err": ...}`` outcome raised by :func:`unwrap`. ``.error`` holds the error object."""

    def __init__(self, error: Any):
        self.error = error
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else error
        super().__init__(f"{code}: {message}" if code else str(message))


def unwrap(outcome_json: str) -> Any:
    """Decode an ``{"ok": ...} | {"err": ...}`` result, raising :class:`OpRejected` on err."""
    outcome = json.loads(outcome_json)
    if "ok" in outcome:
        return outcome["ok"]
    raise OpRejected(outcome["err"])


def load_registry_dir(root: str | Path) -> Registry:
    """Load ``<root>/manifest.yaml``, ``<root>/parts/*.yaml``, ``<root>/symbols/*.svg`` and
    ``<root>/templates/*.yaml`` (sorted) into a Registry."""
    root = Path(root)
    version = None
    for line in (root / "manifest.yaml").read_text(encoding="utf-8").splitlines():
        if line.startswith("version:"):
            version = line.split(":", 1)[1].strip().strip("\"'")
    if not version:
        raise ValueError(f"{root / 'manifest.yaml'} has no version")

    def read(folder: str, pattern: str) -> list[tuple[str, str]]:
        return [(p.name, p.read_text(encoding="utf-8")) for p in sorted((root / folder).glob(pattern))]

    return Registry.from_yaml_docs(
        version, read("parts", "*.yaml"), read("symbols", "*.svg"), read("templates", "*.yaml")
    )
