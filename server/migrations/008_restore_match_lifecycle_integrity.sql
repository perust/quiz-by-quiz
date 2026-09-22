BEGIN;

-- Migration 003 removed the historical multi-column position invariant while
-- replacing lifecycle checks. Migration 007 intentionally permits NULL only
-- after the terminal final-reveal transition; active phases still need a
-- deadline for server-side acceptance and expiry. Versions 001–007 may contain
-- terminal rows that retained the old non-NULL deadline or rows at the legacy
-- zero position. Normalize only those historical values before enforcing the
-- restored lifecycle invariant.
UPDATE quiz_online.matches
SET deadline_at = NULL
WHERE state = 'finished' AND deadline_at IS NOT NULL;

UPDATE quiz_online.matches
SET current_position = 1
WHERE current_position = 0;

ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_position_range_check
    CHECK (current_position BETWEEN 1 AND total_questions);

ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_active_deadline_check
    CHECK (
        (state IN ('running', 'revealing') AND deadline_at IS NOT NULL)
        OR (state = 'finished' AND deadline_at IS NULL)
        OR state = 'abandoned'
    );

INSERT INTO quiz_online.schema_migrations (version)
VALUES (8)
ON CONFLICT (version) DO NOTHING;

COMMIT;
