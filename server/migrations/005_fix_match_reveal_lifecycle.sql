BEGIN;

-- PostgreSQL auto-generated names for anonymous CHECK constraints are not stable
-- across the preceding constraint list. Remove only lifecycle checks that mention
-- both state and finished_at, preserving independent invariant checks.
DO $$
DECLARE
    lifecycle_constraint text;
BEGIN
    FOR lifecycle_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'quiz_online.matches'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%state%'
          AND pg_get_constraintdef(oid) ILIKE '%finished_at%'
    LOOP
        EXECUTE format(
            'ALTER TABLE quiz_online.matches DROP CONSTRAINT %I',
            lifecycle_constraint
        );
    END LOOP;
END $$;

ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_lifecycle_check
    CHECK (
        (state IN ('running', 'revealing') AND finished_at IS NULL)
        OR (state IN ('finished', 'abandoned') AND finished_at IS NOT NULL)
    );

INSERT INTO quiz_online.schema_migrations (version)
VALUES (5)
ON CONFLICT (version) DO NOTHING;

COMMIT;
