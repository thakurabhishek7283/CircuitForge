"""Postgres 16 + pgvector and Redis 7 in testcontainers, the migrations, and the API served by a
real uvicorn on a free port (SSE is tested over a socket, not an in-process transport).

Without Docker the tests skip locally; CI sets REQUIRE_DOCKER=1 so they cannot skip there.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import socket
from collections.abc import AsyncIterator

import httpx
import pytest
import uvicorn

from scripted import Scripted
from tutor_api.config import Settings
from tutor_api.db import migrate
from tutor_api.main import create_app


def docker_available() -> bool:
    try:
        import docker

        docker.from_env().ping()
        return True
    except Exception:  # noqa: BLE001
        return False


def ngspice_available() -> bool:
    from sim_runner import ngspice_batch

    return ngspice_batch.ngspice_path() is not None


def pytest_collection_modifyitems(config, items):
    """Skip what needs Docker (the databases) or ngspice (the sim worker) when they are missing;
    with REQUIRE_DOCKER / REQUIRE_NGSPICE set (CI), fail instead."""
    needs = [
        ({"database_url", "redis_url"}, docker_available, "REQUIRE_DOCKER",
         "Docker is not running (testcontainers Postgres and Redis)"),
        ({"sim_worker"}, ngspice_available, "REQUIRE_NGSPICE", "ngspice not built: run third_party/ngspice/build-native.sh"),
    ]
    for fixtures, available, env, msg in needs:
        users = [i for i in items if fixtures & set(i.fixturenames)]
        if not users or available():
            continue
        if os.environ.get(env):
            raise pytest.UsageError(msg)
        for item in users:
            item.add_marker(pytest.mark.skip(reason=msg))


@pytest.fixture(scope="session")
def database_url() -> str:
    from testcontainers.core.container import DockerContainer
    from testcontainers.core.wait_strategies import LogMessageWaitStrategy

    # The image logs "ready" twice: once for its init run, once for the real server.
    ready = LogMessageWaitStrategy("database system is ready to accept connections", times=2).with_startup_timeout(90)
    pg = (
        DockerContainer("pgvector/pgvector:pg16")
        .with_env("POSTGRES_USER", "tutor")
        .with_env("POSTGRES_PASSWORD", "tutor")
        .with_env("POSTGRES_DB", "tutor")
        .with_exposed_ports(5432)
        .waiting_for(ready)
    )
    with pg:
        url = f"postgresql+asyncpg://tutor:tutor@{pg.get_container_host_ip()}:{pg.get_exposed_port(5432)}/tutor"
        migrate.wait_until_ready(url)
        migrate.upgrade(url)
        yield url


@pytest.fixture(scope="session")
def redis_url() -> str:
    from testcontainers.core.container import DockerContainer
    from testcontainers.core.wait_strategies import LogMessageWaitStrategy

    ready = LogMessageWaitStrategy("Ready to accept connections").with_startup_timeout(60)
    with DockerContainer("redis:7-alpine").with_exposed_ports(6379).waiting_for(ready) as c:
        yield f"redis://{c.get_container_host_ip()}:{c.get_exposed_port(6379)}/0"


@pytest.fixture(scope="session")
async def sim_worker(redis_url) -> AsyncIterator[None]:
    """The sim_runner worker consuming the test Redis's queue in this event loop, as in
    workers/sim_runner/tests: the orchestrator's benches run on the native ngspice."""
    from arq.worker import Worker
    from sim_runner import client as sim_client
    from sim_runner import worker as w

    redis = await sim_client.connect(redis_url)
    s = w.WorkerSettings
    worker = Worker(
        functions=s.functions, queue_name=s.queue_name, redis_pool=redis, max_jobs=4, keep_result=s.keep_result,
        poll_delay=s.poll_delay, job_serializer=s.job_serializer, job_deserializer=s.job_deserializer,
        on_startup=s.on_startup, handle_signals=False,
    )
    main = asyncio.create_task(worker.async_run())
    yield
    # Worker.close() signals itself with SIGUSR1, which Windows lacks.
    tasks = [main, *worker.tasks.values()]
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await redis.aclose()


@pytest.fixture(scope="session")
def settings(database_url, redis_url) -> Settings:
    return Settings(
        database_url=database_url,
        redis_url=redis_url,
        auth_secret=secrets.token_urlsafe(32),
        job_timeout_s=3.0,
        snapshot_every=5,
        reaper_interval_s=3600,  # the reaper test calls reap_once itself
    )


@pytest.fixture(scope="session")
def orchestrator() -> Scripted:
    return Scripted()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
async def server(settings, orchestrator) -> AsyncIterator[tuple[str, object]]:
    """(base URL, app) of the API running in this event loop."""
    app = create_app(settings, orchestrator)
    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", lifespan="on"))
    task = asyncio.create_task(srv.serve())
    while not srv.started:
        if task.done():
            task.result()
        await asyncio.sleep(0.02)
    yield f"http://127.0.0.1:{port}", app
    srv.should_exit = True
    await task


@pytest.fixture
async def http(server) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(base_url=server[0], timeout=30) as c:
        yield c


@pytest.fixture
def app(server):
    return server[1]


async def new_user(http: httpx.AsyncClient) -> dict[str, str]:
    r = await http.post("/v1/auth/anonymous")
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture
async def alice(http) -> dict[str, str]:
    return await new_user(http)


@pytest.fixture
async def bob(http) -> dict[str, str]:
    return await new_user(http)
