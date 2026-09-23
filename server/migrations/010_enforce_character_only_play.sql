-- Character-only play is the sole product rule.
--
-- Keep the legacy game_mode columns for wire compatibility, but make false
-- unrepresentable. Existing sessions created before this release receive the
-- same default character used by the static client before NOT NULL/CHECK land.

BEGIN;

UPDATE quiz_online.rooms
SET game_mode = TRUE
WHERE game_mode IS DISTINCT FROM TRUE;

UPDATE quiz_online.matches
SET game_mode = TRUE
WHERE game_mode IS DISTINCT FROM TRUE;

UPDATE quiz_online.players
SET character_id = 'slime-blue'
WHERE character_id IS NULL
   OR character_id !~ '^[a-z0-9][a-z0-9-]{0,31}$';

UPDATE quiz_online.room_members
SET character_id = 'slime-blue'
WHERE character_id IS NULL
   OR character_id !~ '^[a-z0-9][a-z0-9-]{0,31}$';

UPDATE quiz_online.match_players
SET character_id = 'slime-blue'
WHERE character_id IS NULL
   OR character_id !~ '^[a-z0-9][a-z0-9-]{0,31}$';

ALTER TABLE quiz_online.rooms
  ALTER COLUMN game_mode SET DEFAULT TRUE,
  ADD CONSTRAINT rooms_character_only_check CHECK (game_mode IS TRUE);

ALTER TABLE quiz_online.matches
  ALTER COLUMN game_mode SET DEFAULT TRUE,
  ADD CONSTRAINT matches_character_only_check CHECK (game_mode IS TRUE);

ALTER TABLE quiz_online.players
  ALTER COLUMN character_id SET NOT NULL,
  ADD CONSTRAINT players_character_id_valid
    CHECK (character_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');

ALTER TABLE quiz_online.room_members
  ALTER COLUMN character_id SET NOT NULL,
  ADD CONSTRAINT room_members_character_id_valid
    CHECK (character_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');

ALTER TABLE quiz_online.match_players
  ALTER COLUMN character_id SET NOT NULL,
  ADD CONSTRAINT match_players_character_id_valid
    CHECK (character_id ~ '^[a-z0-9][a-z0-9-]{0,31}$');

CREATE OR REPLACE FUNCTION quiz_online.character_only_schema_version()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, quiz_online
AS $$
  SELECT COALESCE(max(version), 0)::integer
  FROM quiz_online.schema_migrations
$$;

REVOKE ALL ON FUNCTION quiz_online.character_only_schema_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_online.character_only_schema_version() TO quiz_by_quiz_app;

INSERT INTO quiz_online.schema_migrations (version)
VALUES (10)
ON CONFLICT (version) DO NOTHING;

COMMIT;
