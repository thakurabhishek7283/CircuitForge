"""Settings from the environment (the repository's .env holds the local values)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    auth_secret: str
    registry_dir: Path = REPO / "registry"
    # LLD §1/§6 limits
    job_timeout_s: float = 120.0
    snapshot_every: int = 200  # ops between project snapshots (LLD §11)
    max_ops_per_request: int = 1000
    anonymous_token_ttl_s: int = 30 * 24 * 3600
    reaper_interval_s: float = 10.0
    cors_origins: list[str] = field(default_factory=list)

    @staticmethod
    def from_env() -> Settings:
        def need(name: str) -> str:
            value = os.environ.get(name, "")
            if not value:
                raise RuntimeError(f"{name} is not set")
            return value

        secret = need("AUTH_TOKEN_SECRET")
        if len(secret) < 32 or "REPLACE_ME" in secret:
            raise RuntimeError("AUTH_TOKEN_SECRET must be a random string of at least 32 characters")
        origins = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o]
        return Settings(
            database_url=need("DATABASE_URL"),
            redis_url=need("REDIS_URL"),
            auth_secret=secret,
            registry_dir=Path(os.environ.get("REGISTRY_DIR") or REPO / "registry"),
            cors_origins=origins,
        )
