from __future__ import annotations

from pathlib import Path


def test_main_closes_left_members_and_revalidates_after_cleanup() -> None:
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")

    cleanup_start = source.index("async def sweep_expired_resources")
    cleanup = source[cleanup_start : source.index("sweep_tasks =", cleanup_start)]
    leave_start = source.index("async def leave_room")
    leave = source[leave_start : source.index("@app.patch", leave_start)]
    websocket = source[source.index("@app.websocket") :]

    assert "await repo.cleanup_expired_resources()" in cleanup
    assert "await hub.revalidate(repo.is_member)" in cleanup
    assert "await hub.disconnect_actor(code, actor_id)" in leave
    reserve = "if not hub.reserve(code, actor_id, websocket):"
    membership = "if not await repo.is_member(actor_id, code):"
    accept = "await websocket.accept(subprotocol=WEBSOCKET_PROTOCOL)"
    activate = "if not hub.activate(code, actor_id, websocket):"
    assert reserve in websocket
    assert activate in websocket
    assert websocket.index(reserve) < websocket.index(membership)
    assert websocket.index(membership) < websocket.index(accept)
    assert websocket.index(accept) < websocket.index(activate)
    assert 'key="websocket-inbound"' in websocket
    assert 'key=f"websocket-inbound:burst:{actor_id}:{code}"' in websocket
    assert "limit=30" in websocket
    assert 'key=f"websocket-inbound:sustained:{actor_id}:{code}"' in websocket
    assert "limit=1_200" in websocket
    assert "limit=15_000" in websocket
    assert "await websocket.close(code=4429)" in websocket
    assert "hub.disconnect(code, websocket)" in websocket


def test_lifespan_always_closes_the_repository_after_event_hub_shutdown() -> None:
    source = (Path(__file__).parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    lifespan = source[source.index("@asynccontextmanager") : source.index("app = FastAPI")]

    expected = (
        "try:\n"
        "                await hub.close_all()\n"
        "            finally:\n"
        "                await repo.close()"
    )
    assert expected in lifespan
