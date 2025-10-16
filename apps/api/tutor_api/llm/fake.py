"""A scripted provider: replies queued per request kind, consumed in order. Tests and the browser
end-to-end flow use it; it never touches the network.

A reply is text, any JSON value (sent as its JSON text), a `ProviderError` to raise, a `Delay`
around another reply, or a function of the request returning one of those.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .base import LlmRequest, LlmResponse, OnDelta, ProviderError, Usage


@dataclass
class Delay:
    seconds: float
    reply: Any


Reply = Any  # str | JSON value | ProviderError | Delay | Callable[[LlmRequest], Reply]


class FakeProvider:
    name = "fake"

    def __init__(self, script: dict[str, list[Reply]]):
        self.script = {kind: list(replies) for kind, replies in script.items()}
        self.calls: list[LlmRequest] = []

    @staticmethod
    def from_file(path: str | Path) -> FakeProvider:
        """`{"plan": [reply, ...], "compose": [...], "narrate": [...]}` (JSON)."""
        return FakeProvider(json.loads(Path(path).read_text(encoding="utf-8")))

    def left(self) -> dict[str, int]:
        """Replies not used yet, per kind."""
        return {k: len(v) for k, v in self.script.items() if v}

    async def complete(self, req: LlmRequest) -> LlmResponse:
        self.calls.append(req)
        queue = self.script.get(req.kind)
        if not queue:
            raise ProviderError("script_exhausted", f"no scripted {req.kind} reply left", retryable=False)
        reply = queue.pop(0)
        while True:
            if callable(reply):
                reply = reply(req)
            elif isinstance(reply, Delay):
                await asyncio.sleep(reply.seconds)
                reply = reply.reply
            else:
                break
        if isinstance(reply, ProviderError):
            raise reply
        text = reply if isinstance(reply, str) else json.dumps(reply)
        # A rough, deterministic count (about 4 characters a token) so usage is never zero.
        usage = Usage(in_tokens=(len(req.system) + len(req.user)) // 4, out_tokens=max(1, len(text) // 4))
        return LlmResponse(text, f"fake-{req.tier}", usage)

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        resp = await self.complete(req)
        for piece in re.findall(r"\S+\s*", resp.text):
            await on_delta(piece)
        return resp
