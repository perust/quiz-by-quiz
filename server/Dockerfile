FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    UV_LINK_MODE=copy

RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app \
    && pip install --no-cache-dir uv==0.8.15

WORKDIR /app
COPY --chmod=644 server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev

FROM base AS test
RUN uv sync --frozen --group dev
COPY --chown=app:app server/app ./app
COPY --chown=app:app server/tests ./tests
COPY --chown=app:app server/migrations ./migrations
COPY --chown=app:app server/Dockerfile /server/Dockerfile
COPY --chown=app:app deploy /deploy
COPY --chown=app:app .dockerignore /.dockerignore
COPY --chown=app:app README.md /README.md
COPY --chown=app:app .github/workflows/pages.yml /.github/workflows/pages.yml
ENV PYTEST_ADDOPTS="-o cache_dir=/tmp/pytest-cache" \
    RUFF_CACHE_DIR=/tmp/ruff-cache
USER app
RUN uv run ruff check app tests && uv run python -m pytest -q

FROM base AS runtime
COPY --chown=app:app server/app ./app
COPY --chown=app:app server/migrations ./migrations
ENV QUESTION_BANK_DIR=/run/quiz-by-quiz/online-bank
USER app
EXPOSE 8000
CMD ["/app/.venv/bin/uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--log-level", "warning", "--ws-max-size", "65536", "--proxy-headers", "--forwarded-allow-ips=*"]
