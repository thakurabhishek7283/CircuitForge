"""The structured-output schemas the model answers in: hand-written Pydantic, built per call so that
enums hold exactly what this call may choose (every template for a plan; a block's candidate
parts for a composition). These are not wire types: what the model says is checked here, then by
circuit-core, and never reaches the client as it is.

Providers support different subsets of JSON Schema, so the schema sent is a portable one
(`provider_schema`: references inlined; no patterns, lengths or titles). Pydantic still checks the
reply against the full model, and a reply that fails is a `schema_error` attempt (LLD §14).
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, create_model


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Named(Strict):
    name: str
    value: str


class Link(Strict):
    source: str = Field(description='an output port, as "b1.out"')
    target: str = Field(description='an input port, as "b2.in"')


class Net(Strict):
    name: str = Field(description="a port of the template, or a name for a net inside the block")
    pins: list[str] = Field(min_length=1, description="REF.PIN, such as R1.2 or U1.OUT_A")


@lru_cache(maxsize=8)
def plan_model(templates: tuple[str, ...]) -> type[BaseModel]:
    block = create_model(
        "PlanBlock",
        __base__=Strict,
        id=(str, Field(description="b1, b2, ...")),
        template=(Literal[templates], ...),
        title=(str, Field(max_length=80)),
        purpose=(str, Field(max_length=400, description="one sentence for the student")),
        targets=(list[Named], Field(description="target name and value; leave a target out for its default")),
    )
    return create_model(
        "Plan",
        __base__=Strict,
        blocks=(list[block], Field(max_length=8)),
        links=(list[Link], ...),
        uncovered=(list[str], Field(description="what the request needs that no template builds")),
    )


@lru_cache(maxsize=64)
def composition_model(parts: tuple[str, ...]) -> type[BaseModel]:
    part = create_model(
        "DraftPart",
        __base__=Strict,
        ref=(str, Field(description="R1, C2, U1: the part's refdes letter and a number")),
        part=(Literal[parts], ...),
        params=(list[Named], Field(description="a value for each parameter the part has")),
    )
    return create_model(
        "Composition",
        __base__=Strict,
        use_template=(bool, Field(description="true: keep the template as it is; parts and nets empty")),
        parts=(list[part], ...),
        nets=(list[Net], ...),
    )


DROP = {"title", "pattern", "maxLength", "minLength", "maxItems", "minItems", "default"}


def provider_schema(model: type[BaseModel]) -> dict[str, Any]:
    """`model`'s JSON Schema with `$defs` inlined and only the keywords every provider takes."""
    full = model.model_json_schema()
    defs = full.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(v) for v in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            return walk(defs[node["$ref"].rsplit("/", 1)[1]])
        out = {}
        for k, v in node.items():
            if k == "properties":  # property names are data, not keywords
                out[k] = {name: walk(sub) for name, sub in v.items()}
            elif k not in DROP:
                out[k] = walk(v)
        return out

    return walk(full)


class SchemaError(Exception):
    """The reply is not the JSON the schema asks for: one failed attempt (`schema_error`)."""


FENCE = re.compile(r"^\s*```(?:json)?\s*(.*?)\s*```\s*$", re.S)


def parse(model: type[BaseModel], text: str, finish_reason: str = "stop") -> BaseModel:
    if finish_reason == "length":
        raise SchemaError("the reply was cut off at the token limit: keep it shorter")
    if m := FENCE.match(text):
        text = m.group(1)
    try:
        data = json.loads(text)
    except ValueError as e:
        raise SchemaError(f"the reply is not JSON ({e})") from None
    try:
        return model.model_validate(data)
    except ValidationError as e:
        errs = e.errors()
        shown = "; ".join(f"{'.'.join(str(x) for x in err['loc']) or 'reply'}: {err['msg']}" for err in errs[:5])
        more = f" (and {len(errs) - 5} more)" if len(errs) > 5 else ""
        raise SchemaError(f"the reply does not match the schema: {shown}{more}") from None
