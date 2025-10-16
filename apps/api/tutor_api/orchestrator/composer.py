"""The composer (LLD §6): one planned block becomes a `BlockRequest`: the block's template as it is
(`use_template`), or a `DraftBlock` the model wrote part by part. The template, targets, port
bindings and block id always come from the plan, never from the model."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..llm.base import LlmRequest, LlmResponse
from ..llm.gateway import Gateway
from ..llm.prompts import Prompts
from .planner import PlannedBlock
from .schemas import SchemaError, composition_model, parse, provider_schema

COMPOSE_MAX_TOKENS = 2500


@dataclass
class Composed:
    response: LlmResponse
    request: dict[str, Any] | None  # a BlockRequest; None when the reply failed the schema
    choice: str  # "use_template" | "draft" | "schema_error"
    error: SchemaError | None = None


def template_request(block: PlannedBlock, ports: dict[str, Any]) -> dict[str, Any]:
    """`InsertBlock` for the block's template at its targets (also the fallback)."""
    return {"template": block.template, "targets": block.targets, "ports": ports, "id": block.id}


async def compose(gw: Gateway, prompts: Prompts, *, prompt: str, plan: list[dict[str, str]], block: PlannedBlock,
                  ports: dict[str, Any], port_text: dict[str, str], preview: dict[str, Any], circuit: str,
                  candidates: list[str], last: dict[str, Any] | None) -> Composed:
    model = composition_model(tuple(candidates))
    user = prompts.compose(prompt=prompt, plan=plan, block=block.brief(), preview=preview, ports=port_text,
                           circuit=circuit, candidates=candidates, last=last)
    req = LlmRequest("compose", "large", prompts.system, user, schema=provider_schema(model),
                     schema_name="composition", max_tokens=COMPOSE_MAX_TOKENS)
    resp = await gw.complete(req)
    base = template_request(block, ports)
    try:
        c = parse(model, resp.text, resp.finish_reason)
    except SchemaError as e:
        return Composed(resp, None, "schema_error", e)
    if c.use_template:
        return Composed(resp, {"template": base}, "use_template")
    draft = base | {
        "parts": [{"ref": p.ref, "part": p.part, "params": {x.name: x.value for x in p.params}} for p in c.parts],
        "nets": [{"name": n.name, "pins": n.pins} for n in c.nets],
    }
    return Composed(resp, {"draft": draft}, "draft")


def reply_text(resp: LlmResponse) -> str:
    """The previous reply as the repair prompt quotes it: compact JSON when it parses."""
    try:
        return json.dumps(json.loads(resp.text), ensure_ascii=False)
    except ValueError:
        return resp.text[:4000]
