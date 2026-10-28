-- 혼자 푸는 온라인 판 (FR-7.13 3단계, PRD 10.1 #8–#11 소유자 결정).
--
-- 홈의 분야 칸이 대기실 없이 곧바로 여는 혼자 방은 solo_rooms에 표시가 남는다. 그 방은 로비 목록에
-- 남에게 보이지 않고 남이 들어오지 못한다(API가 막는다). 표시는 방과 함께 사라지고(ON DELETE CASCADE),
-- 한 사람에게 하나뿐이다(같은 사람의 다음 판은 그 방을 다시 쓴다). 그 사람의 «분야마다 최고 점수»와
-- 기록 내보내기를 읽는 색인도 함께 둔다.
--
-- 혼자 판은 «제한 없음»도 고른다(PRD 10.1 #9, 소유자 결정 — 친구와 푸는 방은 그대로 20초·40초다).
-- 제한 없음은 문항 시간 NULL(마감 없음)이다. 011의 rooms_question_time_check·matches_question_time_check와
-- NOT NULL, 008의 matches_active_deadline_check(도는 문항에는 늘 마감), 011의
-- match_answers_elapsed_ms_range_check(0..40000), 012의 online_rankings_question_time_check를 여기서
-- 같은 이름으로 바꾼다 — 011·012의 글은 나간 그대로 잠겨 있다(server/tests/test_released_migrations_contract.py).
-- NULL이 **혼자 방과 그 방의 판에만** 있다는 것은 CHECK가 다른 표를 볼 수 없어 저장 생성 열과 외래 키가
-- 지킨다: 문항 시간이 NULL인 방·판은 그 방의 id를 생성 열에 싣고 그 열이 solo_rooms를 가리킨다(NULL이면
-- 외래 키를 보지 않는다). 그래서 혼자 방을 모두 지우면 NULL인 방·판도 하나도 남지 않는다 — 012 API로
-- 되돌릴 때의 정리(deploy/oracle/README.md «Solo online play»의 Rollback)가 그것에 기댄다.
--
-- 제한 없는 문항의 쓴 시간은 자르지 않고 잰다(로컬 «제한 없음»과 같다, FR-5.3). 판은 시작 뒤 2시간
-- (postgres.py의 _MATCH_LIFETIME, expires_at은 시작할 때 정해지고 늘지 않는다)이면 지워지므로 한 문항이
-- 그보다 오래 열려 있을 수 없다 — 그래서 elapsed_ms의 상한은 7,200,000(2시간)이다. 40초를 넘는 쓴 시간은
-- 제한 없는 판의 답에만 있을 수 있다(생성 열 + 외래 키). 20초·40초 판의 답은 011처럼 0..40000이다.
--
-- 012의 API(#108)는 이 열·제약을 모른 채 그대로 돈다 — 그 API가 쓰는 값(20000·40000, 0..40000)은 모두
-- 들어맞고, 늘어난 생성 열은 `SELECT match.*`에 섞일 뿐 이름으로만 읽는다. NULL은 이 표를 쓰는 API(혼자
-- 판)만 쓴다. 이 표를 쓰는 API는 013 없이는 로비·방·참가를 읽지 못한다(방 SQL이 solo_rooms를 본다). 그래서
-- 순서는 migration 013 → API → Pages다 (deploy/oracle/README.md «Fail-closed staging order»).
--
-- 이 transaction은 맨 앞에서 네 표(rooms·matches·match_answers·online_rankings)를 ACCESS EXCLUSIVE로 한
-- 번에 잡고 COMMIT까지 쥔다 — 잠금을 문장마다 키워 가면 012 API의 transaction과 서로 기다릴 수 있다.
-- 그동안 012 API의 그 네 표 읽기·쓰기는 기다린다(생성 열로 세 표를 다시 쓰고 색인을 짓는 동안). 판이
-- 돌지 않는 때에 올린다 (같은 README 단계 3, `release_check db --expect 12 --require-idle`).

BEGIN;

LOCK TABLE
    quiz_online.rooms,
    quiz_online.matches,
    quiz_online.match_answers,
    quiz_online.online_rankings
IN ACCESS EXCLUSIVE MODE;

-- 한 사람의 판마다 최고 점수(홈의 별 점수·결과의 최고 기록 비교)와 기록 내보내기 (FR-7.13 3단계).
-- 주인 열쇠까지 견주는 것은 읽는 쪽이다 — 색인은 player_id로 그 사람의 줄만 고른다.
CREATE INDEX online_rankings_player_board_order_idx
    ON quiz_online.online_rankings (player_id, board, score DESC, recorded_at ASC, id ASC);

-- 혼자 푸는 온라인 판의 방 (FR-7.13 3단계). 방 하나에 표시 하나, 사람 하나에 방 하나다. 방이 지워지면
-- 표시도 함께 지워진다(이 표의 줄을 지우는 권한은 런타임 역할에 없다). player_id는 그 방을 만든
-- 사람이다 — 혼자 방에는 그 사람 말고 아무도 들어오지 못하므로 방장이 바뀌지 않는다.
CREATE TABLE quiz_online.solo_rooms (
    room_id uuid PRIMARY KEY REFERENCES quiz_online.rooms(id) ON DELETE CASCADE,
    player_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT solo_rooms_one_per_player UNIQUE (player_id)
);

-- 런타임 역할: 혼자 방의 표시를 남기고 읽기만 한다. 지우는 것은 방을 지울 때의 CASCADE뿐이다.
GRANT SELECT, INSERT ON TABLE quiz_online.solo_rooms TO quiz_by_quiz_app;

-- 방: 제한 없음(NULL)은 혼자 방에만. 혼자 방은 방을 넣은 뒤에 표시를 넣으므로(표시가 방을 가리킨다)
-- 이 외래 키는 COMMIT에서 본다.
ALTER TABLE quiz_online.rooms
    ALTER COLUMN question_time_ms DROP NOT NULL;
ALTER TABLE quiz_online.rooms
    DROP CONSTRAINT rooms_question_time_check;
ALTER TABLE quiz_online.rooms
    ADD CONSTRAINT rooms_question_time_check
        CHECK (question_time_ms IS NULL OR question_time_ms IN (20000, 40000));
ALTER TABLE quiz_online.rooms
    ADD COLUMN untimed_solo_room_id uuid
        GENERATED ALWAYS AS (CASE WHEN question_time_ms IS NULL THEN id END) STORED;
ALTER TABLE quiz_online.rooms
    ADD CONSTRAINT rooms_untimed_solo_room_fkey
        FOREIGN KEY (untimed_solo_room_id) REFERENCES quiz_online.solo_rooms (room_id)
        DEFERRABLE INITIALLY DEFERRED;

-- 판: 제한 없음은 혼자 방의 판에만. 혼자 방이 지워질 때 판도 같은 문장에서 지워지므로 이 외래 키도
-- COMMIT에서 본다. 마감이 없는 것은 제한 없는 판의 도는 문항뿐이다 — 공개(8초)에는 늘 마감이 있다.
ALTER TABLE quiz_online.matches
    ALTER COLUMN question_time_ms DROP NOT NULL;
ALTER TABLE quiz_online.matches
    DROP CONSTRAINT matches_question_time_check;
ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_question_time_check
        CHECK (question_time_ms IS NULL OR question_time_ms IN (20000, 40000));
ALTER TABLE quiz_online.matches
    ADD COLUMN untimed_solo_room_id uuid
        GENERATED ALWAYS AS (CASE WHEN question_time_ms IS NULL THEN room_id END) STORED;
ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_untimed_solo_room_fkey
        FOREIGN KEY (untimed_solo_room_id) REFERENCES quiz_online.solo_rooms (room_id)
        DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE quiz_online.matches
    ADD COLUMN untimed_match_id uuid
        GENERATED ALWAYS AS (CASE WHEN question_time_ms IS NULL THEN id END) STORED;
ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_untimed_match_key UNIQUE (untimed_match_id);
ALTER TABLE quiz_online.matches
    DROP CONSTRAINT matches_active_deadline_check;
ALTER TABLE quiz_online.matches
    ADD CONSTRAINT matches_active_deadline_check
        CHECK (
            (state = 'running' AND (deadline_at IS NULL) = (question_time_ms IS NULL))
            OR (state = 'revealing' AND deadline_at IS NOT NULL)
            OR (state = 'finished' AND deadline_at IS NULL)
            OR state = 'abandoned'
        );

-- 답: 쓴 시간은 판의 수명(2시간) 안이고, 40초를 넘는 것은 제한 없는 판의 답뿐이다.
ALTER TABLE quiz_online.match_answers
    DROP CONSTRAINT match_answers_elapsed_ms_range_check;
ALTER TABLE quiz_online.match_answers
    ADD CONSTRAINT match_answers_elapsed_ms_range_check
        CHECK (elapsed_ms BETWEEN 0 AND 7200000);
ALTER TABLE quiz_online.match_answers
    ADD COLUMN long_elapsed_match_id uuid
        GENERATED ALWAYS AS (CASE WHEN elapsed_ms > 40000 THEN match_id END) STORED;
ALTER TABLE quiz_online.match_answers
    ADD CONSTRAINT match_answers_long_elapsed_fkey
        FOREIGN KEY (long_elapsed_match_id) REFERENCES quiz_online.matches (untimed_match_id)
        DEFERRABLE INITIALLY DEFERRED;

-- 랭킹: 제한 없이 푼 혼자 판의 기록은 문항 시간 NULL로 남는다(로컬 기록의 timeLimitMs: null과 같다).
-- 기록은 판보다 오래 남아 외래 키를 걸 데가 없다 — 판을 닫는 transaction이 판의 값을 옮겨 적을 뿐이다.
-- 랭킹은 문항 시간으로 나누지 않는다(점수에 속도가 없다). 012 API는 이 열을 읽지 않는다.
ALTER TABLE quiz_online.online_rankings
    ALTER COLUMN question_time_ms DROP NOT NULL;
ALTER TABLE quiz_online.online_rankings
    DROP CONSTRAINT online_rankings_question_time_check;
ALTER TABLE quiz_online.online_rankings
    ADD CONSTRAINT online_rankings_question_time_check
        CHECK (question_time_ms IS NULL OR question_time_ms IN (20000, 40000));

INSERT INTO quiz_online.schema_migrations (version)
VALUES (13)
ON CONFLICT (version) DO NOTHING;

COMMIT;
