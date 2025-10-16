"""Prompts (LLD §6, prompt layout): the stable prefix first, so a provider's prompt cache can serve
it to every call of every job on a registry version, then what changes per call.

1. `system.jinja`: the rules and the registry excerpt (every part and every template, one entry
   each), for the large model's plan and compose steps. `narrate_system.jinja`: the small model's
   own short prefix (it has its own cache, and narration needs no parts table).
2. `plan.jinja`, `compose.jinja`, `narrate.jinja`: the student's request, the plan, the block,
   the circuit as compact text, and on a retry the previous attempt with its problems.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import circuit_core as cc
from jinja2 import Environment, FileSystemLoader, StrictUndefined

ENV = Environment(
    loader=FileSystemLoader(Path(__file__).parent),
    undefined=StrictUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=False,
    autoescape=False,  # plain text for a model, never rendered as HTML
)


def qty(x: float, unit: str) -> str:
    """A number as the core displays it (`20kHz`, `-12V`); unitless as plain digits."""
    if unit != "unitless":
        out = json.loads(cc.parse_quantity(repr(float(x)), unit))
        if "ok" in out:
            return out["ok"]["display"]
    return f"{x:g}"


class Prompts:
    """The prompts for one registry version."""

    def __init__(self, reg: cc.Registry):
        self.bundle = json.loads(reg.to_json())
        self.parts: dict[str, Any] = self.bundle["parts"]
        self.templates: dict[str, Any] = self.bundle["templates"]
        self.system = ENV.get_template("system.jinja").render(
            version=self.bundle["version"],
            parts=[self._part(p) for p in self.parts.values()],
            templates=[self._template(t) for t in self.templates.values()],
        ).strip() + "\n"
        self.narrator = ENV.get_template("narrate_system.jinja").render().strip() + "\n"

    @staticmethod
    def _part(p: dict[str, Any]) -> dict[str, str]:
        params = "; ".join(
            f"{name} ({d['unit']}, {qty(d['min'], d['unit'])}..{qty(d['max'], d['unit'])}, default {d['default']})"
            for name, d in p["params"].items()
        )
        return {
            "id": p["id"], "category": p["category"], "title": p["title"],
            "pins": " ".join(pin["name"] for pin in p["pins"]),
            "units": ", ".join(p["units"]), "params": params,
        }

    def _template(self, t: dict[str, Any]) -> dict[str, str]:
        targets = "; ".join(
            f"{name}: {d['label']}, {qty(d['min'], d['unit'])}..{qty(d['max'], d['unit'])}, default {d['default']}"
            for name, d in t["targets"].items()
        )
        ports = []
        for name, direction in t["ports"].items():
            rail = t["rails"].get(name)
            if rail:
                lo, hi = rail.get("min", rail["volts"]), rail.get("max", rail["volts"])
                span = f"; {qty(lo, 'volt')}..{qty(hi, 'volt')}" if lo != hi else ""
                direction += f" on rail {rail['net']} ({qty(rail['volts'], 'volt')}{span})"
            ports.append(f"{name} {direction}")
        checks = "; ".join(f"{c['name']} ({c['label']}, {c['kind']}) ±{c['tol_pct']:g}%" for c in t["checks"])
        return {
            "id": t["id"], "role": t["role"], "title": t["title"], "targets": targets,
            "ports": ", ".join(ports),
            "parts": ", ".join(f"{ref} {d['part']}" for ref, d in t["parts"].items()),
            "nets": "; ".join(f"{net}: {' '.join(pins)}" for net, pins in t["nets"].items()),
            "checks": checks, "teach": t.get("teach") or "",
        }

    def plan(self, *, prompt: str, level: str, circuit: str, previous: str | None, problems: list[str]) -> str:
        return ENV.get_template("plan.jinja").render(
            prompt=prompt, level=level, circuit=circuit.strip(), previous=previous, problems=problems
        ).strip() + "\n"

    def compose(self, *, prompt: str, plan: list[dict[str, Any]], block: dict[str, Any], preview: dict[str, Any],
                ports: dict[str, str], circuit: str, candidates: list[str],
                last: dict[str, Any] | None) -> str:
        t = self.templates[block["template"]]
        targets = ", ".join(f"{name} = {v['display'] if v['unit'] != 'unitless' else qty(v['si'], 'unitless')}"
                            for name, v in preview["targets"].items()) or "none"
        reference = "; ".join(
            f"{ref} {t['parts'][ref]['part']}" + "".join(f" {k}={v['display']}" for k, v in values.items())
            for ref, values in preview["values"].items()
        )
        checks = "; ".join(
            f"{c['label']} {preview['spec_display'].get(c['name'], '?')} ±{c['tol_pct']:g}%" for c in t["checks"]
        )
        return ENV.get_template("compose.jinja").render(
            prompt=prompt, plan=plan, block=block, targets=targets,
            ports=", ".join(f"{name} → {to}" for name, to in ports.items()),
            reference=reference, checks=checks, circuit=circuit.strip(), candidates=", ".join(candidates),
            port_names=", ".join(t["ports"]), last=last,
        ).strip() + "\n"

    def narrate(self, *, prompt: str, level: str, plan: list[dict[str, Any]]) -> str:
        blocks = [b | {"teach": self.templates[b["template"]].get("teach") or ""} for b in plan]
        return ENV.get_template("narrate.jinja").render(prompt=prompt, level=level, plan=blocks).strip() + "\n"
