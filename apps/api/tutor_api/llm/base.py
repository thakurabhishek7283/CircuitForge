"""What every provider takes and returns. A request names its purpose (`kind`) and model tier, not a
model: each provider maps the tier to its own model, so a cassette or a fake script works with any
of them."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, Protocol

Tier = Literal["large", "small"]  # LLD §6: planner and composer large; narration small
OnDelta = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class LlmRequest:
    kind: str  # plan | compose | narrate
    tier: Tier
    system: str  # the stable prefix: system prompt and registry excerpt (provider-cached)
    user: str
    schema: dict[str, Any] | None = None  # JSON Schema of the reply; None for plain text
    schema_name: str = "reply"
    max_tokens: int = 2000
    temperature: float = 0.2

    def key(self) -> str:
        """sha256 of the request: what a cassette is keyed by. Any prompt change changes it."""
        canon = json.dumps(asdict(self), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(canon.encode()).hexdigest()


@dataclass
class Usage:
    in_tokens: int = 0
    out_tokens: int = 0
    cached_tokens: int = 0  # of in_tokens, served from the provider's prompt cache


@dataclass
class LlmResponse:
    text: str
    model: str
    usage: Usage = field(default_factory=Usage)
    finish_reason: str = "stop"  # "length": cut off at max_tokens

    def to_json(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_json(d: dict[str, Any]) -> LlmResponse:
        return LlmResponse(d["text"], d["model"], Usage(**d.get("usage", {})), d.get("finish_reason", "stop"))


class ProviderError(Exception):
    """A failed call. `retryable`: a timeout, 429 or 5xx, worth retrying after `retry_after_s`."""

    def __init__(self, code: str, message: str, retryable: bool, retry_after_s: float | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after_s = retry_after_s

    def to_json(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


class Provider(Protocol):
    name: str

    async def complete(self, req: LlmRequest) -> LlmResponse: ...

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        """Like `complete`, calling `on_delta` with each piece of text as it arrives."""
        ...
