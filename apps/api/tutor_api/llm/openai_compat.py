"""One adapter for every OpenAI-compatible chat completions endpoint: Gemini
(`generativelanguage.googleapis.com/v1beta/openai`) and DeepSeek on Azure AI Foundry
(`<resource>.services.ai.azure.com/openai/v1`). Plain httpx, no vendor SDK.

Structured output is either `json_schema` (the reply is constrained to the schema) or
`json_object` (any JSON object; the schema goes into the prompt), whichever the endpoint supports.
Each call has a 30 s deadline (LLD §6); timeouts, 408, 429 and 5xx are retryable, and the gateway
does the retrying.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

import httpx

from .base import LlmRequest, LlmResponse, OnDelta, ProviderError, Tier, Usage

JsonMode = Literal["json_schema", "json_object"]
CALL_TIMEOUT_S = 30.0


class OpenAICompatProvider:
    def __init__(
        self,
        name: str,
        base_url: str,
        api_key: str,
        models: dict[Tier, str],
        *,
        json_mode: JsonMode = "json_schema",
        timeout_s: float = CALL_TIMEOUT_S,
        client: httpx.AsyncClient | None = None,
    ):
        self.name = name
        self.url = base_url.rstrip("/") + "/chat/completions"
        self.models = models
        self.json_mode = json_mode
        self.timeout_s = timeout_s
        self.headers = {"Authorization": f"Bearer {api_key}"}
        # The deadline is enforced per call below; httpx's own timeouts (the same length) only bound a
        # stalled socket, and either one is a `timeout`.
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(timeout_s, connect=10.0))

    async def aclose(self) -> None:
        await self.client.aclose()

    def body(self, req: LlmRequest, stream: bool) -> dict[str, Any]:
        user = req.user
        body: dict[str, Any] = {
            "model": self.models[req.tier],
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
        }
        if req.schema is not None:
            if self.json_mode == "json_schema":
                body["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {"name": req.schema_name, "schema": req.schema},
                }
            else:
                body["response_format"] = {"type": "json_object"}
                user += "\n\nReply with one JSON object that matches this JSON Schema:\n" + json.dumps(req.schema)
        body["messages"] = [{"role": "system", "content": req.system}, {"role": "user", "content": user}]
        if stream:
            body["stream"] = True
            body["stream_options"] = {"include_usage": True}
        return body

    async def complete(self, req: LlmRequest) -> LlmResponse:
        try:
            async with asyncio.timeout(self.timeout_s):
                r = await self.client.post(self.url, json=self.body(req, False), headers=self.headers)
                check(r, r.text)
                data = r.json()
        except (TimeoutError, httpx.TimeoutException):
            raise ProviderError("timeout", f"{self.name}: no reply within {self.timeout_s:g} s", True) from None
        except httpx.TransportError as e:
            raise ProviderError("network", f"{self.name}: {type(e).__name__}: {e}", True) from None
        except ValueError as e:  # not JSON
            raise ProviderError("bad_response", f"{self.name}: {e}", True) from None
        try:
            choice = data["choices"][0]
            text = choice["message"].get("content") or ""
        except (KeyError, IndexError, TypeError, AttributeError):
            raise ProviderError("bad_response", f"{self.name}: no choices in the reply", True) from None
        return LlmResponse(text, data.get("model") or self.models[req.tier], usage(data.get("usage")),
                           choice.get("finish_reason") or "stop")

    async def stream(self, req: LlmRequest, on_delta: OnDelta) -> LlmResponse:
        parts: list[str] = []
        used, model, finish = Usage(), self.models[req.tier], "stop"
        try:
            async with asyncio.timeout(self.timeout_s):
                async with self.client.stream("POST", self.url, json=self.body(req, True), headers=self.headers) as r:
                    if r.status_code >= 400:
                        check(r, (await r.aread()).decode("utf-8", "replace"))
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        chunk = json.loads(payload)
                        model = chunk.get("model") or model
                        if chunk.get("usage"):
                            used = usage(chunk["usage"])
                        for choice in chunk.get("choices") or []:
                            if text := (choice.get("delta") or {}).get("content"):
                                parts.append(text)
                                await on_delta(text)
                            finish = choice.get("finish_reason") or finish
        except (TimeoutError, httpx.TimeoutException):
            raise ProviderError("timeout", f"{self.name}: stream not finished within {self.timeout_s:g} s", True) from None
        except httpx.TransportError as e:
            raise ProviderError("network", f"{self.name}: {type(e).__name__}: {e}", True) from None
        except ValueError as e:
            raise ProviderError("bad_response", f"{self.name}: {e}", True) from None
        return LlmResponse("".join(parts), model, used, finish)


def check(r: httpx.Response, body: str) -> None:
    if r.status_code < 400:
        return
    try:
        detail = json.loads(body)
        detail = detail[0] if isinstance(detail, list) else detail  # Gemini sometimes wraps it
        message = str((detail.get("error") or {}).get("message") or body)
    except (ValueError, AttributeError, IndexError):
        message = body
    message = f"HTTP {r.status_code}: {message[:300]}"
    if r.status_code == 429:
        raise ProviderError("rate_limited", message, True, retry_after(r))
    if r.status_code == 408 or r.status_code >= 500:
        raise ProviderError("server_error", message, True, retry_after(r))
    if r.status_code in (401, 403):
        raise ProviderError("auth", message, False)
    raise ProviderError("bad_request", message, False)


def retry_after(r: httpx.Response) -> float | None:
    try:
        return float(r.headers["retry-after"])
    except (KeyError, ValueError):
        return None


def usage(u: dict[str, Any] | None) -> Usage:
    if not u:
        return Usage()
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    return Usage(int(u.get("prompt_tokens") or 0), int(u.get("completion_tokens") or 0), int(cached))
