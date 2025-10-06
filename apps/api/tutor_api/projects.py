"""Projects and their op log (LLD §11): every query is scoped by owner, and every IR change goes
through `circuit_core.Session.apply` before it is stored."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import circuit_core as cc
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from .db.tables import FINAL_STATES, jobs, lesson_track, ops, projects
from .errors import ApiException, not_found
from .models.contract import Project

DEFAULT_TITLE = "Untitled circuit"


class Registries:
    """The registry versions this server can open. A project keeps the version it was created
    with (LLD §12); only the current one is loaded until a second version ships."""

    def __init__(self, registry_dir: Path):
        self.current = cc.load_registry_dir(registry_dir)
        self._by_version = {self.current.version: self.current}

    def get(self, version: str) -> cc.Registry:
        reg = self._by_version.get(version)
        if reg is None:
            raise ApiException(409, "registry_unavailable", f"registry {version} is not available on this server")
        return reg


def project_model(row: Any) -> Project:
    return Project(
        id=str(row.id),
        title=row.title,
        registry_version=row.registry_version,
        head_rev=row.head_rev,
        created_at=row.created_at.isoformat(),
        updated_at=row.updated_at.isoformat(),
    )


async def create(conn: AsyncConnection, owner: uuid.UUID, title: str | None, registry_version: str) -> Any:
    now = datetime.now(UTC)
    row = (
        await conn.execute(
            insert(projects)
            .values(
                id=uuid.uuid4(),
                owner_id=owner,
                title=(title or "").strip() or DEFAULT_TITLE,
                registry_version=registry_version,
                created_at=now,
                updated_at=now,
            )
            .returning(projects)
        )
    ).one()
    return row


async def get_owned(conn: AsyncConnection, project_id: str, owner: uuid.UUID, *, lock: bool = False) -> Any:
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        raise not_found("project") from None
    q = select(projects).where(projects.c.id == pid, projects.c.owner_id == owner)
    row = (await conn.execute(q.with_for_update() if lock else q)).one_or_none()
    if row is None:
        raise not_found("project")
    return row


async def load_session(conn: AsyncConnection, regs: Registries, row: Any) -> cc.Session:
    """The circuit at `row.head_rev`: the snapshot, then the ops after it, folded by circuit-core."""
    reg = regs.get(row.registry_version)
    snapshot = json.dumps(row.snapshot) if row.snapshot is not None else None
    s = cc.Session(reg, snapshot)
    later = await conn.execute(
        select(ops.c.op).where(ops.c.project_id == row.id, ops.c.seq > row.snapshot_rev).order_by(ops.c.seq)
    )
    for (op,) in later:
        cc.unwrap(s.apply(json.dumps(op)))
    if s.rev != row.head_rev:
        raise RuntimeError(f"project {row.id}: op log folds to rev {s.rev}, head_rev is {row.head_rev}")
    return s


async def active_job(conn: AsyncConnection, project_id: uuid.UUID) -> uuid.UUID | None:
    return (
        await conn.execute(
            select(jobs.c.id).where(jobs.c.project_id == project_id, jobs.c.state.not_in(FINAL_STATES))
        )
    ).scalar_one_or_none()


@dataclass
class Appended:
    rev: int
    envelopes: list[dict[str, Any]]


async def append(
    conn: AsyncConnection,
    regs: Registries,
    row: Any,
    envelopes: list[dict[str, Any]],
    *,
    base_rev: int,
    snapshot_every: int,
    job_id: uuid.UUID | None = None,
) -> Appended:
    """Apply `envelopes` to the project in `row` (locked by the caller with `get_owned(lock=True)`)
    and store them. User ops (`job_id` None) may be authored `user` or `template` (a block the
    editor inserted); a job's ops carry its id. Rejects the whole batch on the first bad op."""
    active = await active_job(conn, row.id)
    if job_id is None and active is not None:
        raise ApiException(409, "job_running", "a generation job is editing this project; wait for it to finish")
    if job_id is not None and active != job_id:
        raise ApiException(409, "job_not_active", "the job has finished or was cancelled")
    if base_rev != row.head_rev:
        raise ApiException(409, "stale_rev", f"base_rev {base_rev} but the project is at rev {row.head_rev}")
    allowed = {"llm", "template"} if job_id else {"user", "template"}
    s = await load_session(conn, regs, row)
    for i, env in enumerate(envelopes):
        author, job = env.get("author"), env.get("job")
        if author not in allowed:
            raise ApiException(422, "author_invalid", f"op {i}: author {author!r} is not allowed here")
        if (job_id is None and job is not None) or (job_id is not None and job != str(job_id)):
            raise ApiException(422, "job_invalid", f"op {i}: job {job!r} does not match")
        if env.get("op") == "narrate":
            raise ApiException(422, "unknown_op", f"op {i}: narration goes to the lesson track, not the op log")
        out = json.loads(s.apply(json.dumps(env)))
        if "err" in out:
            e = out["err"]
            raise ApiException(422, e["code"], f"op {i}: {e['message']}")
    rev = s.rev
    now = datetime.now(UTC)
    # Every op in the log bumps rev by one (narration never enters it), so seq == rev_after.
    rows = [
        {"project_id": row.id, "seq": base_rev + i + 1, "rev_after": base_rev + i + 1, "author": env["author"],
         "job_id": job_id, "op": env, "created_at": now}
        for i, env in enumerate(envelopes)
    ]
    if rows:
        await conn.execute(insert(ops), rows)
    values: dict[str, Any] = {"head_rev": rev, "updated_at": now}
    if rev - row.snapshot_rev >= snapshot_every:
        values |= {"snapshot": json.loads(s.snapshot()), "snapshot_rev": rev}
    await conn.execute(update(projects).where(projects.c.id == row.id).values(**values))
    return Appended(rev, envelopes)


async def write_snapshot(conn: AsyncConnection, regs: Registries, row: Any) -> None:
    """Snapshot at head (end of every job, LLD §11)."""
    if row.snapshot_rev == row.head_rev:
        return
    s = await load_session(conn, regs, row)
    await conn.execute(
        update(projects).where(projects.c.id == row.id).values(snapshot=json.loads(s.snapshot()), snapshot_rev=s.rev)
    )


async def lesson(conn: AsyncConnection, project_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = await conn.execute(select(lesson_track).where(lesson_track.c.project_id == project_id).order_by(lesson_track.c.seq))
    return [
        {"seq": r.seq, **({"block": r.block_id} if r.block_id else {}), "kind": r.kind, "text": r.text, "refs": list(r.refs)}
        for r in rows
    ]


async def add_lesson(
    conn: AsyncConnection, project_id: uuid.UUID, kind: str, text: str, block: str | None, refs: list[str]
) -> int:
    seq = (
        await conn.execute(select(func.coalesce(func.max(lesson_track.c.seq), 0) + 1).where(lesson_track.c.project_id == project_id))
    ).scalar_one()
    await conn.execute(
        insert(lesson_track).values(project_id=project_id, seq=seq, block_id=block, kind=kind, text=text, refs=refs)
    )
    return seq
