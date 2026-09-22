BEGIN;

-- A running question and its short reveal window are both active match phases.
ALTER TABLE quiz_online.matches
    DROP CONSTRAINT IF EXISTS matches_state_check;
ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_state_check
    CHECK (state IN ('running', 'revealing', 'finished', 'abandoned'));

ALTER TABLE quiz_online.matches
    DROP CONSTRAINT IF EXISTS matches_check;
ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_check
    CHECK (
        (state IN ('running', 'revealing') AND finished_at IS NULL)
        OR (state IN ('finished', 'abandoned') AND finished_at IS NOT NULL)
    );

DROP INDEX IF EXISTS quiz_online.one_running_match_per_room_idx;
CREATE UNIQUE INDEX IF NOT EXISTS one_active_match_per_room_idx
    ON quiz_online.matches (room_id)
    WHERE state IN ('running', 'revealing');

INSERT INTO quiz_online.schema_migrations (version)
VALUES (3)
ON CONFLICT (version) DO NOTHING;

COMMIT;
