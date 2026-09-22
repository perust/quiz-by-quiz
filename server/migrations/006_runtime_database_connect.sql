BEGIN;

-- Explicitly allow the constrained runtime login to connect to only this
-- migration target. Do not change shared-cluster PUBLIC privileges.
DO $$
BEGIN
    EXECUTE format(
        'GRANT CONNECT ON DATABASE %I TO quiz_by_quiz_app',
        current_database()
    );
END $$;

INSERT INTO quiz_online.schema_migrations (version)
VALUES (6)
ON CONFLICT (version) DO NOTHING;

COMMIT;
