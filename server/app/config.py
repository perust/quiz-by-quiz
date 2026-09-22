from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PUBLIC_PAGES_DATA_DIR = Path(__file__).resolve().parents[2] / "data"


@dataclass(frozen=True)
class Settings:
    database_url: str
    question_bank_dir: Path | None
    cors_origins: tuple[str, ...]
    trusted_hosts: tuple[str, ...]

    @classmethod
    def from_env(cls) -> Settings:
        configured_question_bank = os.getenv("QUESTION_BANK_DIR")
        origins = tuple(
            item.strip()
            for item in os.getenv("CORS_ALLOW_ORIGINS", "https://perust.github.io").split(",")
            if item.strip()
        )
        hosts = tuple(
            item.strip()
            for item in os.getenv(
                "TRUSTED_HOSTS",
                "quiz-by-quiz-api.150.230.222.142.sslip.io,localhost,127.0.0.1,testserver",
            ).split(",")
            if item.strip()
        )
        return cls(
            database_url=os.getenv("DATABASE_URL", ""),
            question_bank_dir=Path(configured_question_bank) if configured_question_bank else None,
            cors_origins=origins,
            trusted_hosts=hosts,
        )


def is_public_pages_question_bank(path: Path) -> bool:
    """The Pages artifact exposes this directory, so it cannot back a fair online match."""
    return path.resolve() == PUBLIC_PAGES_DATA_DIR.resolve()
