-- 방장이 방마다 고르는 온라인 문항 시간 (20초 기본 · 40초).
--
-- 제한 없음은 두지 않는다 — 한 사람이 답하지 않으면 방 전체가 멈춘다.
-- 방의 값은 판을 열 때 matches에 옮겨 적고, 그 판의 모든 문항 마감·시간 초과 기록이
-- 판의 값을 쓴다. 판이 도는 동안에는 방 설정을 바꿀 수 없어 둘은 어긋나지 않는다.
--
-- 더하기만 하는 변경이다. 이미 있는 방·판은 기본값(예전의 고정 20초)을 받고,
-- 010의 API는 열 이름을 적어 쓰므로 새 열을 모른 채 그대로 돈다. 그래서 순서는
-- migration 011 → API → Pages다. 런타임 역할의 권한은 004의 표 단위 GRANT가
-- 새 열까지 덮으므로 따로 주지 않는다.

BEGIN;

ALTER TABLE quiz_online.rooms
  ADD COLUMN question_time_ms integer NOT NULL DEFAULT 20000;

ALTER TABLE quiz_online.rooms
  ADD CONSTRAINT rooms_question_time_check
    CHECK (question_time_ms IN (20000, 40000));

ALTER TABLE quiz_online.matches
  ADD COLUMN question_time_ms integer NOT NULL DEFAULT 20000;

ALTER TABLE quiz_online.matches
  ADD CONSTRAINT matches_question_time_check
    CHECK (question_time_ms IN (20000, 40000));

-- 시간 초과 답은 그 판의 문항 시간 전체를 쓴 것으로 남는다. 002의 0..20000 범위로는
-- 40초 판의 시간 초과를 적을 수 없다. 이름 없는 열 CHECK라 정의로 찾아 지운다.
DO $$
DECLARE
    elapsed_constraint text;
BEGIN
    FOR elapsed_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'quiz_online.match_answers'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%elapsed_ms%'
    LOOP
        EXECUTE format(
            'ALTER TABLE quiz_online.match_answers DROP CONSTRAINT %I',
            elapsed_constraint
        );
    END LOOP;
END $$;

ALTER TABLE quiz_online.match_answers
  ADD CONSTRAINT match_answers_elapsed_ms_range_check
    CHECK (elapsed_ms BETWEEN 0 AND 40000);

INSERT INTO quiz_online.schema_migrations (version)
VALUES (11)
ON CONFLICT (version) DO NOTHING;

COMMIT;
