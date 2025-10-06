# syntax=docker/dockerfile:1
# The API (LLD §2): FastAPI on uvicorn, one process per container, with circuit-core's Python wheel
# built here from the workspace (abi3, CPython >= 3.12). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t circuit-forge/api .
# The same image runs the migrations: python -m tutor_api.db.migrate
ARG PYTHON_IMAGE=python:3.12-slim-trixie

FROM rust:1.98-slim-trixie AS core
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /maturin && /maturin/bin/pip install --no-cache-dir "maturin>=1.15,<2"
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN /maturin/bin/maturin build --release --locked -m crates/circuit-core-py/Cargo.toml -o /wheels

FROM ${PYTHON_IMAGE}
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 REGISTRY_DIR=/opt/registry
COPY --from=core /wheels /tmp/wheels
COPY workers/sim_runner /tmp/sim_runner
COPY apps/api /tmp/api
RUN pip install --no-cache-dir --root-user-action=ignore --disable-pip-version-check \
      /tmp/wheels/*.whl /tmp/sim_runner /tmp/api \
 && rm -rf /tmp/wheels /tmp/sim_runner /tmp/api \
 && useradd --uid 10002 --no-create-home --shell /usr/sbin/nologin api
COPY registry /opt/registry
USER 10002
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"]
CMD ["uvicorn", "--factory", "tutor_api.main:create_app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
