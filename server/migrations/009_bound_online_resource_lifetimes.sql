BEGIN;

ALTER TABLE quiz_online.players
    ALTER COLUMN expires_at SET DEFAULT (now() + interval '2 hours');

UPDATE quiz_online.players
SET expires_at = LEAST(expires_at, now() + interval '2 hours')
WHERE expires_at > now() + interval '2 hours';

CREATE INDEX IF NOT EXISTS players_expires_at_idx
    ON quiz_online.players (expires_at);
CREATE INDEX IF NOT EXISTS rooms_expires_at_idx
    ON quiz_online.rooms (expires_at);
CREATE INDEX IF NOT EXISTS rooms_lobby_order_idx
    ON quiz_online.rooms (updated_at DESC, created_at DESC, id);
CREATE INDEX IF NOT EXISTS room_members_player_room_idx
    ON quiz_online.room_members (player_id, room_id);

INSERT INTO quiz_online.schema_migrations (version)
VALUES (9)
ON CONFLICT (version) DO NOTHING;

COMMIT;
