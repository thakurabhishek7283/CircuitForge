"""A scripted provider: replies queued per request kind, consumed in order. Tests and the browser
end-to-end flow use it; it never touches the network.

A reply is text, any JSON value (sent as its JSON text), a `ProviderError` to raise, a `Delay`
around another reply, or a function of the request returning one of those.

A script may also hold `rules`, tried before the queues: each answers every request of its kind
whose user turn contains all of its `when` strings (the first matching rule wins), optionally after
`delay_s`, at most `times` times (every time without it). Rules let several jobs run at once
without sharing one queue (the browser tests key them on a word in each prompt), and a rule may
answer with `{"error": {"code", "message", "retryable"}}` instead of a `reply`.
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


@dataclass
class Rule:
    kind: str
    when: tuple[str, ...]
    reply: Reply
    times: int | None = None  # uses left; None: unlimited

    @staticmethod
    def from_json(d: dict[str, Any]) -> Rule:
        if "error" in d:
            e = d["error"]
            reply: Reply = ProviderError(e["code"], e.get("message", e["code"]), bool(e.get("retryable", False)))
        else:
            reply = d["reply"]
        if d.get("delay_s"):
            reply = Delay(float(d["delay_s"]), reply)
        return Rule(d["kind"], tuple(d.get("when", ())), reply, d.get("times"))

    def matches(self, req: LlmRequest) -> bool:
        return req.kind == self.kind and self.times != 0 and all(w in req.user for w in self.when)


class FakeProvider:
    name = "fake"

    def __init__(self, script: dict[str, Any]):
        self.rules = [r if isinstance(r, Rule) else Rule.from_json(r) for r in script.get("rules", ())]
        self.script = {k: list(v) for k, v in script.items() if k != "rules" and not k.startswith("_")}
        self.calls: list[LlmRequest] = []

    @staticmethod
    def from_file(path: str | Path) -> FakeProvider:
        """`{"plan": [reply, ...], "compose": [...], "narrate": [...], "rules": [...]}` (JSON; keys
        starting with `_` are comments)."""
        return FakeProvider(json.loads(Path(path).read_text(encoding="utf-8")))

    def left(self) -> dict[str, int]:
        """Replies not used yet, per kind."""
        return {k: len(v) for k, v in self.script.items() if v}

    def _next(self, req: LlmRequest) -> Reply:
        for rule in self.rules:
            if rule.matches(req):
                if rule.times is not None:
                    rule.times -= 1
                return rule.reply
        queue = self.script.get(req.kind)
        if not queue:
            raise ProviderError("script_exhausted", f"no scripted {req.kind} reply left", retryable=False)
        return queue.pop(0)

    async def complete(self, req: LlmRequest) -> LlmResponse:
        self.calls.append(req)
        reply = self._next(req)
        while True:
            if callable(reply):
                reply = reply(req)
            elif isinstance(reply, Delay):
                await asyncio.sleep(reply.seconds)
                reply = reply.reply
            else:
                break
        if isinstance(reply, ProviderError):
            # A fresh exception per call: a rule raises its error again and again.
            raise ProviderError(reply.code, reply.message, reply.retryable, reply.retry_after_s)
        text = reply if isinstance(reply, str) else json.dumps(reply)
        # A rough, deterministic count (about 4 characters a token) so usage is never zero.
        usage = Usage(in_tokens=(len(req.system) + len(req.user)) // 4, out_tokens=max(1, len(text) // 4))
        return LlmResponse(text, f"fake-{req.tier}", usage)

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        resp = await self.complete(req)
        for piece in re.findall(r"\S+\s*", resp.text):
            await on_delta(piece)
        return resp
