BEGIN;

-- A completed match has no active question deadline. The repository clears
-- deadline_at only when the final reveal window expires.
ALTER TABLE quiz_online.matches
    ALTER COLUMN deadline_at DROP NOT NULL;

INSERT INTO quiz_online.schema_migrations (version)
VALUES (7)
ON CONFLICT (version) DO NOTHING;

COMMIT;
