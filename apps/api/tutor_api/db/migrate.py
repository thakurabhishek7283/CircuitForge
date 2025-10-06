"""`python -m tutor_api.db.migrate`: bring the database at DATABASE_URL to the latest schema.

Deployments run it once before starting the API (compose's `migrate` service)."""

from __future__ import annotations

import os
from pathlib import Path

from alembic import command
from alembic.config import Config


def config(database_url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(__file__).with_name("migrations")))
    cfg.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    return cfg


def upgrade(database_url: str, revision: str = "head") -> None:
    command.upgrade(config(database_url), revision)


if __name__ == "__main__":
    upgrade(os.environ["DATABASE_URL"])
