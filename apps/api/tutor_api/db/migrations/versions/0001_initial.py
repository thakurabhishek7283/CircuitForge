"""LLD §11 schema (as built: see db/tables.py).

Revision ID: 0001
Create Date: 2025-09-30
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

FINAL = "('done','failed','cancelled')"

UP = f"""
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
  id uuid PRIMARY KEY, email citext UNIQUE,
  level text NOT NULL DEFAULT 'beginner', plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL, registry_version text NOT NULL,
  head_rev bigint NOT NULL DEFAULT 0,
  snapshot json, snapshot_rev bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner ON projects (owner_id, updated_at DESC);

CREATE TABLE ops (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq bigint NOT NULL, rev_after bigint NOT NULL,
  author text NOT NULL CHECK (author IN ('llm','user','template')),
  job_id uuid, op json NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq)
);

CREATE TABLE lesson_track (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq bigint NOT NULL, block_id text,
  kind text NOT NULL CHECK (kind IN ('narration','note','repair')),
  text text NOT NULL, refs text[] NOT NULL DEFAULT '{{}}',
  PRIMARY KEY (project_id, seq)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  prompt text NOT NULL, mode text NOT NULL, state text NOT NULL,
  plan jsonb, error_code text, model text,
  in_tokens int NOT NULL DEFAULT 0, out_tokens int NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX jobs_user_recent ON jobs (user_id, started_at DESC);
-- v1 is single-writer (LLD §4): at most one unfinished job per project.
CREATE UNIQUE INDEX jobs_one_active ON jobs (project_id) WHERE state NOT IN {FINAL};

CREATE TABLE block_attempts (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  block_id text NOT NULL, attempt smallint NOT NULL,
  ops jsonb NOT NULL, errors jsonb NOT NULL DEFAULT '[]',
  sim_checks jsonb, latency_ms int,
  PRIMARY KEY (job_id, block_id, attempt)
);

CREATE TABLE templates (
  id text NOT NULL, version int NOT NULL, role text NOT NULL,
  title text NOT NULL, description text NOT NULL,
  body jsonb NOT NULL, verified_registry_version text NOT NULL,
  embedding vector(1024),
  PRIMARY KEY (id, version)
);
CREATE INDEX templates_emb ON templates USING hnsw (embedding vector_cosine_ops);

CREATE TABLE parts (
  id text NOT NULL, registry_version text NOT NULL,
  category text NOT NULL, role_tags text[] NOT NULL,
  description text NOT NULL, meta jsonb NOT NULL,
  embedding vector(1024),
  PRIMARY KEY (id, registry_version)
);
CREATE INDEX parts_emb ON parts USING hnsw (embedding vector_cosine_ops);
"""


def upgrade() -> None:
    for statement in UP.split(";\n"):
        if statement.strip():
            op.execute(statement)


def downgrade() -> None:
    for table in ("parts", "templates", "block_attempts", "jobs", "lesson_track", "ops", "projects", "users"):
        op.execute(f"DROP TABLE {table}")
