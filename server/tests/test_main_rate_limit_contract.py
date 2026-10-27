from __future__ import annotations

import re
from pathlib import Path

from app import main
from app.domain import ALLOWED_CAPACITIES


def _source() -> str:
    return (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")


def test_every_actor_room_limiter_has_an_atomic_process_claim() -> None:
    source = _source()

    assert 'key=f"{prefix}:actor-room:{actor_id}:{code}"' in source
    assert 'key=f"{prefix}:process"' in source
    for prefix in ("join", "mutation", "chat", "answer", "ticket"):
        assert f"{prefix}_limiter = AtomicMultiWindowLimiter()" in source
        assert f'prefix="{prefix}"' in source

    # 나가기·방장의 내보내기(U24)·방 설정·준비·시작 — 방을 바꾸는 요청은 모두 같은 한도를 나눠 쓴다
    assert source.count('prefix="mutation"') == 5
    assert "SlidingWindowLimiter" not in source


def test_authenticated_ingress_is_bounded_before_database_authentication() -> None:
    source = _source()
    start = source.index("async def require_actor")
    end = source.index('@app.get("/healthz")', start)
    require_actor = source[start:end]

    assert "authenticated_ingress_limiter.try_acquire" in require_actor
    # 한 사람의 몫은 player id와 토큰 해시로 센다 — 남의 id만 아는 위조 요청이 그 몫을 비우지 못한다
    assert 'f"authenticated:player:{identity.player_id}:"' in require_actor
    assert 'f"{identity.token_hash.hex()}"' in require_actor
    assert 'key=f"authenticated:client:{client_key}"' in require_actor
    assert 'key="authenticated:process"' in require_actor
    for constant in (
        "AUTHENTICATED_PLAYER_LIMIT",
        "AUTHENTICATED_CLIENT_LIMIT",
        "AUTHENTICATED_PROCESS_LIMIT",
    ):
        assert f"limit={constant}" in require_actor
    assert require_actor.index("authenticated_ingress_limiter.try_acquire") < require_actor.index(
        "await repo.authenticate"
    )


def test_authenticated_limits_follow_the_owner_decision() -> None:
    # N01 소유자 결정: 사람마다 120/60초, IP 1,500/60초, 프로세스 3,000/60초
    assert main.AUTHENTICATED_PLAYER_LIMIT == 120
    assert main.AUTHENTICATED_CLIENT_LIMIT == 1_500
    assert main.AUTHENTICATED_PROCESS_LIMIT == 3_000
    assert main.AUTHENTICATED_WINDOW_SECONDS == 60
    # 가장 큰 방이 한 NAT 뒤에서 모두 제 몫을 다 써도 IP 몫에 먼저 걸리지 않는다
    assert max(ALLOWED_CAPACITIES) * main.AUTHENTICATED_PLAYER_LIMIT <= (
        main.AUTHENTICATED_CLIENT_LIMIT
    )


def test_every_limiter_rejection_carries_retry_after() -> None:
    source = _source()

    # 요청 한도 거절은 모두 _rate_limited를 거쳐 Retry-After(초)를 단다 (N01)
    assert 'headers={"Retry-After": str(max(1, math.ceil(wait_seconds)))}' in source
    assert "allow_actor_room" not in source
    assert ".allow(" not in source.replace("touch_gate.allow(", "").replace(
        "websocket_inbound_limiter.allow(", ""
    )
    # 그 밖의 429(비밀번호 작업 대기열)도 Retry-After를 단다
    for match in re.finditer(r"_error\(\s*429,", source):
        following = source[match.end() : match.end() + 300]
        assert '"Retry-After"' in following, source[match.start() : match.start() + 200]
