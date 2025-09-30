"""Fixtures: a Redis 7 container (testcontainers) and template benches compiled by circuit-core.

Without Docker or a built ngspice the tests that need them skip locally; CI sets REQUIRE_DOCKER=1
and REQUIRE_NGSPICE=1 so that the gate cannot pass silently.
"""

from __future__ import annotations

import os

import circuit_core as cc
import pytest

from sim_runner import ngspice_batch as nb
from sim_runner.worker import registry_version


def docker_available() -> bool:
    try:
        import docker

        docker.from_env().ping()
        return True
    except Exception:  # noqa: BLE001
        return False


def pytest_collection_modifyitems(config, items):
    needs = [
        ("ngspice", lambda: nb.ngspice_path() is not None, "REQUIRE_NGSPICE",
         "ngspice not built: run third_party/ngspice/build-native.sh"),
        ("redis_url", docker_available, "REQUIRE_DOCKER", "Docker is not running (testcontainers Redis)"),
    ]
    for fixture, available, env, msg in needs:
        users = [i for i in items if fixture in i.fixturenames]
        if not users or available():
            continue
        if os.environ.get(env):
            raise pytest.UsageError(msg)
        for item in users:
            item.add_marker(pytest.mark.skip(reason=msg))


@pytest.fixture(scope="session")
def ngspice():
    return nb.ngspice_path()


@pytest.fixture(scope="session")
def redis_url(ngspice):
    from testcontainers.core.container import DockerContainer
    from testcontainers.core.wait_strategies import LogMessageWaitStrategy

    ready = LogMessageWaitStrategy("Ready to accept connections").with_startup_timeout(60)
    with DockerContainer("redis:7-alpine").with_exposed_ports(6379).waiting_for(ready) as c:
        yield f"redis://{c.get_container_host_ip()}:{c.get_exposed_port(6379)}/0"


@pytest.fixture(scope="session")
def reg() -> cc.Registry:
    return cc.load_registry_dir(nb.REGISTRY_DIR)


@pytest.fixture(scope="session")
def version() -> str:
    return registry_version(nb.REGISTRY_DIR)
