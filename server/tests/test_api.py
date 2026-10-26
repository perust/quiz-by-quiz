from __future__ import annotations

import hashlib
import threading
import time
from collections.abc import Mapping
from dataclasses import replace
from typing import Any
from uuid import UUID

import pytest
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import EventHub, RemovedMembers, create_app
from app.password_work import PasswordWorkBusy
from app.repository import (
    AbsentHostSweep,
    AccessInfo,
    MatchInProgress,
    MatchSetup,
    MemberConnected,
    NotHost,
    PlayerView,
    RoomFull,
    RoomView,
)

PLAYER_ID = UUID("12345678-1234-5678-9234-567812345678")
MATCH_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
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
        self.created_spec: Any | None = None
        self.session_token_hash: bytes | None = None
        self.session_player: Any | None = None
        self.join_calls = 0
        self.update_calls = 0
        self.updated_patch: Any | None = None
        self.member = False
        self.touch_calls = 0
        self.authenticate_calls = 0
        self.current_schema_version = 10
        self.schema_version_calls = 0
        self.start_absent_player_ids: frozenset[UUID] | None = None
        self.transfer_calls: list[dict[str, frozenset[UUID]]] = []
        self.transfer_requested = threading.Event()
        # 끊긴 방장을 넘길 수 있는가(접속 중인 사람이 있는가). 한 번 넘기면 다시 넘기지 않는다.
        self.can_transfer = True
        self.transferred_codes: set[str] = set()
        # None이면 끊긴 사람도 모두 아직 참가자다. 값이 있으면 그 사람들만 참가자다.
        self.member_ids: frozenset[UUID] | None = None
        self.leave_absent_player_ids: frozenset[UUID] | None = None
        # 방에서 빠진 사람. 이 사람에게는 방이 없고(get_room None) 소켓 티켓도 나오지 않는다.
        self.non_member_ids: set[UUID] = set()
        self.remove_calls: list[tuple[UUID, str, UUID, frozenset[UUID]]] = []
        # 각 내보내기 요청이 접속 중인 사람까지 허락했는가 (remove_calls 와 같은 순서)
        self.remove_allow_connected: list[bool] = []
        self.remove_error: Exception | None = None

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def health(self) -> bool:
        return True

    async def schema_version(self) -> int:
        self.schema_version_calls += 1
        return self.current_schema_version

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
        self.created_spec = spec
        self.created_password_hash = password_hash
        return self.room

    async def get_room(self, actor_id: UUID, code: str) -> RoomView | None:
        if actor_id in self.non_member_ids:
            return None
        return self.room if code == self.room.code else None

    async def get_access(self, code: str) -> AccessInfo | None:
        if code != self.room.code:
            return None
        return AccessInfo(is_public=self.password_hash is None, password_hash=self.password_hash)

    async def join_room(self, actor_id: UUID, code: str) -> RoomView:
        self.join_calls += 1
        self.non_member_ids.discard(actor_id)
        return self.room

    async def leave_room(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> RoomView | None:
        self.leave_absent_player_ids = absent_player_ids
        return None

    async def remove_member(
        self,
        actor_id: UUID,
        code: str,
        player_id: UUID,
        *,
        absent_player_ids: frozenset[UUID],
        allow_connected: bool = False,
    ) -> RoomView:
        self.remove_calls.append((actor_id, code, player_id, absent_player_ids))
        self.remove_allow_connected.append(allow_connected)
        if self.remove_error is not None:
            raise self.remove_error
        if not allow_connected and player_id not in absent_player_ids:
            raise MemberConnected
        self.non_member_ids.add(player_id)
        self.room = replace(
            self.room,
            players=tuple(player for player in self.room.players if player.id != player_id),
        )
        return self.room

    async def update_room(self, actor_id: UUID, code: str, patch: Any) -> RoomView:
        self.update_calls += 1
        self.updated_patch = patch
        return self.room

    async def send_chat(self, actor_id: UUID, code: str, text: str) -> PlayerView:
        return self.room.players[0]

    async def start_game(
        self,
        actor_id: UUID,
        code: str,
        *,
        absent_player_ids: frozenset[UUID] = frozenset(),
    ) -> MatchSetup:
        self.start_absent_player_ids = absent_player_ids
        return MatchSetup(
            id=MATCH_ID,
            category_id=self.room.category_id,
            game_mode=self.room.game_mode,
            total_questions=10,
        )

    async def transfer_absent_host(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
    ) -> bool:
        raise AssertionError("presence sweep reads every absent room at once")

    async def transfer_absent_hosts(
        self,
        absent_by_room: Mapping[str, frozenset[UUID]],
    ) -> AbsentHostSweep:
        self.transfer_calls.append(dict(absent_by_room))
        self.transfer_requested.set()
        transferred = frozenset(
            code
            for code in absent_by_room
            if code == self.room.code
            and self.can_transfer
            and code not in self.transferred_codes
        )
        self.transferred_codes |= transferred
        members = {
            code: self.member_ids if self.member_ids is not None else absent
            for code, absent in absent_by_room.items()
            if code == self.room.code
        }
        return AbsentHostSweep(transferred=transferred, members=members)

    async def advance_past_absent_players(
        self,
        code: str,
        absent_player_ids: frozenset[UUID],
    ) -> bool:
        # 이 가짜 방에는 진행 중인 판이 없다.
        return False

    async def is_member(self, actor_id: UUID, code: str) -> bool:
        return self.member and code == self.room.code and actor_id not in self.non_member_ids

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


def test_release_readiness_requires_character_only_contract_and_migration_10() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        ready = client.get("/v1/release-readiness")
        assert ready.status_code == 200
        assert ready.json() == {
            "status": "ready",
            "contract": "character-only-v1",
            "schemaVersion": 10,
        }

        repository.current_schema_version = 9
        blocked = client.get("/v1/release-readiness")
        assert blocked.status_code == 503
        assert blocked.json()["detail"]["code"] == "migration-required"


def test_release_readiness_database_queries_are_rate_limited() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        responses = [client.get("/v1/release-readiness") for _ in range(13)]

    assert [response.status_code for response in responses[:12]] == [200] * 12
    assert responses[12].status_code == 429
    assert responses[12].json()["detail"]["code"] == "rate-limited"
    assert repository.schema_version_calls == 12


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


def test_room_create_normalizes_legacy_false_to_character_only() -> None:
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

    assert response.status_code == 201
    assert response.json()["gameMode"] is True
    assert repository.create_calls == 1
    assert repository.created_spec is not None
    assert repository.created_spec.game_mode is True


def test_room_update_treats_legacy_false_as_a_character_only_noop() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        register(client)
        response = client.patch(
            "/v1/rooms/ABC234",
            headers=HEADERS,
            json={"gameMode": False},
        )

    assert response.status_code == 200
    assert response.json()["gameMode"] is True
    assert repository.update_calls == 1
    assert repository.updated_patch == {}


def test_session_rejects_invalid_character_as_a_client_error() -> None:
    repository = FakeRepository()
    with make_client(repository) as client:
        response = client.put(
            "/v1/session",
            headers=HEADERS,
            json={"nickname": "퀴즈왕", "characterId": "UPPERCASE"},
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid-character"
    assert repository.session_token_hash is None


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
        ticket_body = ticket_response.json()
        assert ticket_body["movementViewport"] == "sender-css-pixels-v1"
        assert ticket_body["movementSeat"] == "waiting-room-seat-v1"
        ticket = ticket_body["ticket"]

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


def test_authenticated_websocket_movement_is_broadcast_with_server_identity() -> None:
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
            websocket.send_json(
                {
                    "type": "movement",
                    "x": 0.25,
                    "y": 0.75,
                    "moving": False,
                    "viewportWidth": 390,
                    "viewportHeight": 844,
                    "seatId": "sofa-left",
                }
            )
            chat = client.post(
                f"/v1/rooms/{repository.room.code}/chat",
                headers=HEADERS,
                json={"text": "movement 뒤 이벤트"},
            )
            assert chat.status_code == 202
            event = websocket.receive_json()

    assert event["type"] == "movement"
    assert event["playerId"] == str(PLAYER_ID)
    assert event["x"] == 0.25
    assert event["y"] == 0.75
    assert event["moving"] is False
    assert event["viewportWidth"] == 390
    assert event["viewportHeight"] == 844
    assert event["seatId"] == "sofa-left"
    assert type(event["sequence"]) is int
    assert event["sequence"] > 0


def test_movement_relays_both_directions_between_two_authenticated_actors() -> None:
    repository = RotatingIdentityRepository()
    repository.member = True
    with make_client(repository) as client:
        first_headers = register_rotating_identity(client, 20, "198.51.100.20")
        second_headers = register_rotating_identity(client, 21, "198.51.100.21")
        first_id = first_headers["X-Player-Id"]
        second_id = second_headers["X-Player-Id"]
        first_ticket = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=first_headers,
        ).json()["ticket"]
        second_ticket = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=second_headers,
        ).json()["ticket"]

        with (
            client.websocket_connect(
                f"/v1/rooms/{repository.room.code}/events",
                subprotocols=ws_protocols(first_ticket),
            ) as first_socket,
            client.websocket_connect(
                f"/v1/rooms/{repository.room.code}/events",
                subprotocols=ws_protocols(second_ticket),
            ) as second_socket,
        ):
            first_socket.send_json(
                {"type": "movement", "x": 0.2, "y": 0.3, "moving": True}
            )
            first_echo = first_socket.receive_json()
            first_seen_by_second = second_socket.receive_json()

            second_socket.send_json(
                {"type": "movement", "x": 0.8, "y": 0.7, "moving": False}
            )
            second_seen_by_first = first_socket.receive_json()
            second_echo = second_socket.receive_json()

    assert first_echo == first_seen_by_second
    assert first_seen_by_second["playerId"] == first_id
    assert first_seen_by_second["x"] == 0.2
    assert "viewportWidth" not in first_seen_by_second
    assert "viewportHeight" not in first_seen_by_second
    assert second_seen_by_first == second_echo
    assert second_seen_by_first["playerId"] == second_id
    assert second_seen_by_first["x"] == 0.8
    assert second_seen_by_first["sequence"] > first_seen_by_second["sequence"]


def test_invalid_or_identity_spoofing_movement_is_not_broadcast() -> None:
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
            websocket.send_json(
                {"type": "movement", "x": 2, "y": 0.5, "moving": True}
            )
            websocket.send_json(
                {
                    "type": "movement",
                    "x": 0.2,
                    "y": 0.5,
                    "moving": True,
                    "viewportWidth": 390,
                }
            )
            websocket.send_json(
                {
                    "type": "movement",
                    "x": 0.2,
                    "y": 0.5,
                    "moving": True,
                    "viewportWidth": 0,
                    "viewportHeight": 844,
                }
            )
            websocket.send_json(
                {
                    "type": "movement",
                    "x": 0.2,
                    "y": 0.5,
                    "moving": False,
                    "viewportWidth": 390,
                    "viewportHeight": 844,
                    "seatId": "table",
                }
            )
            websocket.send_json(
                {
                    "type": "movement",
                    "x": 0.2,
                    "y": 0.5,
                    "moving": True,
                    "viewportWidth": 390,
                    "viewportHeight": 844,
                    "seatId": "chair-left",
                }
            )
            websocket.send_json(
                {
                    "type": "movement",
                    "x": 0.2,
                    "y": 0.5,
                    "moving": False,
                    "seatId": "chair-left",
                }
            )
            websocket.send_json(
                {
                    "type": "movement",
                    "playerId": "22222222-2222-4222-8222-222222222222",
                    "x": 0.2,
                    "y": 0.5,
                    "moving": True,
                }
            )
            chat = client.post(
                f"/v1/rooms/{repository.room.code}/chat",
                headers=HEADERS,
                json={"text": "유효 이벤트"},
            )
            assert chat.status_code == 202
            event = websocket.receive_json()

    assert event["type"] == "chat"


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
            for _ in range(31):
                websocket.send_text("heartbeat")
            with pytest.raises(WebSocketDisconnect) as disconnected:
                websocket.receive_json()

    assert disconnected.value.code == 4429


class FakeClock:
    def __init__(self) -> None:
        self.now = 5_000.0

    def __call__(self) -> float:
        return self.now


def wait_until(predicate: Any, message: str) -> None:
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(message)


OTHER_ID = UUID("87654321-4321-4765-8321-876543218765")


def test_room_payload_marks_long_disconnected_members_and_start_skips_them() -> None:
    repository = FakeRepository()
    repository.member = True
    repository.room = room_view(
        players=(
            PlayerView(id=PLAYER_ID, nickname="퀴즈왕", character_id="slime-blue"),
            PlayerView(
                id=OTHER_ID,
                nickname="친구",
                character_id="slime-pink",
                is_ready=True,
            ),
        ),
    )
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    with TestClient(create_app(repository=repository, event_hub=hub)) as client:
        register(client)
        ticket = client.post(
            f"/v1/rooms/{repository.room.code}/ws-ticket",
            headers=HEADERS,
        ).json()["ticket"]
        with client.websocket_connect(
            f"/v1/rooms/{repository.room.code}/events",
            subprotocols=ws_protocols(ticket),
        ):
            wait_until(lambda: hub.is_present("ABC234", PLAYER_ID), "socket was not activated")
            fresh = client.get("/v1/rooms/ABC234", headers=HEADERS).json()
            # 소켓을 아직 본 적 없는 친구도 처음 물어본 때부터 유예를 센다.
            assert [player["connected"] for player in fresh["players"]] == [True, True]

            clock.now += 61
            stale = client.get("/v1/rooms/ABC234", headers=HEADERS).json()
            assert [player["connected"] for player in stale["players"]] == [True, False]

            started = client.post("/v1/rooms/ABC234/start", headers=HEADERS)

    assert started.status_code == 201
    assert repository.start_absent_player_ids == frozenset({OTHER_ID})


def test_presence_sweep_transfers_an_absent_host_and_invalidates_remaining_screens() -> None:
    repository = RotatingIdentityRepository()
    repository.member = True
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(
        repository=repository,
        event_hub=hub,
        presence_interval_seconds=0.01,
    )
    with TestClient(app) as client:
        stayer = register_rotating_identity(client, 30, "198.51.100.30")
        leaver = register_rotating_identity(client, 31, "198.51.100.31")
        leaver_id = UUID(leaver["X-Player-Id"])
        tickets = [
            client.post("/v1/rooms/ABC234/ws-ticket", headers=headers).json()["ticket"]
            for headers in (stayer, leaver)
        ]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(tickets[0]),
        ) as stayer_socket:
            with client.websocket_connect(
                "/v1/rooms/ABC234/events",
                subprotocols=ws_protocols(tickets[1]),
            ):
                wait_until(lambda: hub.connection_count == 2, "sockets were not admitted")
            wait_until(lambda: hub.connection_count == 1, "closed socket stayed admitted")

            # 유예 안의 끊김은 방송하지도 방장을 넘기지도 않는다.
            time.sleep(0.05)
            assert repository.transfer_calls == []

            clock.now += 61
            assert repository.transfer_requested.wait(timeout=2)
            event = stayer_socket.receive_json()

    assert repository.transfer_calls[0] == {"ABC234": frozenset({leaver_id})}
    assert event == {"type": "room-invalidated"}


def _issue_tickets(
    client: TestClient,
    stayer: dict[str, str],
    leaver: dict[str, str],
) -> tuple[str, str]:
    tickets = [
        client.post("/v1/rooms/ABC234/ws-ticket", headers=headers).json()["ticket"]
        for headers in (stayer, leaver)
    ]
    return tickets[0], tickets[1]


def test_presence_sweep_keeps_retrying_an_absent_host_until_someone_can_take_over() -> None:
    # server-1: 방장만 있던 방에서 방장이 끊기면 넘길 사람이 없다. 그 뒤에 누가 들어와도
    # 끊긴 사람의 집합은 그대로라, 집합이 바뀔 때만 보던 sweep은 다시 넘기지 않았다.
    repository = RotatingIdentityRepository()
    repository.member = True
    repository.can_transfer = False
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(
        repository=repository,
        event_hub=hub,
        presence_interval_seconds=0.01,
    )
    with TestClient(app) as client:
        stayer = register_rotating_identity(client, 40, "198.51.100.40")
        leaver = register_rotating_identity(client, 41, "198.51.100.41")
        leaver_id = UUID(leaver["X-Player-Id"])
        stayer_ticket, leaver_ticket = _issue_tickets(client, stayer, leaver)
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(stayer_ticket),
        ) as stayer_socket:
            with client.websocket_connect(
                "/v1/rooms/ABC234/events",
                subprotocols=ws_protocols(leaver_ticket),
            ):
                wait_until(lambda: hub.connection_count == 2, "sockets were not admitted")
            wait_until(lambda: hub.connection_count == 1, "closed socket stayed admitted")

            clock.now += 61
            # 끊김이 처음 보일 때 한 번 다시 읽게 한다. 넘길 사람이 없어 넘기지는 못했다.
            assert stayer_socket.receive_json() == {"type": "room-invalidated"}
            wait_until(
                lambda: len(repository.transfer_calls) >= 3,
                "the sweep stopped looking at a room whose host is still absent",
            )
            assert repository.transferred_codes == set()

            # 접속 중인 사람이 생겼다(늦게 들어왔다). 끊긴 사람의 집합은 그대로다.
            repository.can_transfer = True
            wait_until(
                lambda: repository.transferred_codes == {"ABC234"},
                "a member who joined after the failed transfer never became host",
            )
            assert stayer_socket.receive_json() == {"type": "room-invalidated"}

    assert repository.transferred_codes == {"ABC234"}
    assert all(
        call == {"ABC234": frozenset({leaver_id})} for call in repository.transfer_calls
    )


def test_presence_sweep_forgets_members_that_the_room_no_longer_has() -> None:
    # server-6: 30분 정리는 hub를 거치지 않는다. sweep이 참가자 목록을 보고 기록을 버린다.
    repository = RotatingIdentityRepository()
    repository.member = True
    repository.can_transfer = False
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(
        repository=repository,
        event_hub=hub,
        presence_interval_seconds=0.01,
    )
    with TestClient(app) as client:
        stayer = register_rotating_identity(client, 42, "198.51.100.42")
        leaver = register_rotating_identity(client, 43, "198.51.100.43")
        stayer_id = UUID(stayer["X-Player-Id"])
        leaver_id = UUID(leaver["X-Player-Id"])
        stayer_ticket, leaver_ticket = _issue_tickets(client, stayer, leaver)
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(stayer_ticket),
        ) as stayer_socket:
            with client.websocket_connect(
                "/v1/rooms/ABC234/events",
                subprotocols=ws_protocols(leaver_ticket),
            ):
                wait_until(lambda: hub.connection_count == 2, "sockets were not admitted")
            wait_until(lambda: hub.connection_count == 1, "closed socket stayed admitted")

            clock.now += 61
            assert stayer_socket.receive_json() == {"type": "room-invalidated"}
            assert hub.absent_actors("ABC234") == frozenset({leaver_id})

            # 정리가 끊긴 사람을 방에서 뺐다. 남은 화면도 다시 읽는다.
            repository.member_ids = frozenset({stayer_id})
            wait_until(
                lambda: hub.absent_actors("ABC234") == frozenset(),
                "the sweep kept the presence record of a removed member",
            )
            assert stayer_socket.receive_json() == {"type": "room-invalidated"}
            # 같은 방에 다시 들어오면 처음 본 사람처럼 새 유예로 센다.
            assert hub.is_present("ABC234", leaver_id)


def test_rejoining_after_membership_ended_starts_a_fresh_grace() -> None:
    # server-6: 예전 멤버십의 끊김 기록이 남아 있으면 들어오자마자 «연결 끊김»이고 시작에서 빠졌다.
    repository = FakeRepository()
    repository.member = True
    repository.password_hash = None
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    with TestClient(create_app(repository=repository, event_hub=hub)) as client:
        register(client)
        ticket = client.post("/v1/rooms/ABC234/ws-ticket", headers=HEADERS).json()["ticket"]
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(ticket),
        ):
            wait_until(lambda: hub.is_present("ABC234", PLAYER_ID), "socket was not activated")
        wait_until(lambda: hub.connection_count == 0, "closed socket stayed admitted")
        clock.now += 61
        assert hub.absent_actors("ABC234") == frozenset({PLAYER_ID})

        # 30분 정리로 방에서 빠졌다가 같은 방에 다시 들어온다.
        repository.member = False
        joined = client.post("/v1/rooms/ABC234/join", headers=HEADERS, json={})

    assert joined.status_code == 200
    assert [player["connected"] for player in joined.json()["players"]] == [True]
    assert hub.absent_actors("ABC234") == frozenset()


def test_leave_hands_the_host_to_a_connected_member_and_forgets_a_deleted_room() -> None:
    # server-2: 나가는 방장의 자리를 끊긴 사람에게 넘기면 남은 사람이 시작할 수 없었다.
    repository = FakeRepository()
    repository.member = True
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    with TestClient(create_app(repository=repository, event_hub=hub)) as client:
        register(client)
        assert hub.is_present("ABC234", OTHER_ID)
        clock.now += 61
        left = client.delete("/v1/rooms/ABC234/members/me", headers=HEADERS)

    assert left.status_code == 204
    assert repository.leave_absent_player_ids == frozenset({OTHER_ID})
    # 이 가짜 방은 마지막 사람이 나가 사라졌다. 같은 코드의 기록이 남지 않는다.
    assert hub.absent_actors("ABC234") == frozenset()


def _two_member_room(host_id: UUID, ghost_id: UUID) -> RoomView:
    return room_view(
        players=(
            PlayerView(id=host_id, nickname="방장", character_id="slime-blue"),
            PlayerView(id=ghost_id, nickname="유령", character_id="slime-pink"),
        ),
    )


def test_host_removes_a_long_disconnected_member_and_they_hear_why_when_they_return() -> None:
    # U24: 탭을 닫고 떠난 자리를 방장이 비운다. 돌아온 사람은 «없는 방»이 아니라 이유를 듣고,
    # 다시 들어오는 것은 막지 않는다(차단이 아니다).
    repository = RotatingIdentityRepository()
    repository.member = True
    repository.password_hash = None
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    app = create_app(repository=repository, event_hub=hub)
    with TestClient(app) as client:
        host = register_rotating_identity(client, 60, "198.51.100.60")
        ghost = register_rotating_identity(client, 61, "198.51.100.61")
        host_id = UUID(host["X-Player-Id"])
        ghost_id = UUID(ghost["X-Player-Id"])
        repository.room = _two_member_room(host_id, ghost_id)
        host_ticket, ghost_ticket = _issue_tickets(client, host, ghost)
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(host_ticket),
        ) as host_socket:
            with client.websocket_connect(
                "/v1/rooms/ABC234/events",
                subprotocols=ws_protocols(ghost_ticket),
            ):
                wait_until(lambda: hub.connection_count == 2, "sockets were not admitted")
            wait_until(lambda: hub.connection_count == 1, "closed socket stayed admitted")

            # 유예 안에서는 내보낼 수 없다 — 잠깐 끊긴 사람은 곧 돌아온다.
            early = client.delete(f"/v1/rooms/ABC234/members/{ghost_id}", headers=host)
            assert early.status_code == 409
            assert early.json()["detail"]["code"] == "member-connected"

            clock.now += 61
            removed = client.delete(f"/v1/rooms/ABC234/members/{ghost_id}", headers=host)
            assert removed.status_code == 200
            assert [player["id"] for player in removed.json()["players"]] == [str(host_id)]
            assert host_socket.receive_json() == {"type": "room-invalidated"}

        assert repository.remove_calls[-1] == (host_id, "ABC234", ghost_id, frozenset({ghost_id}))
        # 끊김 기록은 멤버십과 함께 끝난다.
        assert hub.absent_actors("ABC234") == frozenset()

        returned = client.get("/v1/rooms/ABC234", headers=ghost)
        assert returned.status_code == 404
        assert returned.json()["detail"]["code"] == "removed"
        reconnect = client.post("/v1/rooms/ABC234/ws-ticket", headers=ghost)
        assert reconnect.status_code == 403
        assert reconnect.json()["detail"]["code"] == "removed"

        # 다시 참가할 수 있고, 그 뒤에 빠지면 더는 «내보냈다»가 아니다.
        rejoined = client.post("/v1/rooms/ABC234/join", headers=ghost, json={})
        assert rejoined.status_code == 200
        repository.non_member_ids.add(ghost_id)
        later = client.get("/v1/rooms/ABC234", headers=ghost)
        assert later.json()["detail"]["code"] == "not-found"


def test_member_removal_rejects_self_bad_ids_and_maps_repository_refusals() -> None:
    repository = FakeRepository()
    repository.member = True
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    with TestClient(create_app(repository=repository, event_hub=hub)) as client:
        register(client)
        own = client.delete(f"/v1/rooms/ABC234/members/{PLAYER_ID}", headers=HEADERS)
        assert own.status_code == 400
        assert own.json()["detail"]["code"] == "invalid-target"
        malformed = client.delete("/v1/rooms/ABC234/members/not-a-uuid", headers=HEADERS)
        assert malformed.status_code == 404
        assert malformed.json()["detail"]["code"] == "not-member"
        assert repository.remove_calls == []

        assert hub.is_present("ABC234", OTHER_ID)
        clock.now += 61
        refusals = (
            (NotHost(), 403, "not-host"),
            (MatchInProgress(), 409, "game-in-progress"),
            (MemberConnected(), 409, "member-connected"),
        )
        for error, status, code in refusals:
            repository.remove_error = error
            response = client.delete(f"/v1/rooms/ABC234/members/{OTHER_ID}", headers=HEADERS)
            assert (response.status_code, response.json()["detail"]["code"]) == (status, code)
        # 나가기 경로는 그대로 나가기다.
        assert client.delete("/v1/rooms/ABC234/members/me", headers=HEADERS).status_code == 204
    assert repository.remove_calls[0][3] == frozenset({OTHER_ID})
    assert len(repository.remove_calls) == 3


def test_host_kicks_a_connected_member_who_is_told_at_once_and_kept_out_for_a_while() -> None:
    # 소유자 결정: 방장은 확인창을 거쳐 접속 중인 사람도 내보낸다. 그 사람의 열린 화면은 곧바로
    # 이유를 듣고 소켓이 닫히며, 잠시(KICK_BLOCK_SECONDS) 같은 방에 다시 들어오지 못한다.
    repository = RotatingIdentityRepository()
    repository.member = True
    repository.password_hash = "stored-hash"  # noqa: S105 - 막힌 사람은 비밀번호 확인까지 가지 않는다
    clock = FakeClock()
    hub = EventHub(presence_grace_seconds=60, clock=clock)
    records = RemovedMembers(record_seconds=3_600, block_seconds=600, clock=clock)
    app = create_app(repository=repository, event_hub=hub, removed_members=records)
    with TestClient(app) as client:
        host = register_rotating_identity(client, 70, "198.51.100.70")
        guest = register_rotating_identity(client, 71, "198.51.100.71")
        host_id = UUID(host["X-Player-Id"])
        guest_id = UUID(guest["X-Player-Id"])
        repository.room = _two_member_room(host_id, guest_id)
        host_ticket, guest_ticket = _issue_tickets(client, host, guest)
        with client.websocket_connect(
            "/v1/rooms/ABC234/events",
            subprotocols=ws_protocols(host_ticket),
        ) as host_socket:
            with client.websocket_connect(
                "/v1/rooms/ABC234/events",
                subprotocols=ws_protocols(guest_ticket),
            ) as guest_socket:
                wait_until(lambda: hub.connection_count == 2, "sockets were not admitted")

                # 끊긴 자리를 비우는 내보내기(구버전 화면의 길)는 접속 중인 사람을 빼지 않는다.
                seat_only = client.delete(f"/v1/rooms/ABC234/members/{guest_id}", headers=host)
                assert seat_only.status_code == 409
                assert seat_only.json()["detail"]["code"] == "member-connected"

                # 판에 자리가 있으면 판이 끝난 뒤에 뺀다. 거절된 내보내기는 아무도 막지 않는다.
                repository.remove_error = MatchInProgress()
                playing = client.delete(
                    f"/v1/rooms/ABC234/members/{guest_id}?connected=true",
                    headers=host,
                )
                assert playing.status_code == 409
                assert playing.json()["detail"]["code"] == "game-in-progress"
                assert records.reason("ABC234", guest_id) is None
                repository.remove_error = None

                kicked = client.delete(
                    f"/v1/rooms/ABC234/members/{guest_id}?connected=true",
                    headers=host,
                )
                assert kicked.status_code == 200
                assert [player["id"] for player in kicked.json()["players"]] == [str(host_id)]
                # 내보내진 화면은 다시 붙기를 기다리지 않고 이유를 먼저 듣고, 소켓이 닫힌다.
                assert guest_socket.receive_json() == {"type": "removed", "reason": "kicked"}
                with pytest.raises(WebSocketDisconnect) as closed:
                    guest_socket.receive_json()
                assert closed.value.code == 4403
            assert host_socket.receive_json() == {"type": "room-invalidated"}

        assert repository.remove_allow_connected == [False, True, True]
        assert repository.remove_calls[-1][:3] == (host_id, "ABC234", guest_id)
        assert hub.absent_actors("ABC234") == frozenset()

        returned = client.get("/v1/rooms/ABC234", headers=guest)
        assert returned.status_code == 404
        assert returned.json()["detail"]["code"] == "kicked"
        reconnect = client.post("/v1/rooms/ABC234/ws-ticket", headers=guest)
        assert reconnect.status_code == 403
        assert reconnect.json()["detail"]["code"] == "kicked"
        joins_before = repository.join_calls
        refused = client.post("/v1/rooms/ABC234/join", headers=guest, json={"password": "guess"})
        assert refused.status_code == 403
        assert refused.json()["detail"]["code"] == "kicked"
        assert refused.json()["detail"]["message"] == (
            "방장이 내보낸 방이에요. 잠시 뒤에 다시 들어올 수 있어요."
        )
        assert repository.join_calls == joins_before, "막힌 사람의 참가는 저장소에 닿지 않는다"

        # 막는 시간이 지나면 다시 들어온다. 그동안은 «내보냈다»로만 알린다.
        clock.now += 601
        assert client.get("/v1/rooms/ABC234", headers=guest).json()["detail"]["code"] == "removed"
        repository.password_hash = None
        rejoined = client.post("/v1/rooms/ABC234/join", headers=guest, json={})
        assert rejoined.status_code == 200
        assert records.reason("ABC234", guest_id) is None


def test_kick_block_is_per_room_and_ends_with_the_room() -> None:
    clock = FakeClock()
    records = RemovedMembers(record_seconds=3_600, block_seconds=600, clock=clock)
    records.mark("ABC234", PLAYER_ID, blocked=True)
    assert records.is_blocked("ABC234", PLAYER_ID)
    assert not records.is_blocked("XYZ789", PLAYER_ID), "다른 방은 막지 않는다"
    assert not records.is_blocked("ABC234", OTHER_ID)
    records.mark("ABC234", OTHER_ID)
    assert records.reason("ABC234", OTHER_ID) == "removed", "끊긴 자리를 비운 것은 막지 않는다"
    # 마지막 사람이 나가 방이 사라지면 그 코드의 기록도 버린다.
    records.forget_room("ABC234")
    assert records.reason("ABC234", PLAYER_ID) is None

    records.mark("ABC234", PLAYER_ID, blocked=True)
    clock.now += 599
    assert records.reason("ABC234", PLAYER_ID) == "kicked"
    clock.now += 1
    assert records.reason("ABC234", PLAYER_ID) == "removed"
    clock.now += 3_000
    assert records.reason("ABC234", PLAYER_ID) is None

    # 막는 시간은 기록보다 길 수 없다 — 기록이 사라지면 막을 근거도 없다.
    short = RemovedMembers(record_seconds=60, block_seconds=600, clock=clock)
    short.mark("ABC234", PLAYER_ID, blocked=True)
    clock.now += 60
    assert short.reason("ABC234", PLAYER_ID) is None
    with pytest.raises(ValueError):
        RemovedMembers(block_seconds=0)


def test_removed_member_records_expire_and_stay_bounded() -> None:
    clock = FakeClock()
    records = RemovedMembers(record_seconds=60, max_records=2, clock=clock)
    records.mark("ABC234", PLAYER_ID)
    assert records.was_removed("ABC234", PLAYER_ID)
    assert not records.was_removed("XYZ789", PLAYER_ID)
    clock.now += 61
    assert not records.was_removed("ABC234", PLAYER_ID)

    for index in range(3):
        records.mark("ABC234", UUID(int=index + 1))
    assert not records.was_removed("ABC234", UUID(int=1))
    assert records.was_removed("ABC234", UUID(int=3))
    records.forget("ABC234", UUID(int=3))
    assert not records.was_removed("ABC234", UUID(int=3))
    records.forget_room("ABC234")
    assert not records.was_removed("ABC234", UUID(int=2))
