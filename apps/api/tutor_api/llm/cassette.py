"""Recorded LLM traffic (LLD §15: the orchestrator is tested on recorded responses, replayed
deterministically).

A cassette is a JSON file of interactions, each keyed by the sha256 of its request
(`LlmRequest.key`): the reply text and usage, the chunks of a streamed reply, or the provider error.
`Recorder` wraps a provider and writes what it answered; `Replayer` answers from the file, in
recorded order for repeated identical requests. A request the cassette does not hold raises
`CassetteMiss`, which is not a `ProviderError`, so no retry or fallback can hide it: a prompt
change means re-recording.
"""

from __future__ import annotations

import json
from collections import deque
from pathlib import Path
from typing import Any

from .base import LlmRequest, LlmResponse, OnDelta, Provider, ProviderError


class CassetteMiss(LookupError):
    pass


def _summary(req: LlmRequest) -> dict[str, Any]:
    # Enough to review a cassette diff; the full prompt is reproducible from the code.
    return {"key": req.key(), "kind": req.kind, "tier": req.tier, "user_tail": req.user[-300:]}


class Recorder:
    def __init__(self, inner: Provider):
        self.inner = inner
        self.name = inner.name
        self.interactions: list[dict[str, Any]] = []

    async def complete(self, req: LlmRequest) -> LlmResponse:
        try:
            resp = await self.inner.complete(req)
        except ProviderError as e:
            self.interactions.append(_summary(req) | {"error": e.to_json()})
            raise
        self.interactions.append(_summary(req) | {"response": resp.to_json()})
        return resp

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        chunks: list[str] = []

        async def tee(text: str) -> None:
            chunks.append(text)
            await on_delta(text)

        try:
            resp = await self.inner.stream(req, tee)
        except ProviderError as e:
            self.interactions.append(_summary(req) | {"chunks": chunks, "error": e.to_json()})
            raise
        self.interactions.append(_summary(req) | {"chunks": chunks, "response": resp.to_json()})
        return resp

    def save(self, path: str | Path) -> None:
        text = json.dumps({"version": 1, "interactions": self.interactions}, indent=1, ensure_ascii=False)
        Path(path).write_text(text + "\n", encoding="utf-8", newline="\n")


class Replayer:
    name = "replay"

    def __init__(self, interactions: list[dict[str, Any]]):
        self.by_key: dict[str, deque[dict[str, Any]]] = {}
        for it in interactions:
            self.by_key.setdefault(it["key"], deque()).append(it)

    @staticmethod
    def from_file(path: str | Path) -> Replayer:
        return Replayer(json.loads(Path(path).read_text(encoding="utf-8"))["interactions"])

    def unused(self) -> int:
        return sum(len(q) for q in self.by_key.values())

    def _take(self, req: LlmRequest) -> dict[str, Any]:
        queue = self.by_key.get(req.key())
        if not queue:
            raise CassetteMiss(
                f"no recorded {req.kind} reply for request {req.key()[:12]} (the prompt changed? re-record): "
                f"...{req.user[-200:]!r}"
            )
        return queue.popleft()

    @staticmethod
    def _answer(it: dict[str, Any]) -> LlmResponse:
        if "error" in it:
            e = it["error"]
            raise ProviderError(e["code"], e["message"], e["retryable"])
        return LlmResponse.from_json(it["response"])

    async def complete(self, req: LlmRequest) -> LlmResponse:
        return self._answer(self._take(req))

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        it = self._take(req)
        for chunk in it.get("chunks", []):
            await on_delta(chunk)
        return self._answer(it)
