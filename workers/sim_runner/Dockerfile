# syntax=docker/dockerfile:1
# sim_runner (LLD §8): the pinned ngspice built from source, the registry's model files and the
# arq worker. Build from the repository root:
#   docker build -f workers/sim_runner/Dockerfile -t circuit-forge/sim-runner .
# Run it as compose.yaml does: read-only, a tmpfs at /tmp, no network but Redis. The tmpfs must be
# /tmp: ngspice calls tmpfile(), which ignores TMPDIR.
ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM ${PYTHON_IMAGE} AS ngspice
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential bison flex patch curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY third_party/ngspice/pin.env third_party/ngspice/fetch.sh third_party/ngspice/build-native.sh third_party/ngspice/
COPY third_party/ngspice/patches third_party/ngspice/patches
# The same script and pin as CI's native build and the WASM build (LLD §2: one ngspice version).
RUN bash third_party/ngspice/build-native.sh

FROM ${PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    NGSPICE=/opt/ngspice/bin/ngspice SPICE_LIB_DIR=/opt/ngspice/share/ngspice \
    SIM_REGISTRY_DIR=/opt/registry
COPY --from=ngspice /src/third_party/ngspice/dist/native /opt/ngspice
COPY registry/manifest.yaml /opt/registry/manifest.yaml
COPY registry/models /opt/registry/models
COPY workers/sim_runner /tmp/sim_runner
RUN pip install --no-cache-dir --root-user-action=ignore --disable-pip-version-check /tmp/sim_runner \
 && rm -rf /tmp/sim_runner \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sim
USER 10001
# Health: the worker writes its health-check key to Redis every 10 s.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s CMD ["arq", "--check", "sim_runner.worker.WorkerSettings"]
CMD ["arq", "sim_runner.worker.WorkerSettings"]
