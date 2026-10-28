-- 서버 랭킹 (FR-7.13 2단계, PRD 12.1 소유자 결정).
--
-- 온라인 판이 닫힐 때(마지막 공개가 끝날 때) 같은 transaction에서 판의 참가자마다 한 줄을 남긴다.
-- 점수는 서버가 채점한 것이다 — 브라우저가 보고하는 점수는 받지 않는다. 기록 시각은 판을 닫은
-- 시각(matches.finished_at)이고, 닉네임은 그 방에서 보인 이름(match_players.nickname)이다.
-- player_id는 브라우저가 localStorage에 두는 신분(players.id)이라 브라우저마다 같다. 공개 응답에는
-- 싣지 않고 «내 기록»(isMine)을 가리는 데만 쓴다. players·matches는 몇 시간 만에 지워지므로
-- 외래 키를 걸지 않는다 — 걸면 기록이 판과 함께 사라진다.
--
-- 그래서 player_id만으로는 «내 기록»을 가릴 수 없다. player id는 로비의 방 snapshot에 실려 남에게도
-- 보이고, players 줄이 지워진 뒤에는 누구든 그 id를 제 토큰으로 다시 등록할 수 있다. 기록에는 그
-- 브라우저의 비밀(토큰)에서 나온 owner_key(sha256("qbb-ranking-owner:" || players.token_hash), 32바이트)를
-- 함께 남기고, isMine은 id와 owner_key가 모두 같을 때만 선다. 토큰 해시 자체는 남기지 않는다.
-- 기록할 때 players 줄이 없으면(평소에는 판이 도는 동안 지워지지 않는다) NULL이라 누구의 것도 아니다.
--
-- 판(board)은 분야 다섯과 전체 도전 하나다. «이번 주»는 서울 시각 월요일 0시부터 다음 월요일까지라
-- 기록마다 그 주의 월요일(week_start)을 저장 열로 둔다. 두 조회(전체·이번 주 상위 10)는 아래 두
-- 색인을 그대로 탄다 — 점수 내림차순, 같은 점수는 먼저 남긴 기록(기록 시각, 같은 판이면 id)이 위다.
--
-- 런타임 역할은 이 표에 INSERT·SELECT만 한다. 오래된 기록 정리(최근 8주 + 판마다 전체 상위 100,
-- 저장 한도 250,000줄)는 정해진 규칙만 도는 SECURITY DEFINER 함수로만 한다 — 런타임 역할에 DELETE를
-- 주지 않는다.
--
-- 더하기만 하는 변경이다. 011의 API는 이 표를 모른 채 그대로 돌고(이 판이 도는 동안 끝난 판은
-- 기록되지 않는다), 이 표를 쓰는 API는 012 없이는 판을 닫지 못한다. 그래서 순서는
-- migration 012 → API → Pages다 (deploy/oracle/README.md «Fail-closed staging order»).

BEGIN;

CREATE TABLE quiz_online.online_rankings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    match_id uuid NOT NULL,
    player_id uuid NOT NULL,
    mode varchar(8) NOT NULL,
    category_id varchar(16),
    board varchar(16) GENERATED ALWAYS AS (COALESCE(category_id, 'all')) STORED,
    score smallint NOT NULL,
    correct_count smallint NOT NULL,
    total_questions smallint NOT NULL,
    question_time_ms integer NOT NULL,
    nickname varchar(20) NOT NULL,
    character_id varchar(32) NOT NULL,
    owner_key bytea,
    recorded_at timestamptz NOT NULL,
    week_start date GENERATED ALWAYS AS (
        (date_trunc('week', recorded_at AT TIME ZONE 'Asia/Seoul'))::date
    ) STORED,
    CONSTRAINT online_rankings_match_player_key UNIQUE (match_id, player_id),
    CONSTRAINT online_rankings_mode_check CHECK (
        (mode = 'all' AND category_id IS NULL)
        OR (
            mode = 'category'
            AND category_id IN ('history', 'science', 'geography', 'general', 'art')
        )
    ),
    CONSTRAINT online_rankings_counts_check CHECK (
        total_questions BETWEEN 1 AND 25
        AND correct_count BETWEEN 0 AND total_questions
        AND score = correct_count * 10
    ),
    CONSTRAINT online_rankings_question_time_check CHECK (question_time_ms IN (20000, 40000)),
    CONSTRAINT online_rankings_nickname_check CHECK (length(btrim(nickname)) BETWEEN 1 AND 20),
    CONSTRAINT online_rankings_character_id_valid CHECK (
        character_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'
    ),
    CONSTRAINT online_rankings_owner_key_length CHECK (
        owner_key IS NULL OR octet_length(owner_key) = 32
    )
);

-- 전체 기간 상위 10과, 정리가 지키는 판마다 상위 100
CREATE INDEX online_rankings_board_order_idx
    ON quiz_online.online_rankings (board, score DESC, recorded_at ASC, id ASC);
-- 이번 주 상위 10
CREATE INDEX online_rankings_board_week_order_idx
    ON quiz_online.online_rankings (board, week_start, score DESC, recorded_at ASC, id ASC);
-- 오래된 기록 정리
CREATE INDEX online_rankings_recorded_at_idx
    ON quiz_online.online_rankings (recorded_at);

-- 정리 규칙. 최근 8주(56일)는 모두 남기고, 그보다 오래된 기록은 판마다 전체 기간 상위 100에 들 때만
-- 남긴다(전체 랭킹 상위 10이 정리로 바뀌지 않는다). 기록이 250,000줄을 넘으면 8주 안이라도 가장
-- 오래된 것부터 줄인다 — 평소에는 닿지 않는 저장 한도다(deploy/oracle/README.md «Online rankings»).
-- 한 번에 10,000줄까지만 지우고 60초 정리가 다음 차례에 이어 간다. 규칙은 이 안에 박혀 있어
-- 런타임 역할이 기간·개수·한도를 바꿀 수 없다.
CREATE FUNCTION quiz_online.prune_online_rankings()
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, quiz_online
AS $$
    WITH boards(board) AS (
        VALUES ('all'), ('history'), ('science'), ('geography'), ('general'), ('art')
    ),
    kept AS (
        SELECT top_row.id
        FROM boards
        CROSS JOIN LATERAL (
            SELECT ranking.id
            FROM quiz_online.online_rankings ranking
            WHERE ranking.board = boards.board
            ORDER BY ranking.score DESC, ranking.recorded_at ASC, ranking.id ASC
            LIMIT 100
        ) top_row
    ),
    threshold AS (
        SELECT GREATEST(
            now() - interval '56 days',
            COALESCE(
                (
                    SELECT newest.recorded_at
                    FROM quiz_online.online_rankings newest
                    ORDER BY newest.recorded_at DESC, newest.id DESC
                    OFFSET 250000
                    LIMIT 1
                ),
                '-infinity'::timestamptz
            )
        ) AS before
    ),
    doomed AS (
        SELECT ranking.id
        FROM quiz_online.online_rankings ranking, threshold
        WHERE ranking.recorded_at < threshold.before
          AND NOT EXISTS (SELECT 1 FROM kept WHERE kept.id = ranking.id)
        ORDER BY ranking.recorded_at ASC, ranking.id ASC
        LIMIT 10000
    ),
    deleted AS (
        DELETE FROM quiz_online.online_rankings ranking
        USING doomed
        WHERE ranking.id = doomed.id
        RETURNING 1
    )
    SELECT count(*)::integer FROM deleted;
$$;

REVOKE ALL ON FUNCTION quiz_online.prune_online_rankings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_online.prune_online_rankings() TO quiz_by_quiz_app;

-- 런타임 역할: 기록을 남기고 읽기만 한다. 고치거나 지우는 권한은 없다.
GRANT SELECT, INSERT ON TABLE quiz_online.online_rankings TO quiz_by_quiz_app;

INSERT INTO quiz_online.schema_migrations (version)
VALUES (12)
ON CONFLICT (version) DO NOTHING;

COMMIT;
