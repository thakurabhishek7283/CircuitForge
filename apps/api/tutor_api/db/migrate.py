"""`python -m tutor_api.db.migrate`: bring the database at DATABASE_URL to the latest schema.

Deployments run it once before starting the API (compose's `migrate` service)."""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import asyncpg
from alembic import command
from alembic.config import Config


def config(database_url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).with_name("migrations")))
    cfg.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return cfg


def upgrade(database_url: str, revision: str = "head") -> None:
    command.upgrade(config(database_url), revision)


def wait_until_ready(database_url: str, timeout_s: float = 30.0) -> None:
    """Until a real connection succeeds. A server's "ready" (its log line, or a health check) is not
    always enough: Docker Desktop's port forward on Windows can accept and then drop the first
    connections (asyncpg `ConnectionError: unexpected connection_lost()`), which once failed every
    database test of a run."""
    dsn = database_url.replace("postgresql+asyncpg://", "postgresql://")

    async def probe() -> None:
        conn = await asyncpg.connect(dsn, timeout=5)
        await conn.close()

    deadline = time.monotonic() + timeout_s
    while True:
        try:
            asyncio.run(probe())
            return
        except (OSError, ConnectionError, asyncpg.PostgresError):
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)


if __name__ == "__main__":
    wait_until_ready(os.environ["DATABASE_URL"])
    upgrade(os.environ["DATABASE_URL"])
