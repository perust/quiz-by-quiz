from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings
from app.main import create_app


def test_question_bank_directory_must_be_explicitly_configured(monkeypatch) -> None:
    monkeypatch.delenv("QUESTION_BANK_DIR", raising=False)

    settings = Settings.from_env()

    assert settings.question_bank_dir is None


def test_question_bank_directory_can_be_explicitly_configured(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("QUESTION_BANK_DIR", str(tmp_path))

    assert Settings.from_env().question_bank_dir == tmp_path


def test_production_factory_rejects_a_missing_question_bank(monkeypatch) -> None:
    monkeypatch.setenv("DATABASE_URL", "postgresql://not-used-for-startup-validation")
    monkeypatch.delenv("QUESTION_BANK_DIR", raising=False)

    with pytest.raises(RuntimeError, match="private online question bank"):
        create_app()


def test_api_refuses_the_public_pages_question_bank() -> None:
    public_bank = Path(__file__).parents[2] / "data"
    settings = Settings(
        database_url="postgresql://not-used-for-startup-validation",
        question_bank_dir=public_bank,
        cors_origins=("https://perust.github.io",),
        trusted_hosts=("testserver",),
    )

    with pytest.raises(RuntimeError, match="private online question bank"):
        create_app(settings=settings)
