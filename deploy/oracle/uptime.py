#!/usr/bin/env python3
"""공개 quiz-by-quiz 서비스가 살아 있는지 **읽기만 해서** 보는 점검 (`.github/workflows/uptime.yml`).

GitHub Actions가 15분마다 돌린다. 표준 라이브러리만 쓰고 Python 3.8 이상이면 어디서든 돈다::

    python3 deploy/oracle/uptime.py check --report "$RUNNER_TEMP/uptime-report.txt"
    python3 deploy/oracle/uptime.py notify --status 1 --report <파일> --run-url <실행 주소>

``check``는 둘을 본다.

- API의 공개 release gate ``GET /v1/release-readiness``: 200, ``status: ready``,
  ``contract: character-only-v1``, ``schemaVersion``이 main의 Pages workflow(``backend-ready``)가
  기다리는 판 이상, Pages origin(``https://perust.github.io``)을 들이는
  ``Access-Control-Allow-Origin``, 그리고 응답 시간이 한도(5초) 안.
- Pages ``https://perust.github.io/quiz-by-quiz/``: 200이고 ``quiz-api-base`` 메타가 점검한 API를
  가리킨다.

방·세션을 만들지 않는다 — GET 두 개뿐이다(deploy/oracle/smoke.py는 배포 때 사람이 돌리는 쓰기
점검이다). 실패한 점검은 몇 번 쉬었다 다시 해 본 뒤에야 실패로 본다(순간의 흔들림으로 경보가
깜빡이지 않게). 429는 ``Retry-After``를 따른다. 보고서는 몇 줄이고 공개 이슈에 그대로 실리므로
상태 코드·오류 코드·확인한 값만 적는다.

``notify``는 GitHub CLI(``gh``, ``GH_TOKEN``)로 «운영 경보» 이슈를 다룬다 — 실패하면 열린 경보 이슈에
덧붙이고 없을 때만 하나를 연다(열린 경보는 늘 하나다). 통과하면 열린 경보에 회복을 남기고 닫는다.
job을 실패로 끝내는 것(그래서 GitHub이 소유자에게 메일을 보내는 것)은 workflow의 마지막 step이다.
취소된 실행에서는 workflow가 ``notify``를 부르지 않는다(``!cancelled()``) — 끊긴 점검은 실패한 점검이
아니다. 그래서 ``--status``가 비었거나 «missing»이면 점검 step이 제 한도에 끊긴 것이고 실패로 다룬다.
"""

from __future__ import annotations

import argparse
import http.client
import json
import re
import ssl
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence
from urllib.parse import urlsplit

DEFAULT_API = "https://quiz-by-quiz-api.150.230.222.142.sslip.io"
DEFAULT_PAGES = "https://perust.github.io/quiz-by-quiz/"
PAGES_ORIGIN = "https://perust.github.io"
RELEASE_CONTRACT = "character-only-v1"
READINESS_PATH = "/v1/release-readiness"
API_BASE_META = "quiz-api-base"
ROOT = Path(__file__).resolve().parents[2]
PAGES_WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"
# 한 점검을 이만큼까지 해 본다. 사이에 BACKOFF_SECONDS만큼 쉰다(429면 Retry-After).
ATTEMPTS = 3
BACKOFF_SECONDS = (5.0, 15.0)
MAX_RETRY_AFTER_SECONDS = 60.0
TIMEOUT_SECONDS = 15.0
# 응답이 이보다 느리면 그 시도는 실패다(TLS 연결까지 센다).
SLOW_SECONDS = 5.0
MAX_BODY_BYTES = 1 << 20
USER_AGENT = "quiz-by-quiz-uptime/1"
ALERT_LABEL = "운영 경보"
ALERT_TITLE = "운영 경보: 공개 서비스 점검 실패"
_ERROR_CODE = re.compile(r"[a-z0-9][a-z0-9-]{0,47}")
_SAFE_TEXT = re.compile(r"[A-Za-z0-9 ._:/?=&%+@,()-]{1,100}")


class ConfigError(Exception):
    """점검이 기대할 값을 저장소에서 읽지 못했다."""


@dataclass
class Response:
    status: int
    headers: Dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    elapsed: float = 0.0


Fetch = Callable[[str, Dict[str, str], float], Response]


def http_fetch(url: str, headers: Dict[str, str], timeout: float) -> Response:
    """GET 하나. 넘겨주기(3xx)를 따라가지 않는다 — 점검할 주소가 200을 내야 한다."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("only https:// URLs are checked")
    connection = http.client.HTTPSConnection(
        parts.hostname,
        parts.port or 443,
        timeout=timeout,
        context=ssl.create_default_context(),
    )
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    started = time.monotonic()
    try:
        connection.request("GET", path, headers=headers)
        reply = connection.getresponse()
        body = reply.read(MAX_BODY_BYTES)
        elapsed = time.monotonic() - started
        names: Dict[str, str] = {}
        for name, value in reply.getheaders():
            key = name.strip().lower()
            names[key] = f"{names[key]}, {value.strip()}" if key in names else value.strip()
        return Response(reply.status, names, body, elapsed)
    finally:
        connection.close()


# ── 기대하는 판 ──────────────────────────────────────────────────────────────


def expected_schema_version(workflow_text: str) -> int:
    """Pages workflow의 ``backend-ready`` job이 기다리는 ``schemaVersion``.

    gate의 판을 여기 따로 적어 두면 migration마다 둘이 어긋난다. 그래서 main의 pages.yml에서 읽는다.
    """
    match = re.search(r"^  backend-ready:\n(.*?)(?=^  [A-Za-z0-9_-]+:|\Z)", workflow_text, re.M | re.S)
    if match is None:
        raise ConfigError("pages.yml has no backend-ready job")
    versions = set(re.findall(r'"schemaVersion"\s*:\s*(\d+)', match.group(1)))
    if len(versions) != 1:
        raise ConfigError("pages.yml backend-ready does not name exactly one schemaVersion")
    return int(versions.pop())


def read_expected_schema_version(path: Path = PAGES_WORKFLOW) -> int:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigError(f"cannot read {path.name}: {type(error).__name__}") from error
    return expected_schema_version(text)


# ── 한 번의 시도 ─────────────────────────────────────────────────────────────


@dataclass
class Attempt:
    ok: bool
    detail: str
    # 429일 때 다시 해 볼 때까지의 초
    retry_after: Optional[float] = None


def _show(value: object) -> str:
    """확인한 값을 한 줄에 들 만큼만, 안전한 글자일 때만 보인다(보고서는 공개 이슈에 실린다)."""
    if value is None or isinstance(value, bool):
        return json.dumps(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and _SAFE_TEXT.fullmatch(value):
        return json.dumps(value)
    return f"<{type(value).__name__}>"


def _status_text(reply: Response) -> str:
    try:
        value = json.loads(reply.body.decode("utf-8"))
    except ValueError:
        value = None
    detail = value.get("detail") if isinstance(value, dict) else None
    code = detail.get("code") if isinstance(detail, dict) else None
    if isinstance(code, str) and _ERROR_CODE.fullmatch(code):
        return f"HTTP {reply.status} {code}"
    return f"HTTP {reply.status}"


def _retry_after(reply: Response) -> float:
    raw = reply.headers.get("retry-after", "").strip()
    seconds = float(raw) if raw.isascii() and raw.isdigit() else 1.0
    return max(1.0, min(seconds, MAX_RETRY_AFTER_SECONDS))


def _slow(reply: Response, slow_seconds: float) -> Optional[str]:
    if reply.elapsed > slow_seconds:
        return f"slow: {reply.elapsed:.2f}s > {slow_seconds:.1f}s"
    return None


def readiness_attempt(
    fetch: Fetch,
    api: str,
    expected_version: int,
    *,
    slow_seconds: float = SLOW_SECONDS,
) -> Attempt:
    reply = fetch(
        api.rstrip("/") + READINESS_PATH,
        {"Origin": PAGES_ORIGIN, "Accept": "application/json", "User-Agent": USER_AGENT},
        TIMEOUT_SECONDS,
    )
    if reply.status == 429:
        return Attempt(False, _status_text(reply), _retry_after(reply))
    if reply.status != 200:
        return Attempt(False, _status_text(reply))
    try:
        payload = json.loads(reply.body.decode("utf-8"))
    except ValueError:
        return Attempt(False, "HTTP 200 body is not JSON")
    if not isinstance(payload, dict):
        return Attempt(False, "HTTP 200 body is not a JSON object")
    problems: List[str] = []
    if payload.get("status") != "ready":
        problems.append(f"status={_show(payload.get('status'))} (want \"ready\")")
    if payload.get("contract") != RELEASE_CONTRACT:
        problems.append(f"contract={_show(payload.get('contract'))} (want \"{RELEASE_CONTRACT}\")")
    version = payload.get("schemaVersion")
    if type(version) is not int or version < expected_version:
        problems.append(f"schemaVersion={_show(version)} (want >= {expected_version})")
    origin = reply.headers.get("access-control-allow-origin")
    if origin != PAGES_ORIGIN:
        problems.append(f"Access-Control-Allow-Origin={_show(origin)} (want \"{PAGES_ORIGIN}\")")
    slow = _slow(reply, slow_seconds)
    if slow:
        problems.append(slow)
    if problems:
        return Attempt(False, "HTTP 200 " + "; ".join(problems))
    return Attempt(
        True,
        f"HTTP 200 ready {RELEASE_CONTRACT} schemaVersion {version} "
        f"(want >= {expected_version}), CORS ok, {reply.elapsed:.2f}s",
    )


class _MetaFinder(HTMLParser):
    def __init__(self, name: str) -> None:
        super().__init__()
        self._name = name
        self.content: Optional[str] = None

    def handle_starttag(self, tag: str, attrs: List[tuple]) -> None:
        if tag != "meta" or self.content is not None:
            return
        values = dict(attrs)
        if values.get("name") == self._name:
            self.content = (values.get("content") or "").strip()


def find_meta(html: str, name: str = API_BASE_META) -> Optional[str]:
    finder = _MetaFinder(name)
    finder.feed(html)
    finder.close()
    return finder.content


def pages_attempt(
    fetch: Fetch,
    pages: str,
    api: str,
    *,
    slow_seconds: float = SLOW_SECONDS,
) -> Attempt:
    reply = fetch(pages, {"Accept": "text/html", "User-Agent": USER_AGENT}, TIMEOUT_SECONDS)
    if reply.status == 429:
        return Attempt(False, f"HTTP {reply.status}", _retry_after(reply))
    if reply.status != 200:
        location = reply.headers.get("location")
        suffix = f" -> {_show(location)}" if location else ""
        return Attempt(False, f"HTTP {reply.status}{suffix}")
    meta = find_meta(reply.body.decode("utf-8", "replace"))
    if not meta:
        return Attempt(False, f"HTTP 200 but the {API_BASE_META} meta is missing")
    problems: List[str] = []
    if meta.rstrip("/") != api.rstrip("/"):
        problems.append(f"{API_BASE_META}={_show(meta)} (want {_show(api.rstrip('/'))})")
    slow = _slow(reply, slow_seconds)
    if slow:
        problems.append(slow)
    if problems:
        return Attempt(False, "HTTP 200 " + "; ".join(problems))
    return Attempt(True, f"HTTP 200, {API_BASE_META} {_show(meta)}, {reply.elapsed:.2f}s")


# ── 다시 해 보기 ─────────────────────────────────────────────────────────────


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str
    attempts: int


def _describe(error: BaseException) -> str:
    # 예외 메시지에는 주소·인증서 내용이 섞일 수 있어 클래스 이름만 적는다
    return f"{type(error).__name__}"


def run_check(
    name: str,
    attempt: Callable[[], Attempt],
    *,
    attempts: int = ATTEMPTS,
    backoff: Sequence[float] = BACKOFF_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
    note: Callable[[str], None] = lambda line: print(line, file=sys.stderr, flush=True),
) -> CheckResult:
    last = Attempt(False, "not attempted")
    for number in range(1, attempts + 1):
        try:
            last = attempt()
        except Exception as error:  # noqa: BLE001 - 연결 실패는 무엇이든 그 시도의 실패다
            last = Attempt(False, _describe(error))
        if last.ok:
            return CheckResult(name, True, last.detail, number)
        if number < attempts:
            if last.retry_after is not None:
                wait = min(last.retry_after, MAX_RETRY_AFTER_SECONDS)
            else:
                wait = backoff[min(number - 1, len(backoff) - 1)] if backoff else 0.0
            note(f"retry {name} in {wait:.0f}s ({number}/{attempts}): {last.detail}")
            sleep(wait)
    suffix = f" (after {attempts} attempts)" if attempts > 1 else ""
    return CheckResult(name, False, last.detail + suffix, attempts)


# ── 점검 ─────────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check(
    *,
    fetch: Fetch = http_fetch,
    api: str = DEFAULT_API,
    pages: str = DEFAULT_PAGES,
    workflow: Path = PAGES_WORKFLOW,
    sleep: Callable[[float], None] = time.sleep,
    note: Callable[[str], None] = lambda line: print(line, file=sys.stderr, flush=True),
    now: Callable[[], str] = _now,
    slow_seconds: float = SLOW_SECONDS,
) -> List[str]:
    """보고서의 줄들. 마지막 줄이 판정이다(``verdict: ok`` 또는 ``verdict: FAIL``)."""
    lines = [
        f"quiz-by-quiz uptime check {now()}",
        f"api: {api.rstrip('/')}",
        f"pages: {pages}",
    ]
    results: List[CheckResult] = []
    try:
        expected = read_expected_schema_version(workflow)
    except ConfigError as error:
        results.append(CheckResult("config", False, str(error), 0))
    else:
        lines.append(f"expected schemaVersion >= {expected} (pages.yml backend-ready)")
        results.append(
            run_check(
                "readiness",
                lambda: readiness_attempt(fetch, api, expected, slow_seconds=slow_seconds),
                sleep=sleep,
                note=note,
            )
        )
    results.append(
        run_check(
            "pages",
            lambda: pages_attempt(fetch, pages, api, slow_seconds=slow_seconds),
            sleep=sleep,
            note=note,
        )
    )
    for result in results:
        lines.append(f"{'ok' if result.ok else 'FAIL'} {result.name}: {result.detail}")
    lines.append("verdict: " + ("ok" if all(result.ok for result in results) else "FAIL"))
    return lines


# ── 경보 이슈 ────────────────────────────────────────────────────────────────


Runner = Callable[[List[str], Optional[str]], str]


def gh_runner(args: List[str], stdin: Optional[str]) -> str:
    completed = subprocess.run(  # noqa: S603 - fixed executable, arguments built here
        ["gh", *args],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"gh {args[0]} {args[1]} failed with exit {completed.returncode}")
    return completed.stdout


def _fence(report: str) -> str:
    # 보고서가 코드 블록을 닫지 못하게 한다
    return "```text\n" + report.replace("```", "'''").rstrip("\n") + "\n```"


def alert_body(report: str, run_url: str) -> str:
    return "\n".join(
        [
            "공개 서비스 점검이 실패했어요. 이 경보가 열려 있는 동안에는 새 이슈를 만들지 않고 "
            "여기에 덧붙여요.",
            "",
            _fence(report),
            "",
            f"- 실행 기록: {run_url}",
            "- 계획된 배포로 API가 잠시 503 `migration-required`를 내는 중이라면, 그동안 "
            "`gh workflow disable uptime.yml`로 점검을 꺼 두고 끝나면 "
            "`gh workflow enable uptime.yml`로 다시 켜 주세요.",
            "- 다음 점검이 통과하면 이 이슈에 회복을 남기고 닫아요.",
            "- 읽는 법: `deploy/oracle/README.md`의 «Uptime monitor».",
        ]
    )


def still_failing_body(report: str, run_url: str) -> str:
    return "\n".join(["점검이 아직 실패해요.", "", _fence(report), "", f"- 실행 기록: {run_url}"])


def recovered_body(report: str, run_url: str) -> str:
    return "\n".join(
        [
            "서비스가 회복됐어요. 이번 점검이 모두 통과해 이 경보를 닫아요.",
            "",
            _fence(report),
            "",
            f"- 실행 기록: {run_url}",
        ]
    )


def open_alert_numbers(run: Runner) -> List[int]:
    output = run(
        [
            "issue",
            "list",
            "--state",
            "open",
            "--label",
            ALERT_LABEL,
            "--json",
            "number",
            "--limit",
            "100",
        ],
        None,
    )
    items = json.loads(output or "[]")
    numbers = sorted(
        item["number"]
        for item in items
        if isinstance(item, dict) and type(item.get("number")) is int
    )
    return numbers


def notify(*, failed: bool, report: str, run_url: str, run: Runner = gh_runner) -> str:
    """열린 경보 이슈를 하나로 지킨다. 무엇을 했는지 한 줄로 돌려준다."""
    numbers = open_alert_numbers(run)
    if not failed:
        for number in numbers:
            run(["issue", "comment", str(number), "--body-file", "-"], recovered_body(report, run_url))
            run(["issue", "close", str(number)], None)
        return f"closed {len(numbers)} alert issue(s)" if numbers else "no open alert"
    if numbers:
        # 열린 경보가 여럿이면(손으로 연 것) 가장 오래된 것 하나에만 덧붙인다
        run(
            ["issue", "comment", str(numbers[0]), "--body-file", "-"],
            still_failing_body(report, run_url),
        )
        return f"commented on alert #{numbers[0]}"
    run(
        ["issue", "create", "--title", ALERT_TITLE, "--label", ALERT_LABEL, "--body-file", "-"],
        alert_body(report, run_url),
    )
    return "opened a new alert issue"


# ── 명령 ─────────────────────────────────────────────────────────────────────


def _write_report(path: Optional[str], lines: List[str]) -> None:
    text = "\n".join(lines) + "\n"
    print(text, end="", flush=True)
    if path:
        Path(path).write_text(text, encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only uptime check for quiz-by-quiz")
    commands = parser.add_subparsers(dest="command", required=True)
    check_parser = commands.add_parser("check", help="check the public API and Pages")
    check_parser.add_argument("--api", default=DEFAULT_API)
    check_parser.add_argument("--pages", default=DEFAULT_PAGES)
    check_parser.add_argument("--report", help="also write the report to this file")
    notify_parser = commands.add_parser("notify", help="open, update or close the alert issue")
    notify_parser.add_argument("--status", required=True, help="exit status of check")
    notify_parser.add_argument("--report", required=True)
    notify_parser.add_argument("--run-url", required=True)
    args = parser.parse_args(argv)

    if args.command == "check":
        for url in (args.api, args.pages):
            if urlsplit(url).scheme != "https":
                parser.error("--api and --pages must be https:// URLs")
        try:
            lines = check(fetch=http_fetch, sleep=time.sleep, api=args.api, pages=args.pages)
        except Exception as error:  # noqa: BLE001 - 점검기의 고장도 보고서로 남긴다
            lines = [
                f"quiz-by-quiz uptime check {_now()}",
                f"FAIL internal: {_describe(error)}",
                "verdict: FAIL",
            ]
        _write_report(args.report, lines)
        return 0 if lines[-1] == "verdict: ok" else 1

    try:
        report = Path(args.report).read_text(encoding="utf-8")
    except OSError:
        report = "(점검 보고서가 없어요 — 실행 기록을 확인해 주세요)\n"
    # 점검의 종료 코드가 0이 아니면(비었거나 «missing»이어도) 실패다
    failed = args.status.strip() != "0"
    print(notify(failed=failed, report=report, run_url=args.run_url, run=gh_runner), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
