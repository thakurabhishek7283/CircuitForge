"""How a failed attempt is told: to the composer, verbatim, every problem with its code and the
draft line it comes from (LLD §6, prompt layout step 5); to the student, one plain sentence in the
lesson track."""

from __future__ import annotations

from typing import Any


def for_model(errors: list[dict[str, Any]]) -> list[str]:
    return [f"{e['code']}" + (f" ({e['at']})" if e.get("at") else "") + f": {e['message']}" for e in errors]


def codes(errors: list[dict[str, Any]]) -> list[str]:
    """Distinct codes, in order: the `block.repair` event's `errors`."""
    return list(dict.fromkeys(str(e["code"]) for e in errors))


def for_student(title: str, attempt: int, errors: list[dict[str, Any]]) -> str:
    first = errors[0]
    if first["code"] == "spec_miss":
        what = f"missed its spec ({first['message']})"
    elif first["code"] == "schema_error":
        what = "was not a block description the editor can read"
    elif str(first["code"]).startswith("sim_"):
        what = "did not simulate"
    else:
        what = f"had a wiring problem ({first['message']})"
    more = f", and {len(errors) - 1} more problem{'s' if len(errors) > 2 else ''}" if len(errors) > 1 else ""
    return f"{title}: draft {attempt} {what}{more}."
