from __future__ import annotations

import json
from typing import Annotated, Any

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .. import projects
from ..auth import User
from ..errors import ApiException
from ..models.contract import AppendOk, CreateProject, GenerateRequest, JobAccepted, Project

router = APIRouter(prefix="/v1/projects", tags=["projects"])

MAX_PROMPT = 2000


class AppendOpsBody(BaseModel):
    """The wire `AppendOps`, with each envelope left as JSON: circuit-core's `apply()` validates it
    (re-parsing 30 op variants in Pydantic first would only duplicate that)."""

    model_config = ConfigDict(extra="forbid")
    base_rev: int = Field(ge=0)
    ops: list[dict[str, Any]]


@router.post("", status_code=201)
async def create_project(request: Request, user: User, body: Annotated[CreateProject | None, Body()] = None) -> Project:
    st = request.app.state
    async with st.engine.begin() as conn:
        row = await projects.create(conn, user, body.title if body else None, st.regs.current.version)
    return projects.project_model(row)


@router.get("/{project_id}")
async def get_project(project_id: str, request: Request, user: User) -> JSONResponse:
    """`ProjectSnapshot`. The circuit is circuit-core's own JSON, passed through unchanged."""
    st = request.app.state
    async with st.engine.connect() as conn:
        row = await projects.get_owned(conn, project_id, user)
        session = await projects.load_session(conn, st.regs, row)
        lesson = await projects.lesson(conn, row.id)
        active = await projects.active_job(conn, row.id)
    snapshot = {
        "project": projects.project_model(row).model_dump(mode="json"),
        "circuit": json.loads(session.snapshot()),
        "lesson": lesson,
        **({"active_job": str(active)} if active else {}),
    }
    return JSONResponse(snapshot)


@router.post("/{project_id}/ops")
async def append_ops(project_id: str, body: AppendOpsBody, request: Request, user: User) -> AppendOk:
    st = request.app.state
    if len(body.ops) > st.settings.max_ops_per_request:
        raise ApiException(413, "too_many_ops", f"at most {st.settings.max_ops_per_request} ops per request")
    async with st.engine.begin() as conn:
        row = await projects.get_owned(conn, project_id, user, lock=True)
        done = await projects.append(
            conn, st.regs, row, body.ops, base_rev=body.base_rev, snapshot_every=st.settings.snapshot_every
        )
    return AppendOk(rev=done.rev)


@router.post("/{project_id}/generate", status_code=202)
async def generate(project_id: str, body: GenerateRequest, request: Request, user: User) -> JobAccepted:
    prompt = body.prompt.strip()
    if not prompt or len(prompt) > MAX_PROMPT:
        raise ApiException(422, "invalid_request", f"prompt must be 1 to {MAX_PROMPT} characters")
    job_id = await request.app.state.runner.start(user, project_id, body.model_copy(update={"prompt": prompt}))
    return JobAccepted(job_id=str(job_id))
