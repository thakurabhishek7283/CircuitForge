"""The gateway from the environment.

- `LLM_PROVIDER`: unset (generation is unavailable), `fake` (replies from `LLM_FAKE_SCRIPT`, a JSON
  file; see `fake.py`), `replay` (a cassette at `LLM_CASSETTE`), or a real provider: `gemini`,
  `deepseek`, `openai`.
- `LLM_FALLBACK_PROVIDER`: optional, another real provider tried after the first gives up.
- A real provider `P` takes its key from `P_API_KEY`, its endpoint from `P_BASE_URL` (Gemini and
  OpenAI have defaults), and its models from `P_MODEL_LARGE` / `P_MODEL_SMALL`, else `P_MODEL`
  for both, else, for the primary provider only, `LLM_MODEL_LARGE` / `LLM_MODEL_SMALL`.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

from .base import Provider
from .cassette import Replayer
from .fake import FakeProvider
from .gateway import Gateway
from .openai_compat import OpenAICompatProvider

# name -> (default base URL, structured output mode)
REAL = {
    "gemini": ("https://generativelanguage.googleapis.com/v1beta/openai", "json_schema"),
    # Azure AI Foundry's OpenAI v1 endpoint; DeepSeek models take json_object, not json_schema.
    "deepseek": (None, "json_object"),
    "openai": ("https://api.openai.com/v1", "json_schema"),
}


def provider_from_env(name: str, env: Mapping[str, str], *, primary: bool) -> Provider:
    if name not in REAL:
        raise RuntimeError(f"unknown LLM provider {name!r} (one of {', '.join(REAL)})")
    default_url, json_mode = REAL[name]
    p = name.upper()

    def get(key: str) -> str:
        return (env.get(key) or "").strip()

    key = get(f"{p}_API_KEY")
    if not key or "REPLACE_ME" in key:
        raise RuntimeError(f"{p}_API_KEY is not set")
    base_url = get(f"{p}_BASE_URL") or default_url
    if not base_url:
        raise RuntimeError(f"{p}_BASE_URL is not set")
    models = {}
    for tier in ("large", "small"):
        model = get(f"{p}_MODEL_{tier.upper()}") or get(f"{p}_MODEL") or (get(f"LLM_MODEL_{tier.upper()}") if primary else "")
        if not model:
            raise RuntimeError(f"no {tier} model for {name}: set {p}_MODEL_{tier.upper()} or {p}_MODEL")
        models[tier] = model
    return OpenAICompatProvider(name, base_url, key, models, json_mode=json_mode)


def gateway_from_env(env: Mapping[str, str] | None = None) -> Gateway | None:
    env = os.environ if env is None else env
    name = (env.get("LLM_PROVIDER") or "").strip().lower()
    if not name:
        return None
    if name == "fake":
        script = env.get("LLM_FAKE_SCRIPT")
        if not script:
            raise RuntimeError("LLM_PROVIDER=fake needs LLM_FAKE_SCRIPT (a JSON file of scripted replies)")
        return Gateway(FakeProvider.from_file(script))
    if name == "replay":
        cassette = env.get("LLM_CASSETTE")
        if not cassette:
            raise RuntimeError("LLM_PROVIDER=replay needs LLM_CASSETTE")
        return Gateway(Replayer.from_file(cassette))
    primary = provider_from_env(name, env, primary=True)
    fallback_name = (env.get("LLM_FALLBACK_PROVIDER") or "").strip().lower()
    fallback = provider_from_env(fallback_name, env, primary=False) if fallback_name else None
    return Gateway(primary, fallback)
