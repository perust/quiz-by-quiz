from __future__ import annotations

from pathlib import Path

MIGRATION = Path(__file__).parents[1] / "migrations" / "002_matches.sql"


def test_match_schema_freezes_authoritative_round_and_ttl_invariants() -> None:
    sql = MIGRATION.read_text(encoding="utf-8").lower()

    assert "alter table quiz_online.room_members" in sql
    assert "is_ready boolean not null default false" in sql
    assert "create table if not exists quiz_online.matches" in sql
    assert "state varchar(16) not null" in sql
    assert "state in ('running', 'finished', 'abandoned')" in sql
    assert "current_position smallint not null default 1" in sql
    assert "deadline_at timestamptz not null" in sql
    assert "expires_at timestamptz not null" in sql
    assert "create unique index if not exists one_running_match_per_room_idx" in sql

    assert "create table if not exists quiz_online.match_players" in sql
    assert "primary key (match_id, player_id)" in sql
    assert "create table if not exists quiz_online.match_questions" in sql
    assert "primary key (match_id, position)" in sql
    assert "question_id varchar(64) not null" in sql
    assert "jsonb_array_length(choices) = 4" in sql
    assert "answer_index smallint not null check (answer_index between 0 and 3)" in sql

    assert "create table if not exists quiz_online.match_answers" in sql
    assert "primary key (match_id, position, player_id)" in sql
    assert "foreign key (match_id, position)" in sql
    assert "foreign key (match_id, player_id)" in sql
    assert "timed_out boolean not null" in sql
    assert "choice_index is null" in sql
    assert "delete from quiz_online.matches where expires_at <= now()" in sql
    assert "grant select, insert, update, delete on table quiz_online.matches" in sql
    assert "grant execute on function quiz_online.cleanup_expired_matches" in sql

    # The static question bank belongs in version-controlled JSON, never a table.
    assert "create table if not exists quiz_online.questions" not in sql
