from __future__ import annotations

import hashlib
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import create_app
from app.password_work import PasswordWorkBusy
from app.repository import (
    AccessInfo,
    MatchSetup,
    PlayerView,
    RoomFull,
    RoomView,
)

PLAYER_ID = UUID("12345678-1234-5678-9234-567812345678")
PLAYER_TOKEN = "player-token-with-at-least-thirty-two-characters"  # noqa: S105
HEADERS = {
    "Authorization": f"Bearer {PLAYER_TOKEN}",
    "X-Player-Id": str(PLAYER_ID),
}
WS_PROTOCOL = "qbb.v1"


def ws_protocols(ticket: str) -> list[str]:
    return [WS_PROTOCOL, f"qbb.ticket.{ticket}"]


def room_view(**changes: Any) -> RoomView:
    base = RoomView(
        code="ABC234",
        name="온라인 퀴즈",
        category_id="history",
        capacity=12,
        game_mode=True,
        players=(PlayerView(id=PLAYER_ID, nickname="퀴즈왕", character_id="slime-blue"),),
        is_public=False,
        has_password=True,
        is_mine=True,
        joined=True,
        created_at="2026-09-17T00:00:00+00:00",
    )
    return replace(base, **changes)


class FakeRepository:
    def __init__(self) -> None:
        self.room = room_view()
        self.authenticated = True
        self.password_hash: str | None = None
        self.created_password_hash: str | None = None
        self.create_calls = 0
        self.session_token_hash: bytes | None = None
        self.session_player: Any | None = None
        self.join_calls = 0
        self.update_calls = 0
        self.member = False
        self.touch_calls = 0
        self.authenticate_calls = 0

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def health(self) -> bool:
        return True

    async def upsert_player(
        self,
        player_id: UUID,
        token_hash: bytes,
        player: Any,
        update_profile: bool = True,
    ) -> None:
        assert player_id == PLAYER_ID
        assert isinstance(update_profile, bool)
        self.session_token_hash = token_hash
        self.session_player = player

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool:
        self.authenticate_calls += 1
        return self.authenticated and player_id == PLAYER_ID and token_hash == hashlib.sha256(
            PLAYER_TOKEN.encode()
        ).digest()

    async def list_rooms(self, actor_id: UUID) -> list[RoomView]:
        return [self.room]

    async def create_room(self, actor_id: UUID, spec: Any, password_hash: str | None) -> RoomView:
        self.create_calls += 1
        self.created_password_hash = password_hash
        return self.room

    async def get_room(self, actor_id: UUID, code: str) -> RoomView | None:
        return self.room if code == self.room.code else None

    async def get_access(self, code: str) -> AccessInfo | None:
        if code != self.room.code:
            return None
        return AccessInfo(is_public=self.password_hash is None, password_hash=self.password_hash)

    async def join_room(self, actor_id: UUID, code: str) -> RoomView:
        self.join_calls += 1
        return self.room

    async def leave_room(self, actor_id: UUID, code: str) -> RoomView | None:
        return None

    async def update_room(self, actor_id: UUID, code: str, patch: Any) -> RoomView:
        self.update_calls += 1
        return self.room

    async def send_chat(self, actor_id: UUID, code: str, text: str) -> PlayerView:
        return self.room.players[0]

    async def start_game(self, actor_id: UUID, code: str) -> MatchSetup:
        return MatchSetup(category_id=self.room.category_id, game_mode=self.room.game_mode)

    async def is_member(self, actor_id: UUID, code: str) -> bool:
        return self.member and code == self.room.code

    async def touch_member(self, actor_id: UUID, code: str) -> None:
        self.touch_calls += 1
        return None


class RotatingIdentityRepository(FakeRepository):
    def __init__(self) -> None:
        super().__init__()
        self.sessions: set[tuple[UUID, bytes]] = set()

    async def upsert_player(
        self,
        player_id: UUID,
        token_hash: bytes,
        player: Any,
        update_profile: bool = True,
    ) -> None:
        assert isinstance(update_profile, bool)
        self.sessions.add((player_id, token_hash))

    async def authenticate(self, player_id: UUID, token_hash: bytes) -> bool:
        return self.authenticated and (player_id, token_hash) in self.sessions


def rotating_headers(index: int, client_key: str) -> dict[str, str]:
    player_id = UUID(int=index + 1)
    token = f"rotation-token-{index:04d}-with-at-least-thirty-two-characters"
    return {
        "Authorization": f"Bearer {token}",
        "X-Player-Id": str(player_id),
        "X-Forwarded-For": client_key,
    }


def register_rotating_identity(client: TestClient, index: int, client_key: str) -> dict[str, str]:
    headers = rotating_headers(index, client_key)
    response = client.put(
        "/v1/session",
        headers=headers,
        json={"nickname": f"퀴즈왕{index}", "characterId": "slime-blue"},
    )
    assert response.status_code == 200
    return headers


def public_room_body(index: int) -> dict[str, object]:
    return {
        "name": f"공개 방 {index}",
        "categoryId": None,
        "capacity": 12,
        "isPublic": True,
        "password": None,
        "gameMode": True,
    }



def make_client(repository: FakeRepository, *, password_hasher: Any | None = None) -> TestClient:
    return TestClient(create_app(repository=repository, password_hasher=password_hasher))


def register(client: TestClient) -> None:
    response = client.put(
        "/v1/session",
        headers=HEADERS,
        json={"nickname": "퀴즈왕", "characterId": "slime-blue"},
    )
    assert response.status_code == 200


def test_session_hashes_browser_token_and_never_echoes_it() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        response = client.put(
            "/v1/session",
            headers=HEADERS,
            json={"nickname": "퀴즈왕", "characterId": "slime-blue"},
        )

    assert response.status_code == 200
    assert response.json() == {"playerId": str(PLAYER_ID)}
    assert repository.session_token_hash == hashlib.sha256(PLAYER_TOKEN.encode()).digest()
    assert PLAYER_TOKEN not in response.text


def test_session_assigns_a_default_character_to_a_legacy_client() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        response = client.put(
            "/v1/session",
            headers=HEADERS,
            json={},
        )

    assert response.status_code == 200
    assert repository.session_token_hash is not None
    assert repository.session_player is not None
    assert repository.session_player.nickname == "손님"
    assert repository.session_player.character_id == "slime-blue"


def test_room_create_rejects_removed_normal_mode() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        response = client.post(
            "/v1/rooms",
            headers=HEADERS,
            json={
                "name": "보통 모드 금지",
                "categoryId": None,
                "capacity": 12,
                "isPublic": True,
                "gameMode": False,
            },
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid-game-mode"
    assert repository.create_calls == 0


def test_room_update_rejects_removed_normal_mode_before_repository_mutation() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        response = client.patch(
            "/v1/rooms/ABC234",
            headers=HEADERS,
            json={"gameMode": False},
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid-game-mode"
    assert repository.update_calls == 0


def test_session_process_limit_survives_client_and_identity_rotation() -> None:
    repository = RotatingIdentityRepository()
    with make_client(repository) as client:
        responses = [
            client.put(
                "/v1/session",
                headers=rotating_headers(index, f"198.51.100.{index // 60 + 1}"),
                json={"nickname": f"퀴즈왕{index}", "characterId": "slime-blue"},
            )
            for index in range(301)
        ]

    assert [response.status_code for response in responses[:300]] == [200] * 300
    assert responses[300].status_code == 429
    assert responses[300].json()["detail"]["code"] == "rate-limited"
    assert len(repository.sessions) == 300


def test_authenticated_client_limit_runs_before_database_authentication() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        responses = [client.get("/v1/rooms", headers=HEADERS) for _ in range(121)]

    assert [response.status_code for response in responses[:120]] == [200] * 120
    assert responses[120].status_code == 429
    assert responses[120].headers["retry-after"] == "1"
    assert repository.authenticate_calls == 120


def test_room_create_actor_limit_survives_client_rotation() -> None:
    repository = RotatingIdentityRepository()
    with make_client(repository) as client:
        headers = register_rotating_identity(client, 0, "198.51.100.1")
        responses = []
        for index in range(11):
            attempt_headers = {
                **headers,
                "X-Forwarded-For": f"198.51.100.{index + 10}",
            }
            responses.append(
                client.post(
                    "/v1/rooms",
                    headers=attempt_headers,
                    json=public_room_body(index),
                )
            )

    assert [response.status_code for response in responses[:10]] == [201] * 10
    assert responses[10].status_code == 429
    assert repository.create_calls == 10


def test_room_create_client_limit_survives_identity_rotation() -> None:
    repository = RotatingIdentityRepository()
    client_key = "198.51.100.20"
    with make_client(repository) as client:
        headers = [
            register_rotating_identity(client, index, client_key)
            for index in range(31)
        ]
        responses = [
            client.post("/v1/rooms", headers=identity, json=public_room_body(index))
            for index, identity in enumerate(headers)
        ]

    assert [response.status_code for response in responses[:30]] == [201] * 30
    assert responses[30].status_code == 429
    assert repository.create_calls == 30


def test_room_create_process_limit_survives_client_and_identity_rotation() -> None:
    repository = RotatingIdentityRepository()
    with make_client(repository) as client:
        headers = [
            register_rotating_identity(client, index, f"203.0.113.{index + 1}")
            for index in range(101)
        ]
        responses = [
            client.post("/v1/rooms", headers=identity, json=public_room_body(index))
            for index, identity in enumerate(headers)
        ]

    assert [response.status_code for response in responses[:100]] == [201] * 100
    assert responses[100].status_code == 429
    assert repository.create_calls == 100


def test_private_password_process_limit_survives_client_and_identity_rotation() -> None:
    class AcceptingHasher:
        def hash(self, password: str) -> str:
            raise AssertionError("hash is not used while joining a room")

        def verify(self, encoded: str, password: str) -> bool:
            return True

    repository = RotatingIdentityRepository()
    repository.password_hash = "encoded-password"  # noqa: S105 - inert test double value
    with make_client(repository, password_hasher=AcceptingHasher()) as client:
        headers = [
            register_rotating_identity(client, index, f"192.0.2.{index + 1}")
            for index in range(121)
        ]
        responses = [
            client.post(
                "/v1/rooms/ABC234/join",
                headers=identity,
                json={"password": "room-lock!"},
            )
            for identity in headers
        ]

    assert [response.status_code for response in responses[:120]] == [200] * 120
    assert responses[120].status_code == 429
    assert repository.join_calls == 120


def test_room_list_includes_private_metadata_without_password_material() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        response = client.get("/v1/rooms", headers=HEADERS)

    assert response.status_code == 200
    assert response.json()[0]["isPublic"] is False
    assert response.json()[0]["hasPassword"] is True
    assert response.json()[0]["capacity"] == 12
    serialized = response.text.lower()
    assert "passwordhash" not in serialized
    assert "password_hash" not in serialized
    assert "player-token" not in serialized


def test_private_room_password_is_argon2_hashed_before_repository_write() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        response = client.post(
            "/v1/rooms",
            headers=HEADERS,
            json={
                "name": "잠긴 방",
                "categoryId": None,
                "capacity": 12,
                "isPublic": False,
                "password": "room-lock!",
            },
        )

    assert response.status_code == 201
    assert repository.created_password_hash is not None
    assert repository.created_password_hash.startswith("$argon2id$")
    assert "room-lock!" not in response.text


def test_private_room_create_maps_password_capacity_to_429_before_repository_write() -> None:
    class BusyHasher:
        def hash(self, password: str) -> str:
            raise PasswordWorkBusy

        def verify(self, encoded: str, password: str) -> bool:
            raise AssertionError("verify is not used while creating a room")

    repository = FakeRepository()
    app = create_app(repository=repository, password_hasher=BusyHasher())
    with TestClient(app, raise_server_exceptions=False) as client:
        register(client)
        response = client.post(
            "/v1/rooms",
            headers=HEADERS,
            json={
                "name": "잠긴 방",
                "categoryId": None,
                "capacity": 12,
                "isPublic": False,
                "password": "room-lock!",
            },
        )

    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "rate-limited"
    assert response.headers["retry-after"] == "1"
    assert repository.create_calls == 0


def test_private_join_rejects_wrong_password_before_atomic_join() -> None:
    from argon2 import PasswordHasher

    repository = FakeRepository()
    repository.password_hash = PasswordHasher().hash("correct-password")
    with make_client(repository) as client:
        register(client)
        response = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": "wrong-password"},
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "wrong-password"
    assert repository.join_calls == 0


def test_private_join_maps_password_capacity_to_429_before_repository_join() -> None:
    class BusyHasher:
        def hash(self, password: str) -> str:
            raise AssertionError("hash is not used while joining a room")

        def verify(self, encoded: str, password: str) -> bool:
            raise PasswordWorkBusy

    repository = FakeRepository()
    repository.password_hash = "encoded-password"  # noqa: S105 - inert test double value
    app = create_app(repository=repository, password_hasher=BusyHasher())
    with TestClient(app, raise_server_exceptions=False) as client:
        register(client)
        response = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": "room-lock!"},
        )

    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "rate-limited"
    assert response.headers["retry-after"] == "1"
    assert repository.join_calls == 0


@pytest.mark.parametrize(
    "error_type",
    [VerifyMismatchError, VerificationError, InvalidHashError],
)
def test_private_join_keeps_argon_verification_failures_as_wrong_password(
    error_type: type[Exception],
) -> None:
    class FailingHasher:
        def hash(self, password: str) -> str:
            raise AssertionError("hash is not used while joining a room")

        def verify(self, encoded: str, password: str) -> bool:
            raise error_type("injected invalid password hash")

    repository = FakeRepository()
    repository.password_hash = "encoded-password"  # noqa: S105 - inert test double value
    with make_client(repository, password_hasher=FailingHasher()) as client:
        register(client)
        response = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": "room-lock!"},
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "wrong-password"
    assert repository.join_calls == 0


def test_private_join_accepts_correct_password_and_maps_full_conflict() -> None:
    from argon2 import PasswordHasher

    repository = FakeRepository()
    repository.password_hash = PasswordHasher().hash("correct-password")
    with make_client(repository) as client:
        register(client)
        accepted = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": "correct-password"},
        )
        assert accepted.status_code == 200
        assert repository.join_calls == 1

        async def full_join(actor_id: UUID, code: str) -> RoomView:
            raise RoomFull

        repository.join_room = full_join  # type: ignore[method-assign]
        full = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": "correct-password"},
        )

    assert full.status_code == 409
    assert full.json()["detail"]["code"] == "full"


def test_existing_member_reenters_private_full_room_without_password() -> None:
    repository = FakeRepository()
    repository.member = True
    repository.password_hash = "not-used-for-an-existing-member"  # noqa: S105
    with make_client(repository) as client:
        register(client)
        response = client.post(
            f"/v1/rooms/{repository.room.code}/join",
            headers=HEADERS,
            json={"password": None},
        )

    assert response.status_code == 200
    assert repository.join_calls == 1


def test_private_join_is_rate_limited_before_unbounded_password_checks() -> None:
    from argon2 import PasswordHasher

    repository = FakeRepository()
    repository.password_hash = PasswordHasher(
        time_cost=1,
        memory_cost=8_192,
        parallelism=1,
    ).hash("correct-password")
    with make_client(repository) as client:
        register(client)
        attempts = [
            client.post(
                f"/v1/rooms/{repository.room.code}/join",
                headers=HEADERS,
                json={"password": "wrong"},
            )
            for _ in range(11)
        ]

    assert [response.status_code for response in attempts[:10]] == [403] * 10
    assert attempts[10].status_code == 429
    assert attempts[10].json()["detail"]["code"] == "rate-limited"


def test_chat_and_websocket_ticket_issuance_are_rate_limited_per_actor_and_room() -> None:
    repository = FakeRepository()
    repository.member = True
    with make_client(repository) as client:
        register(client)
        chats = [
            client.post(
                f"/v1/rooms/{repository.room.code}/chat",
                headers=HEADERS,
                json={"text": "안녕하세요"},
            )
            for _ in range(13)
        ]
        tickets = [
            client.post(
                f"/v1/rooms/{repository.room.code}/ws-ticket",
                headers=HEADERS,
            )
            for _ in range(7)
        ]

    assert [response.status_code for response in chats[:12]] == [202] * 12
    assert chats[12].status_code == 429
    assert chats[12].json()["detail"]["code"] == "rate-limited"
    assert [response.status_code for response in tickets[:6]] == [201] * 6
    assert tickets[6].status_code == 429
    assert tickets[6].json()["detail"]["code"] == "rate-limited"


def test_protected_routes_reject_unknown_browser_session() -> None:
    repository = FakeRepository()
    repository.authenticated = False
    with make_client(repository) as client:
        response = client.get("/v1/rooms", headers=HEADERS)

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "unauthorized"


def test_websocket_ticket_is_single_use_and_chat_is_broadcast() -> None:
    repository = FakeRepository()
    repository.member = True
    with make_client(repository) as client:
        register(client)
        ticket_response = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=HEADERS,
        )
        assert ticket_response.status_code == 201
        ticket = ticket_response.json()["ticket"]

        with client.websocket_connect(
            f"/v1/rooms/{repository.room.code}/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            assert websocket.accepted_subprotocol == WS_PROTOCOL
            chat = client.post(
                f"/v1/rooms/{repository.room.code}/chat",
                headers=HEADERS,
                json={"text": "안녕하세요"},
            )
            assert chat.status_code == 202
            event = websocket.receive_json()

        assert event["type"] == "chat"
        assert event["playerId"] == str(PLAYER_ID)
        assert event["nickname"] == "퀴즈왕"
        assert event["text"] == "안녕하세요"

        try:
            with client.websocket_connect(
                f"/v1/rooms/{repository.room.code}/events",
                subprotocols=ws_protocols(ticket),
            ):
                raise AssertionError("a consumed ticket must not connect")
        except WebSocketDisconnect as error:
            assert error.code == 4403


def test_websocket_heartbeats_do_not_write_each_inbound_message() -> None:
    repository = FakeRepository()
    repository.member = True
    with make_client(repository) as client:
        register(client)
        ticket = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=HEADERS,
        ).json()["ticket"]
        events_url = f"/v1/rooms/{repository.room.code}/events"
        with client.websocket_connect(
            events_url,
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            websocket.send_text("heartbeat")
            websocket.send_text("heartbeat")
            chat = client.post(
                f"/v1/rooms/{repository.room.code}/chat",
                headers=HEADERS,
                json={"text": "동기화 확인"},
            )
            assert chat.status_code == 202
            assert websocket.receive_json()["type"] == "chat"

    assert repository.touch_calls == 1


def test_websocket_actor_room_cap_rejects_a_third_connection() -> None:
    repository = FakeRepository()
    repository.member = True
    with make_client(repository) as client:
        register(client)
        tickets = [
            client.post(
                f"/v1/rooms/{repository.room.code}/ws-ticket",
                headers=HEADERS,
            ).json()["ticket"]
            for _ in range(3)
        ]
        events_url = f"/v1/rooms/{repository.room.code}/events"
        with client.websocket_connect(
            events_url,
            subprotocols=ws_protocols(tickets[0]),
        ):
            with client.websocket_connect(
                events_url,
                subprotocols=ws_protocols(tickets[1]),
            ):
                with pytest.raises(WebSocketDisconnect) as rejected:
                    with client.websocket_connect(
                        events_url,
                        subprotocols=ws_protocols(tickets[2]),
                    ):
                        pass

    assert rejected.value.code == 4429


def test_leaving_a_room_closes_that_actors_websocket() -> None:
    repository = FakeRepository()
    repository.member = True
    with make_client(repository) as client:
        register(client)
        ticket = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=HEADERS,
        ).json()["ticket"]
        with client.websocket_connect(
            f"/v1/rooms/{repository.room.code}/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            response = client.delete(
                f"/v1/rooms/{repository.room.code}/members/me",
                headers=HEADERS,
            )
            with pytest.raises(WebSocketDisconnect) as disconnected:
                websocket.receive_json()

    assert response.status_code == 204
    assert disconnected.value.code == 4403


def test_websocket_inbound_rate_limit_closes_a_flooding_connection() -> None:
    repository = FakeRepository()
    repository.member = True
    with make_client(repository) as client:
        register(client)
        ticket = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=HEADERS,
        ).json()["ticket"]
        with client.websocket_connect(
            f"/v1/rooms/{repository.room.code}/events",
            subprotocols=ws_protocols(ticket),
        ) as websocket:
            for _ in range(13):
                websocket.send_text("heartbeat")
            with pytest.raises(WebSocketDisconnect) as disconnected:
                websocket.receive_json()

    assert disconnected.value.code == 4429
