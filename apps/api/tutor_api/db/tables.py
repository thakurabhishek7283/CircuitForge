"""The LLD §11 tables, for queries (SQLAlchemy Core). The schema itself is created by the Alembic
migrations in db/migrations; tests/test_db.py checks that the two agree.

As built: `users.email` is nullable (anonymous users have none until Phase 4 auth); a partial
unique index allows one unfinished job per project (v1 is single-writer, LLD §4); project
snapshots and op envelopes are `json`, not `jsonb`, which reorders object keys (a reloaded circuit
would list its parts in another order than the live one); `asks` and `usage_daily` arrive with the
tutor (Phase 3) and quotas (Phase 4).
"""

from __future__ import annotations

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Column,
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    MetaData,
    SmallInteger,
    Table,
    Text,
    Uuid,
)
from sqlalchemy.dialects.postgresql import CITEXT, JSONB
from sqlalchemy.types import UserDefinedType

FINAL_STATES = ("done", "failed", "cancelled")

metadata = MetaData()


class Vector(UserDefinedType):
    """pgvector's `vector(n)`; nothing reads or writes embeddings yet (LLD §11 retrieval)."""

    cache_ok = True

    def __init__(self, dim: int):
        self.dim = dim

    def get_col_spec(self, **kw) -> str:
        return f"vector({self.dim})"


users = Table(
    "users",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("email", CITEXT, unique=True),
    Column("level", Text, nullable=False, server_default="beginner"),
    Column("plan", Text, nullable=False, server_default="free"),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

projects = Table(
    "projects",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("owner_id", Uuid, ForeignKey("users.id"), nullable=False),
    Column("title", Text, nullable=False),
    Column("registry_version", Text, nullable=False),
    Column("head_rev", BigInteger, nullable=False, server_default="0"),
    Column("snapshot", JSON),
    Column("snapshot_rev", BigInteger, nullable=False, server_default="0"),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("updated_at", DateTime(timezone=True), nullable=False),
)

ops = Table(
    "ops",
    metadata,
    Column("project_id", Uuid, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    Column("seq", BigInteger, primary_key=True),
    Column("rev_after", BigInteger, nullable=False),
    Column("author", Text, nullable=False),
    Column("job_id", Uuid),
    Column("op", JSON, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)

lesson_track = Table(
    "lesson_track",
    metadata,
    Column("project_id", Uuid, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
    Column("seq", BigInteger, primary_key=True),
    Column("block_id", Text),
    Column("kind", Text, nullable=False),
    Column("text", Text, nullable=False),
    Column("refs", ARRAY(Text), nullable=False, server_default="{}"),
)

jobs = Table(
    "jobs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("project_id", Uuid, ForeignKey("projects.id"), nullable=False),
    Column("user_id", Uuid, ForeignKey("users.id"), nullable=False),
    Column("prompt", Text, nullable=False),
    Column("mode", Text, nullable=False),
    Column("state", Text, nullable=False),
    Column("plan", JSONB),
    Column("error_code", Text),
    Column("model", Text),
    Column("in_tokens", Integer, nullable=False, server_default="0"),
    Column("out_tokens", Integer, nullable=False, server_default="0"),
    Column("started_at", DateTime(timezone=True), nullable=False),
    Column("finished_at", DateTime(timezone=True)),
)

block_attempts = Table(
    "block_attempts",
    metadata,
    Column("job_id", Uuid, ForeignKey("jobs.id", ondelete="CASCADE"), primary_key=True),
    Column("block_id", Text, primary_key=True),
    Column("attempt", SmallInteger, primary_key=True),
    Column("ops", JSONB, nullable=False),
    Column("errors", JSONB, nullable=False, server_default="[]"),
    Column("sim_checks", JSONB),
    Column("latency_ms", Integer),
)

templates = Table(
    "templates",
    metadata,
    Column("id", Text, primary_key=True),
    Column("version", Integer, primary_key=True),
    Column("role", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("description", Text, nullable=False),
    Column("body", JSONB, nullable=False),
    Column("verified_registry_version", Text, nullable=False),
    Column("embedding", Vector(1024)),
)

parts = Table(
    "parts",
    metadata,
    Column("id", Text, primary_key=True),
    Column("registry_version", Text, primary_key=True),
    Column("category", Text, nullable=False),
    Column("role_tags", ARRAY(Text), nullable=False),
    Column("description", Text, nullable=False),
    Column("meta", JSONB, nullable=False),
    Column("embedding", Vector(1024)),
)
