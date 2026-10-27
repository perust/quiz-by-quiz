-- 혼자 푸는 온라인 판 (FR-7.13 3단계, 소유자 결정 대기).
--
-- 홈의 분야 칸이 대기실 없이 곧바로 여는 혼자 방은 solo_rooms에 표시가 남는다. 그 방은 로비 목록에
-- 남에게 보이지 않고 남이 들어오지 못한다(API가 막는다). 표시는 방과 함께 사라지고(ON DELETE CASCADE),
-- 한 사람에게 하나뿐이다(같은 사람의 다음 판은 그 방을 다시 쓴다). 그 사람의 «분야마다 최고 점수»와
-- 기록 내보내기를 읽는 색인도 함께 둔다. 기존 표는 하나도 바꾸지 않는다.
--
-- 한때 아직 올리지 않은 012에 접어 넣었다. 그러면 같은 번호(12)가 두 스키마를 뜻하고 migrator는
-- 번호만 보므로, #108의 012가 먼저 올라간 DB에서는 이 표가 영영 생기지 않는다. 그래서 012는 #108의
-- 글 그대로 두고 혼자 판의 것은 모두 이 013에 둔다.
--
-- 더하기만 하는 변경이다. 012의 API(#108)는 이 표와 색인을 모른 채 그대로 돌고(색인은 기록을 남길 때
-- 함께 갱신될 뿐이다), 이 표를 쓰는 API는 013 없이는 로비·방·참가를 읽지 못한다(방 SQL이 solo_rooms를
-- 본다). 그래서 순서는 migration 013 → API → Pages다 (deploy/oracle/README.md «Fail-closed staging order»).

BEGIN;

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

INSERT INTO quiz_online.schema_migrations (version)
VALUES (13)
ON CONFLICT (version) DO NOTHING;

COMMIT;
