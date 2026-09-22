BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS quiz_online;

CREATE TABLE IF NOT EXISTS quiz_online.schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quiz_online.players (
    id uuid PRIMARY KEY,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    nickname varchar(10) NOT NULL,
    character_id varchar(32),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE TABLE IF NOT EXISTS quiz_online.rooms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code char(6) NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{6}$'),
    name varchar(16) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 16),
    category_id varchar(16),
    capacity smallint NOT NULL CHECK (capacity IN (2, 4, 6, 8, 10, 12)),
    game_mode boolean NOT NULL DEFAULT false,
    is_public boolean NOT NULL,
    password_hash text,
    host_player_id uuid NOT NULL REFERENCES quiz_online.players(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
    CHECK (category_id IS NULL OR category_id IN ('history', 'science', 'geography', 'general', 'art')),
    CHECK (
        (is_public AND password_hash IS NULL)
        OR (NOT is_public AND password_hash IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS quiz_online.room_members (
    room_id uuid NOT NULL REFERENCES quiz_online.rooms(id) ON DELETE CASCADE,
    player_id uuid NOT NULL REFERENCES quiz_online.players(id) ON DELETE CASCADE,
    nickname varchar(20) NOT NULL,
    character_id varchar(32),
    joined_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, player_id),
    UNIQUE (room_id, nickname)
);

CREATE INDEX IF NOT EXISTS rooms_expires_at_idx
    ON quiz_online.rooms (expires_at);
CREATE INDEX IF NOT EXISTS rooms_created_at_idx
    ON quiz_online.rooms (created_at DESC);
CREATE INDEX IF NOT EXISTS room_members_player_idx
    ON quiz_online.room_members (player_id);
CREATE INDEX IF NOT EXISTS room_members_last_seen_idx
    ON quiz_online.room_members (last_seen_at);
CREATE INDEX IF NOT EXISTS players_expires_at_idx
    ON quiz_online.players (expires_at);

INSERT INTO quiz_online.schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;

COMMIT;
