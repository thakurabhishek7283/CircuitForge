"""The LLM layer without a real provider: the OpenAI-compatible adapter against a mock server on a
local socket (JSON and streamed replies, errors, the deadline), the gateway's retries and fallback,
cassettes, and provider configuration from the environment."""

from __future__ import annotations

import asyncio
import json
import socket
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from tutor_api.llm.base import LlmRequest, LlmResponse, ProviderError, Usage
from tutor_api.llm.cassette import CassetteMiss, Recorder, Replayer
from tutor_api.llm.config import gateway_from_env
from tutor_api.llm.fake import FakeProvider
from tutor_api.llm.gateway import Gateway, LlmUnavailable
from tutor_api.llm.openai_compat import OpenAICompatProvider

SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}
REQ = LlmRequest("plan", "large", "SYSTEM PREFIX", "the request", schema=SCHEMA, schema_name="plan", max_tokens=100)


def completion(text: str, *, model: str = "m-large", cached: int = 0, finish: str = "stop") -> dict[str, Any]:
    return {
        "id": "x", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
        "usage": {"prompt_tokens": 120, "completion_tokens": 7, "total_tokens": 127,
                  "prompt_tokens_details": {"cached_tokens": cached}},
    }


def sse(chunks: list[str], usage: dict[str, Any] | None = None) -> StreamingResponse:
    async def body() -> AsyncIterator[bytes]:
        for c in chunks:
            yield f"data: {json.dumps({'model': 'm-small', 'choices': [{'index': 0, 'delta': {'content': c}}]})}\n\n".encode()
            await asyncio.sleep(0.01)
        yield f"data: {json.dumps({'model': 'm-small', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n".encode()
        if usage:
            yield f"data: {json.dumps({'model': 'm-small', 'choices': [], 'usage': usage})}\n\n".encode()
        yield b"data: [DONE]\n\n"

    return StreamingResponse(body(), media_type="text/event-stream")


class MockLLM:
    """An OpenAI-compatible endpoint: each request is answered by the next queued handler."""

    def __init__(self) -> None:
        self.handlers: list[Callable[[dict[str, Any]], Any]] = []
        self.requests: list[tuple[dict[str, str], dict[str, Any]]] = []

    async def chat(self, request: Request) -> Response:
        body = await request.json()
        self.requests.append((dict(request.headers), body))
        handler = self.handlers.pop(0)
        out = handler(body)
        if asyncio.iscoroutine(out):
            out = await out
        return out if isinstance(out, Response) else JSONResponse(out)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
async def mock_server() -> AsyncIterator[tuple[str, MockLLM]]:
    mock = MockLLM()
    app = Starlette(routes=[Route("/v1/chat/completions", mock.chat, methods=["POST"])])
    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(srv.serve())
    while not srv.started:
        await asyncio.sleep(0.02)
    yield f"http://127.0.0.1:{port}/v1", mock
    srv.should_exit = True
    await task


@pytest.fixture
def mock(mock_server) -> MockLLM:
    url, m = mock_server
    m.handlers.clear()
    m.requests.clear()
    return m


def provider(mock_server, json_mode="json_schema", timeout_s=5.0, name="gemini") -> OpenAICompatProvider:
    return OpenAICompatProvider(name, mock_server[0], "test-key", {"large": "m-large", "small": "m-small"},
                                json_mode=json_mode, timeout_s=timeout_s)


async def test_complete_sends_the_schema_and_reads_usage(mock_server, mock):
    mock.handlers.append(lambda body: completion('{"ok": true}', cached=96))
    resp = await provider(mock_server).complete(REQ)
    assert resp == LlmResponse('{"ok": true}', "m-large", Usage(120, 7, 96), "stop")
    headers, body = mock.requests[0]
    assert headers["authorization"] == "Bearer test-key"
    assert body["model"] == "m-large" and body["max_tokens"] == 100 and "stream" not in body
    assert body["messages"] == [{"role": "system", "content": "SYSTEM PREFIX"}, {"role": "user", "content": "the request"}]
    assert body["response_format"] == {"type": "json_schema", "json_schema": {"name": "plan", "schema": SCHEMA}}


async def test_json_object_mode_puts_the_schema_in_the_prompt(mock_server, mock):
    """DeepSeek on Azure AI Foundry: any JSON object; the system prefix stays unchanged (cacheable)."""
    mock.handlers.append(lambda body: completion('{"ok": false}'))
    await provider(mock_server, json_mode="json_object", name="deepseek").complete(REQ)
    body = mock.requests[0][1]
    assert body["response_format"] == {"type": "json_object"}
    assert body["messages"][0]["content"] == "SYSTEM PREFIX"
    user = body["messages"][1]["content"]
    assert user.startswith("the request\n\n") and json.dumps(SCHEMA) in user


async def test_a_cut_off_reply_reports_its_finish_reason(mock_server, mock):
    mock.handlers.append(lambda body: completion('{"ok": tr', finish="length"))
    assert (await provider(mock_server).complete(REQ)).finish_reason == "length"


async def test_stream_delivers_deltas_in_order_and_the_final_usage(mock_server, mock):
    mock.handlers.append(lambda body: sse(["An RC ", "low-pass ", "filter."], {"prompt_tokens": 50, "completion_tokens": 5}))
    seen: list[str] = []

    async def on_delta(t: str) -> None:
        seen.append(t)

    req = LlmRequest("narrate", "small", "SYSTEM PREFIX", "narrate it", max_tokens=50)
    resp = await provider(mock_server).stream(req, on_delta)
    assert seen == ["An RC ", "low-pass ", "filter."]
    assert resp == LlmResponse("An RC low-pass filter.", "m-small", Usage(50, 5, 0), "stop")
    body = mock.requests[0][1]
    assert body["stream"] is True and body["stream_options"] == {"include_usage": True} and body["model"] == "m-small"
    assert "response_format" not in body


@pytest.mark.parametrize(
    "status, payload, code, retryable, retry_after",
    [
        (429, {"error": {"message": "quota"}}, "rate_limited", True, 2.0),
        (503, {"error": {"message": "overloaded"}}, "server_error", True, None),
        (401, {"error": {"message": "bad key"}}, "auth", False, None),
        (400, [{"error": {"message": "schema not supported"}}], "bad_request", False, None),
    ],
)
async def test_http_errors_are_classified(mock_server, mock, status, payload, code, retryable, retry_after):
    headers = {"retry-after": "2"} if retry_after else {}
    mock.handlers.append(lambda body: JSONResponse(payload, status_code=status, headers=headers))
    with pytest.raises(ProviderError) as e:
        await provider(mock_server).complete(REQ)
    assert (e.value.code, e.value.retryable, e.value.retry_after_s) == (code, retryable, retry_after)
    assert f"HTTP {status}" in e.value.message
    want = payload[0] if isinstance(payload, list) else payload
    assert want["error"]["message"] in e.value.message


async def test_streamed_errors_are_classified_too(mock_server, mock):
    mock.handlers.append(lambda body: JSONResponse({"error": {"message": "busy"}}, status_code=500))

    async def on_delta(t: str) -> None:
        raise AssertionError("no delta expected")

    with pytest.raises(ProviderError) as e:
        await provider(mock_server).stream(REQ, on_delta)
    assert e.value.code == "server_error" and "busy" in e.value.message


async def test_a_slow_reply_hits_the_call_deadline(mock_server, mock):
    async def slow(body):
        await asyncio.sleep(1.0)
        return completion("{}")

    mock.handlers.append(slow)
    with pytest.raises(ProviderError) as e:
        await provider(mock_server, timeout_s=0.2).complete(REQ)
    assert e.value.code == "timeout" and e.value.retryable


async def test_gateway_retries_then_falls_back(mock_server, mock):
    """LLD §14: retry twice with backoff, then the fallback provider."""
    for _ in range(3):
        mock.handlers.append(lambda body: JSONResponse({"error": {"message": "down"}}, status_code=503))
    mock.handlers.append(lambda body: completion('{"ok": true}', model="fallback-large"))
    primary = provider(mock_server)
    fallback = OpenAICompatProvider("deepseek", mock_server[0], "other-key", {"large": "fallback-large", "small": "x"})
    resp = await Gateway(primary, fallback, backoff_s=0.01).complete(REQ)
    assert resp.model == "fallback-large"
    assert [h["authorization"] for h, _ in mock.requests] == ["Bearer test-key"] * 3 + ["Bearer other-key"]


async def test_gateway_does_not_retry_a_non_retryable_error(mock_server, mock):
    mock.handlers.append(lambda body: JSONResponse({"error": {"message": "bad key"}}, status_code=401))
    with pytest.raises(LlmUnavailable) as e:
        await Gateway(provider(mock_server), backoff_s=0.01).complete(REQ)
    assert e.value.last.code == "auth" and len(mock.requests) == 1


async def test_gateway_never_repeats_a_stream_that_has_started():
    calls = 0

    class Flaky:
        name = "flaky"

        async def stream(self, req, on_delta):
            nonlocal calls
            calls += 1
            await on_delta("Half a sentence ")
            raise ProviderError("network", "connection reset", True)

    seen: list[str] = []

    async def on_delta(t: str) -> None:
        seen.append(t)

    with pytest.raises(LlmUnavailable):
        await Gateway(Flaky(), backoff_s=0).stream(REQ, on_delta)
    assert calls == 1 and seen == ["Half a sentence "]


async def test_cassettes_record_and_replay_in_order(tmp_path):
    fake = FakeProvider({"plan": [{"n": 1}, {"n": 2}, ProviderError("server_error", "down", True)],
                         "narrate": ["One two three."]})
    rec = Recorder(fake)
    first = await rec.complete(REQ)
    second = await rec.complete(REQ)  # the same request twice: replayed in recorded order
    with pytest.raises(ProviderError):
        await rec.complete(REQ)
    narrate = LlmRequest("narrate", "small", "S", "U")
    seen: list[str] = []

    async def on_delta(t: str) -> None:
        seen.append(t)

    told = await rec.stream(narrate, on_delta)
    path = tmp_path / "c.json"
    rec.save(path)

    rep = Replayer.from_file(path)
    assert await rep.complete(REQ) == first and await rep.complete(REQ) == second
    with pytest.raises(ProviderError) as e:
        await rep.complete(REQ)
    assert e.value.code == "server_error" and e.value.retryable
    again: list[str] = []

    async def on_delta2(t: str) -> None:
        again.append(t)

    assert await rep.stream(narrate, on_delta2) == told and again == seen == ["One ", "two ", "three."]
    assert rep.unused() == 0
    changed = LlmRequest("plan", "large", "SYSTEM PREFIX", "the request, reworded", schema=SCHEMA, schema_name="plan",
                         max_tokens=100)
    with pytest.raises(CassetteMiss):
        await rep.complete(changed)
    # A miss is not a ProviderError: no retry or fallback can hide a stale cassette.
    assert not issubclass(CassetteMiss, ProviderError)


def test_providers_from_the_environment():
    assert gateway_from_env({}) is None
    env = {
        "LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "k1",
        "LLM_MODEL_LARGE": "gemini-3.5-flash", "LLM_MODEL_SMALL": "gemini-3.5-flash-lite",
        "LLM_FALLBACK_PROVIDER": "deepseek", "DEEPSEEK_API_KEY": "k2",
        "DEEPSEEK_BASE_URL": "https://example.services.ai.azure.com/openai/v1/", "DEEPSEEK_MODEL": "DeepSeek-V4-Pro",
    }
    gw = gateway_from_env(env)
    gemini, deepseek = gw.providers
    assert gemini.url == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert gemini.models == {"large": "gemini-3.5-flash", "small": "gemini-3.5-flash-lite"}
    assert gemini.json_mode == "json_schema" and gemini.headers == {"Authorization": "Bearer k1"}
    assert deepseek.url == "https://example.services.ai.azure.com/openai/v1/chat/completions"
    # The fallback never takes the primary's LLM_MODEL_* (those are Gemini model ids).
    assert deepseek.models == {"large": "DeepSeek-V4-Pro", "small": "DeepSeek-V4-Pro"}
    assert deepseek.json_mode == "json_object"

    with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
        gateway_from_env({"LLM_PROVIDER": "gemini", "GEMINI_API_KEY": "REPLACE_ME"})
    with pytest.raises(RuntimeError, match="DEEPSEEK_BASE_URL"):
        gateway_from_env({"LLM_PROVIDER": "deepseek", "DEEPSEEK_API_KEY": "k", "DEEPSEEK_MODEL": "m"})
    with pytest.raises(RuntimeError, match="LLM_FAKE_SCRIPT"):
        gateway_from_env({"LLM_PROVIDER": "fake"})
    with pytest.raises(RuntimeError, match="unknown LLM provider"):
        gateway_from_env({"LLM_PROVIDER": "apmix"})


def test_fake_provider_from_a_script_file(tmp_path):
    path = tmp_path / "script.json"
    path.write_text(json.dumps({"plan": [{"blocks": []}], "narrate": ["Hi."]}), encoding="utf-8")
    gw = gateway_from_env({"LLM_PROVIDER": "fake", "LLM_FAKE_SCRIPT": str(path)})
    resp = asyncio.run(gw.complete(REQ))
    assert json.loads(resp.text) == {"blocks": []} and resp.model == "fake-large"
