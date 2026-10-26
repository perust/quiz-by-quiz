from __future__ import annotations

from pathlib import Path


def test_every_actor_room_limiter_has_an_atomic_process_claim() -> None:
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")

    assert 'key=f"{prefix}:actor-room:{actor_id}:{code}"' in source
    assert 'key=f"{prefix}:process"' in source
    for prefix in ("join", "mutation", "chat", "answer", "ticket"):
        assert f"{prefix}_limiter = AtomicMultiWindowLimiter()" in source
        assert f'prefix="{prefix}"' in source

    # 나가기·방장의 내보내기(U24)·방 설정·준비·시작 — 방을 바꾸는 요청은 모두 같은 한도를 나눠 쓴다
    assert source.count('prefix="mutation"') == 5
    assert "SlidingWindowLimiter" not in source


def test_authenticated_ingress_is_bounded_before_database_authentication() -> None:
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    start = source.index("async def require_actor")
    end = source.index('@app.get("/healthz")', start)
    require_actor = source[start:end]

    assert "authenticated_ingress_limiter.allow" in require_actor
    assert 'key=f"authenticated:client:{client_key}"' in require_actor
    assert 'key="authenticated:process"' in require_actor
    assert require_actor.index("authenticated_ingress_limiter.allow") < require_actor.index(
        "await repo.authenticate"
    )