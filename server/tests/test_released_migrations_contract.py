"""나간 migration의 글은 바뀌지 않는다.

migrator(app.migrate)는 ledger의 번호만 보고 글의 checksum을 남기지 않는다. 이미 돈 번호의 글을
제자리에서 고치면 그 번호를 가진 DB에는 고친 글이 영영 닿지 않고, 같은 번호가 DB마다 다른
스키마를 뜻하게 된다(한때 혼자 판의 표를 #108의 012에 접어 넣었던 일, deploy/oracle/README.md
«Fail-closed staging order»). 그래서 그 PR이 낸 글을 그대로 잠근다:

- 001–010: 운영 DB에서 돈다(main)
- 011: #106 — migration 011 → API → Pages
- 012: #108 — migration 012 → API → Pages. 이 PR(#109)이 012를 고치지 않고 013을 더한 까닭이다

바꿀 것이 생기면 다음 번호의 migration을 더한다. 그 번호를 낸 PR이 배포 전에 제 글을 고쳤으면
그 PR에서 여기 값을 함께 고친다 — 그 위에 쌓인 브랜치에서 고치지 않는다. 013은 아직 소유자 결정을
기다리는 판이라 잠그지 않는다. 013이 나가면 여기에 한 줄을 더한다.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from app.migrate import discover_migrations

MIGRATIONS = Path(__file__).parents[1] / "migrations"

# migrator가 실행하는 글(`read_text(encoding="utf-8")`)의 sha256. 그 글은 줄 끝이 LF로 읽히므로
# CRLF로 받아 온 checkout에서도 값이 같다
RELEASED_MIGRATION_SHA256 = {
    1: "0a7a6264ed3acaa61a073154146471b0f0414c040b0eac584a04445ba3a92b29",
    2: "d11db674efe9b143490415cdd3834e20ca0f7498ec2945fbeb646e68a69fe18d",
    3: "d044b2f8355c4d3b460e50cde8b38d97da27bca7b84b528d23f3e223c9e04043",
    4: "21c855c4ee2de6a4e97510e95b83a74e4000101dddf520efeb4136dff7e30529",
    5: "78222123881d139c47286dac80262ad653a07d9309b6e7670922b6e30df5457d",
    6: "2d83a43dd22f82947105aedd3510b760cd17f183d1525f1273a8767d1b06f716",
    7: "4a4d9025a5884a10f7c0ac451be3bca326cd124d0d0d622b0652ce0668719666",
    8: "5265df59c2ddb036d7b9a3077cfbb4cfaf5400ca5ca77043ce2d44bf54677a41",
    9: "6e4e0e929f21843809f1f1832c80ae616cdaf7424ef6c00445f69624e3e062f4",
    10: "07d480ec60e54eb15d555024206fc75e160ee0fc27f80be2f69a357cd4be55e8",
    11: "b17143c33ca7fa4bc99d31244d182d08cdb32392f4e047362b79b48d93aa4604",
    12: "87feefe493aa03450913e118571b82713505e48f1217db959490f16bbf944a60",
}


def migration_sha256(path: Path) -> str:
    """migrator가 그 파일에서 실행하는 글의 sha256."""
    return hashlib.sha256(path.read_text(encoding="utf-8").encode("utf-8")).hexdigest()


def test_every_released_migration_keeps_the_exact_text_it_shipped_with() -> None:
    migrations = {
        migration.version: migration.path for migration in discover_migrations(MIGRATIONS)
    }

    assert set(RELEASED_MIGRATION_SHA256) <= set(migrations)
    changed = [
        migrations[version].name
        for version, digest in sorted(RELEASED_MIGRATION_SHA256.items())
        if migration_sha256(migrations[version]) != digest
    ]
    # 이미 돈(또는 제 PR로 나갈) 번호를 고쳤다 — 고치는 대신 다음 번호의 migration을 더한다
    assert changed == []


def test_the_pin_reads_what_the_migrator_executes_whatever_the_line_endings(tmp_path) -> None:
    released = MIGRATIONS / "012_online_rankings.sql"
    crlf = tmp_path / "012_online_rankings.sql"
    crlf.write_text(released.read_text(encoding="utf-8"), encoding="utf-8", newline="\r\n")

    assert b"\r\n" in crlf.read_bytes()
    assert migration_sha256(crlf) == migration_sha256(released) == RELEASED_MIGRATION_SHA256[12]
    # 한 글자라도 바꾸면 값이 달라진다
    crlf.write_text(released.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    assert migration_sha256(crlf) != RELEASED_MIGRATION_SHA256[12]
