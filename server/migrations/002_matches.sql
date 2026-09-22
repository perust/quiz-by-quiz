BEGIN;

ALTER TABLE quiz_online.room_members
    ADD COLUMN IF NOT EXISTS is_ready boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS quiz_online.matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id uuid NOT NULL REFERENCES quiz_online.rooms(id) ON DELETE CASCADE,
    category_id varchar(16),
    game_mode boolean NOT NULL DEFAULT false,
    state varchar(16) NOT NULL DEFAULT 'running',
    current_position smallint NOT NULL DEFAULT 1,
    total_questions smallint NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    question_started_at timestamptz NOT NULL DEFAULT now(),
    deadline_at timestamptz NOT NULL,
    finished_at timestamptz,
    expires_at timestamptz NOT NULL,
    CHECK (category_id IS NULL OR category_id IN ('history', 'science', 'geography', 'general', 'art')),
    CHECK (state IN ('running', 'finished', 'abandoned')),
    CHECK (total_questions BETWEEN 1 AND 25),
    CHECK (current_position BETWEEN 1 AND total_questions),
    CHECK (deadline_at >= question_started_at),
    CHECK (
        (state = 'running' AND finished_at IS NULL)
        OR (state IN ('finished', 'abandoned') AND finished_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_running_match_per_room_idx
    ON quiz_online.matches (room_id)
    WHERE state = 'running';
CREATE INDEX IF NOT EXISTS matches_expires_at_idx
    ON quiz_online.matches (expires_at);
CREATE INDEX IF NOT EXISTS matches_room_started_at_idx
    ON quiz_online.matches (room_id, started_at DESC);

CREATE TABLE IF NOT EXISTS quiz_online.match_players (
    match_id uuid NOT NULL REFERENCES quiz_online.matches(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES quiz_online.players(id) ON DELETE RESTRICT,
    nickname varchar(20) NOT NULL,
    character_id varchar(32),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, player_id)
);

CREATE TABLE IF NOT EXISTS quiz_online.match_questions (
    match_id uuid NOT NULL REFERENCES quiz_online.matches(id) ON DELETE CASCADE,
    position smallint NOT NULL,
    question_id varchar(64) NOT NULL,
    category_id varchar(16) NOT NULL,
    choices jsonb NOT NULL,
    answer_index smallint NOT NULL CHECK (answer_index BETWEEN 0 AND 3),
    PRIMARY KEY (match_id, position),
    UNIQUE (match_id, question_id),
    CHECK (position BETWEEN 1 AND 25),
    CHECK (category_id IN ('history', 'science', 'geography', 'general', 'art')),
    CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) = 4)
);

CREATE TABLE IF NOT EXISTS quiz_online.match_answers (
    match_id uuid NOT NULL,
    position smallint NOT NULL,
    player_id uuid NOT NULL,
    choice_index smallint,
    correct boolean NOT NULL,
    timed_out boolean NOT NULL,
    elapsed_ms integer NOT NULL CHECK (elapsed_ms BETWEEN 0 AND 20000),
    submitted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, position, player_id),
    FOREIGN KEY (match_id, position)
        REFERENCES quiz_online.match_questions(match_id, position)
        ON DELETE CASCADE,
    FOREIGN KEY (match_id, player_id)
        REFERENCES quiz_online.match_players(match_id, player_id)
        ON DELETE CASCADE,
    CHECK (
        (timed_out AND choice_index IS NULL AND NOT correct)
        OR (NOT timed_out AND choice_index BETWEEN 0 AND 3)
    )
);

CREATE INDEX IF NOT EXISTS match_answers_score_idx
    ON quiz_online.match_answers (match_id, player_id, correct);

CREATE OR REPLACE FUNCTION quiz_online.cleanup_expired_matches()
RETURNS integer
LANGUAGE sql
AS $$
    WITH deleted AS (
        DELETE FROM quiz_online.matches WHERE expires_at <= now()
        RETURNING id
    )
    SELECT count(*)::integer FROM deleted;
$$;

GRANT USAGE ON SCHEMA quiz_online TO quiz_by_quiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE quiz_online.matches TO quiz_by_quiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE quiz_online.match_players TO quiz_by_quiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE quiz_online.match_questions TO quiz_by_quiz_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE quiz_online.match_answers TO quiz_by_quiz_app;
GRANT EXECUTE ON FUNCTION quiz_online.cleanup_expired_matches() TO quiz_by_quiz_app;

INSERT INTO quiz_online.schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;

COMMIT;
