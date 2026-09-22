BEGIN;

-- The API login may perform only the data operations used by the repository.
-- It receives neither DDL ownership nor access to the migration history.
GRANT USAGE ON SCHEMA quiz_online TO quiz_by_quiz_app;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE quiz_online.players, quiz_online.rooms, quiz_online.room_members
TO quiz_by_quiz_app;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE quiz_online.matches,
         quiz_online.match_players,
         quiz_online.match_questions,
         quiz_online.match_answers
TO quiz_by_quiz_app;

GRANT EXECUTE ON FUNCTION quiz_online.cleanup_expired_matches() TO quiz_by_quiz_app;

INSERT INTO quiz_online.schema_migrations (version)
VALUES (4)
ON CONFLICT (version) DO NOTHING;

COMMIT;
