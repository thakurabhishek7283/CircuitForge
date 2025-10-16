"""The gateway the orchestrator calls (LLD §14): a retryable failure is retried twice with backoff,
then the fallback provider gets the same treatment, then the call fails with `LlmUnavailable` (the
composer falls back to the block's template; the planner fails the job, retryable)."""

from __future__ import annotations

import asyncio
import logging

from .base import LlmRequest, LlmResponse, OnDelta, Provider, ProviderError

log = logging.getLogger("tutor_api.llm")

MAX_WAIT_S = 10.0  # cap on a provider's Retry-After


class LlmUnavailable(Exception):
    def __init__(self, last: ProviderError | None):
        super().__init__(str(last) if last else "no provider")
        self.last = last


class Gateway:
    def __init__(self, primary: Provider, fallback: Provider | None = None, *, retries: int = 2,
                 backoff_s: float = 0.5):
        self.providers = [p for p in (primary, fallback) if p is not None]
        self.retries = retries
        self.backoff_s = backoff_s

    async def complete(self, req: LlmRequest) -> LlmResponse:
        return await self._call(req, None)

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        """Retried only while nothing has been streamed: a retry after the first delta would
        repeat text the reader has already seen."""
        return await self._call(req, on_delta)

    async def _call(self, req: LlmRequest, on_delta: OnDelta | None) -> LlmResponse:
        last: ProviderError | None = None
        streamed = False

        async def tee(text: str) -> None:
            nonlocal streamed
            streamed = True
            await on_delta(text)

        for provider in self.providers:
            for attempt in range(self.retries + 1):
                try:
                    if on_delta is None:
                        return await provider.complete(req)
                    return await provider.stream(req, tee)
                except ProviderError as e:
                    last = e
                    log.warning("%s %s call failed (attempt %d): %s", provider.name, req.kind, attempt + 1, e)
                    if streamed:
                        raise LlmUnavailable(e) from e
                    if not e.retryable:
                        break
                    if attempt < self.retries:
                        await asyncio.sleep(min(e.retry_after_s or self.backoff_s * 2**attempt, MAX_WAIT_S))
        raise LlmUnavailable(last)
