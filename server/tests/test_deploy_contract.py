from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_api_image_runs_as_non_root_without_copying_secrets() -> None:
    dockerfile = (ROOT / "server" / "Dockerfile").read_text(encoding="utf-8")
    assert "USER app" in dockerfile
    assert "COPY .env" not in dockerfile
    assert "COPY --chmod=644 server/pyproject.toml server/uv.lock ./" in dockerfile
    assert "COPY --chown=app:app server/tests ./tests" in dockerfile
    assert "COPY --chown=app:app server/Dockerfile /server/Dockerfile" in dockerfile
    assert "COPY --chown=app:app deploy /deploy" in dockerfile
    assert "COPY --chown=app:app .dockerignore /.dockerignore" in dockerfile
    assert "COPY --chown=app:app README.md /README.md" in dockerfile
    workflow_copy = (
        "COPY --chown=app:app .github/workflows/pages.yml "
        "/.github/workflows/pages.yml"
    )
    assert workflow_copy in dockerfile
    assert "COPY --chown=app:app data ./question-bank" not in dockerfile
    assert "/app/question-bank" not in dockerfile
    assert "QUESTION_BANK_DIR=/run/quiz-by-quiz/online-bank" in dockerfile
    assert "RUN uv run ruff check app tests && uv run python -m pytest -q" in dockerfile
    assert "RUFF_CACHE_DIR=/tmp/ruff-cache" in dockerfile
    assert 'CMD ["/app/.venv/bin/python", "-m", "pytest", "-q"]' not in dockerfile
    assert "--workers" in dockerfile and '"1"' in dockerfile
    assert "--ws-max-size" in dockerfile


def test_compose_fragment_is_internal_read_only_and_bounded() -> None:
    compose = (ROOT / "deploy" / "oracle" / "compose.quiz-by-quiz.yaml").read_text(encoding="utf-8")
    assert "ports:" not in compose
    assert "expose:" in compose
    assert "read_only: true" in compose
    assert "no-new-privileges:true" in compose
    assert "cap_drop:" in compose and "- ALL" in compose
    assert "mem_limit:" in compose
    assert "cpus:" in compose
    assert "${QUIZ_DB_PASSWORD:?" in compose
    assert "DATABASE_URL:" in compose
    assert "quiz_by_quiz" in compose
    assert "${QUIZ_BY_QUIZ_SOURCE_DIR:?" in compose
    assert "dockerfile: server/Dockerfile" in compose
    assert "- internal" in compose
    assert "${QUIZ_ONLINE_BANK_DIR:?" in compose
    assert "target: /run/quiz-by-quiz/online-bank" in compose
    assert "quiz-by-quiz-migrate:" in compose
    assert "MIGRATOR_DATABASE_URL:" in compose
    assert "${QUIZ_MIGRATOR_DATABASE_URL:?" in compose
    migrate_service = compose.split("  quiz-by-quiz-api:", 1)[0]
    assert "QUIZ_DB_PASSWORD: \"${QUIZ_DB_PASSWORD:?" in migrate_service
    assert "service_completed_successfully" in compose


def test_api_resource_envelope_and_single_worker_contract_are_explicit() -> None:
    compose = (ROOT / "deploy" / "oracle" / "compose.quiz-by-quiz.yaml").read_text(
        encoding="utf-8"
    )
    dockerfile = (ROOT / "server" / "Dockerfile").read_text(encoding="utf-8")
    guide = (ROOT / "deploy" / "oracle" / "README.md").read_text(encoding="utf-8")
    normalized_guide = " ".join(guide.split())
    api_service = compose.split("  quiz-by-quiz-api:", 1)[1]

    assert "mem_limit: 384m" in api_service
    assert "cpus: 0.50" in api_service
    assert "pids_limit: 128" in api_service
    assert '"--workers", "1"' in dockerfile
    assert "two concurrent Argon2 jobs" in normalized_guide
    assert "2 × 64 MiB = 128 MiB" in normalized_guide
    assert "six admitted Argon2 jobs" in normalized_guide
    assert "60-second resource cleanup" in normalized_guide
    assert "100 complete rooms" in normalized_guide
    assert "two-hour player lifetime" in normalized_guide
    assert "36,000" in normalized_guide
    assert "2,400" in normalized_guide
    assert "resource-envelope review boundary" in normalized_guide
    assert "process-global limits require exactly one Uvicorn worker" in normalized_guide


def test_root_dockerignore_excludes_credentials_and_local_dependencies() -> None:
    ignored = (ROOT / ".dockerignore").read_text(encoding="utf-8")
    assert ".env" in ignored
    assert ".git" in ignored
    assert ".github" in ignored
    assert "!.github/workflows/pages.yml" in ignored
    assert "data" in ignored
    assert "node_modules" in ignored
    assert "server/.venv" in ignored
    assert "teacher/" in ignored
    assert "backups/" in ignored


def test_caddy_fragment_uses_a_dedicated_tls_host() -> None:
    caddy = (ROOT / "deploy" / "oracle" / "Caddyfile.quiz-by-quiz").read_text(encoding="utf-8")
    assert caddy.startswith("quiz-by-quiz-api.150.230.222.142.sslip.io {")
    assert "reverse_proxy quiz-by-quiz-api:8000" in caddy
    # Caddy safely derives X-Forwarded-For from the untrusted peer by default.
    # A header_up deletion runs after that derivation and would collapse IP limits.
    assert "header_up -X-Forwarded-For" not in caddy
    # WSS credentials use a one-time subprotocol header; event access-log
    # suppression remains defense in depth while preserving the REST trail.
    assert "@ticket_bearing_events path /v1/rooms/*/events" in caddy
    assert "log_skip @ticket_bearing_events" in caddy
    assert "Access-Control-Allow-Origin" not in caddy


def test_caddy_keeps_database_readiness_private_while_active_health_still_works() -> None:
    caddy = (ROOT / "deploy" / "oracle" / "Caddyfile.quiz-by-quiz").read_text(encoding="utf-8")

    assert "@private_health path /healthz /readyz" in caddy
    assert "respond @private_health 404" in caddy
    assert caddy.index("respond @private_health 404") < caddy.index(
        "reverse_proxy quiz-by-quiz-api:8000"
    )
    assert "health_uri /readyz" in caddy


def test_oracle_health_probes_send_the_only_trusted_public_host() -> None:
    host = "quiz-by-quiz-api.150.230.222.142.sslip.io"
    compose = (ROOT / "deploy" / "oracle" / "compose.quiz-by-quiz.yaml").read_text(encoding="utf-8")
    caddy = (ROOT / "deploy" / "oracle" / "Caddyfile.quiz-by-quiz").read_text(encoding="utf-8")

    assert f"TRUSTED_HOSTS: {host}" in compose
    assert f'headers={{"Host": "{host}"}}' in compose
    expected_health_headers = "health_headers {\n\t\t\tHost " + host + "\n\t\t}"
    assert expected_health_headers in caddy


def test_pages_workflow_verifies_client_server_and_container_before_deploy() -> None:
    workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")

    assert "pull_request:" in workflow
    assert "node --test tests/*.test.mjs" in workflow
    assert "astral-sh/setup-uv@v5" in workflow
    assert "uv run --locked ruff check app tests" in workflow
    assert "uv run --locked python -m pytest -q" in workflow
    assert "docker build --target test --file server/Dockerfile ." in workflow
    assert "needs: verify" in workflow


def test_oracle_overlay_has_an_explicit_platform_base_contract() -> None:
    guide = (ROOT / "deploy" / "oracle" / "README.md").read_text(encoding="utf-8")

    assert "not a standalone Compose project" in guide
    assert "postgres" in guide
    assert "caddy" in guide
    assert "internal" in guide
    assert "QUIZ_BY_QUIZ_SOURCE_DIR" in guide
    assert "QUIZ_ONLINE_BANK_DIR" in guide
    assert "QUIZ_MIGRATOR_DATABASE_URL" in guide
    assert "QUIZ_DB_PASSWORD" in guide
    assert "Caddyfile.quiz-by-quiz" in guide


def test_readme_describes_online_authority_and_data_handling() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")

    assert "quiz-api-base" in readme
    assert "서버 권위" in readme
    assert "공개 `data/`는 온라인 정답" in readme
    assert "비밀번호 원문" in readme
    assert "quiz.online.identity.v1" in readme
