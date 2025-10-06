"""App factory (LLD §2): `uvicorn --factory tutor_api.main:create_app`."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sim_runner import client as sim_client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from . import errors
from .config import Settings
from .jobs import reaper
from .jobs.events import EventLog
from .jobs.runner import JobRunner, Orchestrator
from .projects import Registries
from .routers import auth, jobs, projects


def create_app(settings: Settings | None = None, orchestrator: Orchestrator | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        st = app.state
        st.settings = settings
        st.regs = Registries(settings.registry_dir)
        st.engine = create_async_engine(settings.database_url, pool_size=10, max_overflow=10, pool_pre_ping=True)
        # One Redis pool for job events and the simulation queue (sim_runner's JSON-serializing arq pool).
        st.redis = await sim_client.connect(settings.redis_url)
        st.events = EventLog(st.redis)
        st.runner = JobRunner(engine=st.engine, redis=st.redis, regs=st.regs, settings=settings, orchestrator=orchestrator)
        reaping = asyncio.create_task(reaper.run_forever(st.engine, st.redis, st.events, settings.reaper_interval_s))
        try:
            yield
        finally:
            reaping.cancel()
            await st.runner.shutdown()
            await st.redis.aclose()
            await st.engine.dispose()

    app = FastAPI(title="Circuit Forge API", version="0.1.0", lifespan=lifespan)
    errors.install(app)
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type", "Last-Event-ID"],
        )
    for r in (auth.router, projects.router, jobs.router):
        app.include_router(r)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", include_in_schema=False)
    async def readyz(request: Request) -> JSONResponse:
        """Postgres and Redis reachable (LLD §14: without them, generation returns 503)."""
        st = request.app.state
        checks = {}
        try:
            async with st.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            checks["postgres"] = "ok"
        except Exception as e:  # noqa: BLE001
            checks["postgres"] = type(e).__name__
        try:
            await st.redis.ping()
            checks["redis"] = "ok"
        except Exception as e:  # noqa: BLE001
            checks["redis"] = type(e).__name__
        ok = all(v == "ok" for v in checks.values())
        return JSONResponse(checks, status_code=200 if ok else 503)

    return app
