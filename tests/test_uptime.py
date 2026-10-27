"""deploy/oracle/uptime.py — 15분마다 공개 API와 Pages를 읽기만 해서 보는 점검.

가짜 transport가 API·Pages 흉내를 낸다. 순간의 실패는 다시 해 보고서야 실패로 보고, 429는
Retry-After를 따르며, 기대하는 schemaVersion은 Pages workflow에서 읽는다. 경보 이슈는 늘 하나다.
"""

import ast
import contextlib
import importlib.util
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
UPTIME_PATH = ROOT / "deploy" / "oracle" / "uptime.py"


def load_uptime():
    spec = importlib.util.spec_from_file_location("oracle_uptime", UPTIME_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


uptime = load_uptime()
API = uptime.DEFAULT_API
PAGES = uptime.DEFAULT_PAGES
READINESS_URL = API + "/v1/release-readiness"
READY = {"status": "ready", "contract": "character-only-v1", "schemaVersion": 13}
PAGE = (
    '<!doctype html><html><head><meta charset="utf-8">'
    f'<meta name="quiz-api-base" content="{API}"></head><body></body></html>'
)


def readiness(payload=None, *, status=200, origin=uptime.PAGES_ORIGIN, elapsed=0.2, headers=None):
    names = dict(headers or {})
    if origin is not None:
        names["access-control-allow-origin"] = origin
    body = json.dumps(READY if payload is None else payload).encode()
    return uptime.Response(status, names, body, elapsed)


def error_reply(status, code, headers=None):
    body = json.dumps({"detail": {"code": code, "message": "…"}}).encode()
    return uptime.Response(status, dict(headers or {}), body, 0.1)


def page(html=PAGE, *, status=200, elapsed=0.1, headers=None):
    return uptime.Response(status, dict(headers or {}), html.encode(), elapsed)


class FakeTransport:
    """URL마다 응답(또는 던질 예외)을 차례로 낸다. 마지막 것은 되풀이한다."""

    def __init__(self, routes):
        self.routes = {url: list(replies) for url, replies in routes.items()}
        self.calls = []

    def __call__(self, url, headers, timeout):
        self.calls.append((url, dict(headers), timeout))
        replies = self.routes[url]
        reply = replies.pop(0) if len(replies) > 1 else replies[0]
        if isinstance(reply, BaseException):
            raise reply
        return reply


class Recorder:
    def __init__(self):
        self.sleeps = []
        self.notes = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)

    def note(self, line):
        self.notes.append(line)


def run_check(transport, recorder=None, workflow=None, **kwargs):
    recorder = recorder or Recorder()
    lines = uptime.check(
        fetch=transport,
        workflow=workflow or uptime.PAGES_WORKFLOW,
        sleep=recorder.sleep,
        note=recorder.note,
        now=lambda: "2026-10-27T03:15:00Z",
        **kwargs,
    )
    return lines, recorder


def line_for(lines, name):
    return next(line for line in lines if re.match(rf"^(ok|FAIL) {name}: ", line))


class ExpectedVersionTest(unittest.TestCase):
    def test_reads_the_version_the_pages_gate_waits_for(self):
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        gate = re.search(r'"schemaVersion":\s*(\d+)', workflow.split("\n  backend-ready:", 1)[1])
        self.assertIsNotNone(gate)
        self.assertEqual(uptime.read_expected_schema_version(), int(gate.group(1)))
        self.assertEqual(uptime.expected_schema_version(workflow), int(gate.group(1)))

    def test_only_the_backend_ready_job_counts(self):
        workflow = (
            "jobs:\n"
            "  verify:\n"
            "    steps:\n"
            '      - run: echo \'"schemaVersion": 3\'\n'
            "  backend-ready:\n"
            "    steps:\n"
            "      - run: |\n"
            "          jq -e '. == {\n"
            '            "schemaVersion": 12\n'
            "          }'\n"
            "  deploy:\n"
            "    steps:\n"
            '      - run: echo \'"schemaVersion": 99\'\n'
        )
        self.assertEqual(uptime.expected_schema_version(workflow), 12)

    def test_a_missing_or_ambiguous_gate_is_a_config_error(self):
        with self.assertRaises(uptime.ConfigError):
            uptime.expected_schema_version("jobs:\n  verify:\n    steps: []\n")
        with self.assertRaises(uptime.ConfigError):
            uptime.expected_schema_version("jobs:\n  backend-ready:\n    steps: []\n")
        with self.assertRaises(uptime.ConfigError):
            uptime.expected_schema_version(
                'jobs:\n  backend-ready:\n    a: \'"schemaVersion": 11\'\n'
                '    b: \'"schemaVersion": 12\'\n'
            )

    def test_an_unreadable_workflow_fails_the_check_without_calling_the_api(self):
        transport = FakeTransport({PAGES: [page()]})
        lines, _ = run_check(transport, workflow=ROOT / "missing" / "pages.yml")
        self.assertEqual(lines[-1], "verdict: FAIL")
        self.assertTrue(line_for(lines, "config").startswith("FAIL config: cannot read pages.yml"))
        self.assertEqual([call[0] for call in transport.calls], [PAGES])


class CheckTest(unittest.TestCase):
    def test_a_healthy_service_passes_in_one_attempt_each(self):
        transport = FakeTransport({READINESS_URL: [readiness()], PAGES: [page()]})
        lines, recorder = run_check(transport)

        self.assertEqual(lines[0], "quiz-by-quiz uptime check 2026-10-27T03:15:00Z")
        self.assertIn("expected schemaVersion >= 13 (pages.yml backend-ready)", lines)
        self.assertEqual(
            line_for(lines, "readiness"),
            "ok readiness: HTTP 200 ready character-only-v1 schemaVersion 13 "
            "(want >= 13), CORS ok, 0.20s",
        )
        self.assertEqual(
            line_for(lines, "pages"),
            f'ok pages: HTTP 200, quiz-api-base "{API}", 0.10s',
        )
        self.assertEqual(lines[-1], "verdict: ok")
        self.assertEqual(recorder.sleeps, [])
        # 읽기만 한다: GET 두 개. readiness에는 Pages origin을 싣는다
        self.assertEqual([call[0] for call in transport.calls], [READINESS_URL, PAGES])
        self.assertEqual(transport.calls[0][1]["Origin"], "https://perust.github.io")

    def test_a_newer_schema_version_still_passes(self):
        newer = dict(READY, schemaVersion=14)
        transport = FakeTransport({READINESS_URL: [readiness(newer)], PAGES: [page()]})
        lines, _ = run_check(transport)
        self.assertEqual(lines[-1], "verdict: ok")

    def test_a_transient_failure_is_retried_with_backoff_before_it_counts(self):
        transport = FakeTransport(
            {
                READINESS_URL: [TimeoutError("timed out"), error_reply(502, "bad"), readiness()],
                PAGES: [page()],
            }
        )
        lines, recorder = run_check(transport)
        self.assertEqual(lines[-1], "verdict: ok")
        self.assertEqual(recorder.sleeps, [5.0, 15.0])
        self.assertEqual(len(recorder.notes), 2)
        self.assertIn("retry readiness in 5s (1/3): TimeoutError", recorder.notes[0])

    def test_a_persistent_failure_fails_after_every_attempt(self):
        transport = FakeTransport(
            {READINESS_URL: [error_reply(503, "migration-required")], PAGES: [page()]}
        )
        lines, recorder = run_check(transport)
        self.assertEqual(
            line_for(lines, "readiness"),
            "FAIL readiness: HTTP 503 migration-required (after 3 attempts)",
        )
        self.assertEqual(line_for(lines, "pages")[:8], "ok pages")
        self.assertEqual(lines[-1], "verdict: FAIL")
        self.assertEqual(recorder.sleeps, [5.0, 15.0])
        self.assertEqual(sum(call[0] == READINESS_URL for call in transport.calls), 3)

    def test_rate_limiting_honours_retry_after(self):
        transport = FakeTransport(
            {
                READINESS_URL: [
                    error_reply(429, "rate-limited", {"retry-after": "7"}),
                    error_reply(429, "rate-limited", {"retry-after": "9000"}),
                    readiness(),
                ],
                PAGES: [page()],
            }
        )
        lines, recorder = run_check(transport)
        self.assertEqual(lines[-1], "verdict: ok")
        # Retry-After를 따르되 한 번에 60초까지만 기다린다
        self.assertEqual(recorder.sleeps, [7.0, 60.0])

    def test_a_missing_retry_after_waits_one_second(self):
        transport = FakeTransport(
            {
                READINESS_URL: [error_reply(429, "rate-limited"), readiness()],
                PAGES: [page()],
            }
        )
        _, recorder = run_check(transport)
        self.assertEqual(recorder.sleeps, [1.0])

    def test_cors_must_allow_the_pages_origin(self):
        for origin in (None, "*", "https://evil.example"):
            with self.subTest(origin=origin):
                transport = FakeTransport(
                    {READINESS_URL: [readiness(origin=origin)], PAGES: [page()]}
                )
                lines, _ = run_check(transport)
                self.assertIn("Access-Control-Allow-Origin=", line_for(lines, "readiness"))
                self.assertTrue(line_for(lines, "readiness").startswith("FAIL"))
                self.assertEqual(lines[-1], "verdict: FAIL")

    def test_the_gate_payload_must_be_ready_for_this_contract_and_version(self):
        cases = {
            "status": dict(READY, status="starting"),
            "contract": dict(READY, contract="legacy"),
            "older": dict(READY, schemaVersion=12),
            "bool": dict(READY, schemaVersion=True),
            "text": dict(READY, schemaVersion="13"),
        }
        for name, payload in cases.items():
            with self.subTest(case=name):
                transport = FakeTransport({READINESS_URL: [readiness(payload)], PAGES: [page()]})
                lines, _ = run_check(transport)
                self.assertTrue(line_for(lines, "readiness").startswith("FAIL readiness: HTTP 200"))
        transport = FakeTransport(
            {READINESS_URL: [readiness(dict(READY, schemaVersion=12))], PAGES: [page()]}
        )
        lines, _ = run_check(transport)
        self.assertIn("schemaVersion=12 (want >= 13)", line_for(lines, "readiness"))

    def test_a_slow_response_counts_as_a_failed_attempt(self):
        transport = FakeTransport(
            {READINESS_URL: [readiness(elapsed=7.5)], PAGES: [page(elapsed=0.3)]}
        )
        lines, recorder = run_check(transport)
        self.assertIn("slow: 7.50s > 5.0s", line_for(lines, "readiness"))
        self.assertEqual(lines[-1], "verdict: FAIL")
        self.assertEqual(recorder.sleeps, [5.0, 15.0])

        transport = FakeTransport(
            {READINESS_URL: [readiness(elapsed=7.5), readiness(elapsed=0.4)], PAGES: [page()]}
        )
        lines, _ = run_check(transport)
        self.assertEqual(lines[-1], "verdict: ok")

    def test_pages_must_serve_the_api_base_meta(self):
        transport = FakeTransport(
            {READINESS_URL: [readiness()], PAGES: [page("<html><head></head></html>")]}
        )
        lines, _ = run_check(transport)
        self.assertEqual(
            line_for(lines, "pages"),
            "FAIL pages: HTTP 200 but the quiz-api-base meta is missing (after 3 attempts)",
        )

    def test_pages_meta_may_come_in_any_attribute_order_but_must_name_this_api(self):
        reordered = f'<meta content="{API}/" name="quiz-api-base">'
        transport = FakeTransport({READINESS_URL: [readiness()], PAGES: [page(reordered)]})
        lines, _ = run_check(transport)
        self.assertEqual(lines[-1], "verdict: ok")

        elsewhere = '<meta name="quiz-api-base" content="https://other.example">'
        transport = FakeTransport({READINESS_URL: [readiness()], PAGES: [page(elsewhere)]})
        lines, _ = run_check(transport)
        self.assertIn('quiz-api-base="https://other.example"', line_for(lines, "pages"))
        self.assertEqual(lines[-1], "verdict: FAIL")

    def test_pages_must_answer_200_itself(self):
        transport = FakeTransport(
            {
                READINESS_URL: [readiness()],
                PAGES: [page(status=301, headers={"location": "https://elsewhere.example/"})],
            }
        )
        lines, _ = run_check(transport)
        self.assertEqual(
            line_for(lines, "pages"),
            'FAIL pages: HTTP 301 -> "https://elsewhere.example/" (after 3 attempts)',
        )

    def test_the_report_never_echoes_unsafe_server_text(self):
        hostile = dict(READY, status="<script>```\nrm -rf", contract="x" * 300)
        transport = FakeTransport(
            {
                READINESS_URL: [readiness(hostile, origin="`evil`")],
                PAGES: [page('<meta name="quiz-api-base" content="```\n# injected">')],
            }
        )
        lines, _ = run_check(transport)
        report = "\n".join(lines)
        self.assertNotIn("<script>", report)
        self.assertNotIn("```", report)
        self.assertNotIn("injected", report)
        self.assertNotIn("x" * 300, report)
        self.assertNotIn("evil", report)


class NotifyTest(unittest.TestCase):
    REPORT = (
        "quiz-by-quiz uptime check 2026-10-27T03:15:00Z\n"
        "FAIL readiness: HTTP 503\n"
        "verdict: FAIL\n"
    )
    RUN_URL = "https://github.com/perust/quiz-by-quiz/actions/runs/1"

    def gh(self, open_numbers):
        calls = []

        def run(args, stdin):
            calls.append((args, stdin))
            if args[:2] == ["issue", "list"]:
                return json.dumps([{"number": number} for number in open_numbers])
            return ""

        return run, calls

    def test_a_failure_with_no_open_alert_opens_exactly_one_issue(self):
        run, calls = self.gh([])
        result = uptime.notify(failed=True, report=self.REPORT, run_url=self.RUN_URL, run=run)
        self.assertEqual(result, "opened a new alert issue")
        self.assertEqual(len(calls), 2)
        listed, created = calls
        self.assertEqual(
            listed[0],
            ["issue", "list", "--state", "open", "--label", "운영 경보", "--json", "number",
             "--limit", "100"],
        )
        self.assertEqual(created[0][:2], ["issue", "create"])
        self.assertIn("--label", created[0])
        self.assertEqual(created[0][created[0].index("--label") + 1], "운영 경보")
        self.assertIn("FAIL readiness: HTTP 503", created[1])
        self.assertIn(self.RUN_URL, created[1])
        self.assertIn("gh workflow disable uptime.yml", created[1])

    def test_a_failure_with_an_open_alert_only_comments_on_it(self):
        run, calls = self.gh([42])
        result = uptime.notify(failed=True, report=self.REPORT, run_url=self.RUN_URL, run=run)
        self.assertEqual(result, "commented on alert #42")
        self.assertEqual([call[0][:3] for call in calls[1:]], [["issue", "comment", "42"]])
        self.assertFalse(any(call[0][:2] == ["issue", "create"] for call in calls))
        self.assertIn("FAIL readiness: HTTP 503", calls[1][1])

    def test_several_open_alerts_never_grow_and_the_oldest_gets_the_comment(self):
        run, calls = self.gh([57, 42])
        uptime.notify(failed=True, report=self.REPORT, run_url=self.RUN_URL, run=run)
        self.assertEqual([call[0][:3] for call in calls[1:]], [["issue", "comment", "42"]])

    def test_recovery_comments_and_closes_every_open_alert(self):
        run, calls = self.gh([42, 57])
        result = uptime.notify(failed=False, report="verdict: ok\n", run_url=self.RUN_URL, run=run)
        self.assertEqual(result, "closed 2 alert issue(s)")
        self.assertEqual(
            [call[0][:3] for call in calls[1:]],
            [
                ["issue", "comment", "42"],
                ["issue", "close", "42"],
                ["issue", "comment", "57"],
                ["issue", "close", "57"],
            ],
        )
        self.assertIn("회복", calls[1][1])

    def test_success_with_no_open_alert_does_nothing(self):
        run, calls = self.gh([])
        result = uptime.notify(failed=False, report="verdict: ok\n", run_url=self.RUN_URL, run=run)
        self.assertEqual(result, "no open alert")
        self.assertEqual(len(calls), 1)

    def test_the_report_cannot_close_the_code_fence(self):
        body = uptime.alert_body("```\n# heading\n", self.RUN_URL)
        self.assertEqual(body.count("```"), 2)

    def notify_cli(self, status, report_text, open_numbers=()):
        run, calls = self.gh(list(open_numbers))
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.txt"
            if report_text is not None:
                report.write_text(report_text, encoding="utf-8")
            with mock.patch.object(uptime, "gh_runner", run), contextlib.redirect_stdout(
                io.StringIO()
            ) as printed:
                code = uptime.main(
                    ["notify", "--status", status, "--report", str(report), "--run-url", "u"]
                )
        return code, calls, printed.getvalue()

    def test_notify_treats_a_missing_status_or_report_as_a_failure(self):
        for status in ("missing", "", "1", "2"):
            with self.subTest(status=status):
                code, calls, printed = self.notify_cli(status, None)
                self.assertEqual(code, 0)
                self.assertEqual(printed.strip(), "opened a new alert issue")
                self.assertEqual(calls[-1][0][:2], ["issue", "create"])
                self.assertIn("점검 보고서가 없어요", calls[-1][1])

    def test_notify_with_status_zero_recovers(self):
        code, calls, printed = self.notify_cli("0", "verdict: ok\n", open_numbers=[7])
        self.assertEqual(code, 0)
        self.assertEqual(printed.strip(), "closed 1 alert issue(s)")
        self.assertEqual(calls[-1][0], ["issue", "close", "7"])

    def test_a_failing_gh_call_fails_the_notify_step(self):
        def run(args, stdin):
            raise RuntimeError("gh issue list failed with exit 1")

        with self.assertRaises(RuntimeError):
            uptime.notify(failed=True, report=self.REPORT, run_url=self.RUN_URL, run=run)


class ContractTest(unittest.TestCase):
    def test_defaults_match_the_published_pages_meta(self):
        index = (ROOT / "index.html").read_text(encoding="utf-8")
        self.assertEqual(uptime.find_meta(index), uptime.DEFAULT_API)
        self.assertEqual(uptime.DEFAULT_PAGES, "https://perust.github.io/quiz-by-quiz/")

    def test_the_script_is_standard_library_only_and_read_only(self):
        source = UPTIME_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        imported.discard("__future__")
        self.assertTrue(imported <= set(sys.stdlib_module_names), imported)
        # 방·세션을 만들지 않는다. 보내는 HTTP 메서드는 GET뿐이다
        methods = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant)
            and node.value in {"POST", "PUT", "PATCH", "DELETE", "GET"}
        }
        self.assertEqual(methods, {"GET"})
        for path in ("/v1/session", "/v1/rooms", "/events", "ws-ticket"):
            self.assertNotIn(path, source)

    def test_the_longest_designed_check_ends_inside_the_probe_step_limit(self):
        # 취소된 실행(job 한도 포함)은 경보를 건드리지 않으므로(uptime.yml의 !cancelled()), 멈춘 점검은
        # 점검 step의 제 한도에 먼저 걸려 실패로 알려야 한다. 그러려면 끝까지 다시 해 보는 점검이
        # 그 한도 안에 끝나야 한다 — 모든 요청이 429(Retry-After 상한)이고 요청마다 연결과 응답을
        # 저마다 TIMEOUT_SECONDS까지 기다렸다고 치고 센다.
        transport = FakeTransport(
            {
                READINESS_URL: [error_reply(429, "rate-limited", {"retry-after": "9000"})],
                PAGES: [page(status=429, headers={"retry-after": "9000"})],
            }
        )
        lines, recorder = run_check(transport)
        self.assertEqual(lines[-1], "verdict: FAIL")
        longest = len(transport.calls) * 2 * uptime.TIMEOUT_SECONDS + sum(recorder.sleeps)
        self.assertEqual(longest, 420.0)
        self.assertEqual(
            max(recorder.sleeps), max(uptime.MAX_RETRY_AFTER_SECONDS, *uptime.BACKOFF_SECONDS)
        )

        workflow = (ROOT / ".github" / "workflows" / "uptime.yml").read_text(encoding="utf-8")
        probe = workflow.split("- name: 공개 API·Pages 점검", 1)[1].split("\n      - ", 1)[0]
        step_limit = int(re.search(r"\n {8}timeout-minutes: (\d+)\n", probe).group(1)) * 60
        job_limit = int(re.search(r"\n {4}timeout-minutes: (\d+)\n", workflow).group(1)) * 60
        # 넉넉함 1분, 그 뒤 경보 step(gh 호출) 몫 1분
        self.assertLessEqual(longest + 60, step_limit)
        self.assertLessEqual(step_limit + 60, job_limit)

    def test_the_deploy_guide_names_the_scheduling_caveats(self):
        guide = (ROOT / "deploy" / "oracle" / "README.md").read_text(encoding="utf-8")
        section = " ".join(guide.split("### Uptime monitor", 1)[1].split())
        self.assertIn("only from the default branch", section)
        self.assertIn("60 days without repository activity", section)
        self.assertIn("gh workflow disable uptime.yml", section)
        self.assertIn("gh workflow enable uptime.yml", section)
        self.assertIn("503 `migration-required`", section)
        self.assertIn("`운영 경보`", section)
        # 취소된 실행은 경보를 건드리지 않는다(uptime.yml의 !cancelled())
        self.assertIn("opens, comments on and closes nothing", section)
        self.assertIn("only when `!cancelled()`", section)

    def check_cli(self, routes, *extra):
        transport = FakeTransport(routes)
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.txt"
            with mock.patch.object(uptime, "http_fetch", transport), mock.patch.object(
                uptime.time, "sleep", lambda seconds: None
            ), contextlib.redirect_stdout(io.StringIO()) as printed, contextlib.redirect_stderr(
                io.StringIO()
            ):
                code = uptime.main(["check", "--report", str(report), *extra])
            written = report.read_text(encoding="utf-8")
        return code, written, printed.getvalue()

    def test_the_command_line_writes_the_report_and_returns_the_verdict(self):
        code, written, printed = self.check_cli(
            {READINESS_URL: [error_reply(503, "migration-required")], PAGES: [page()]}
        )
        self.assertEqual(code, 1)
        self.assertEqual(written, printed)
        self.assertTrue(written.endswith("verdict: FAIL\n"))
        self.assertIn("FAIL readiness: HTTP 503 migration-required (after 3 attempts)", written)

        code, written, _ = self.check_cli({READINESS_URL: [readiness()], PAGES: [page()]})
        self.assertEqual(code, 0)
        self.assertTrue(written.endswith("verdict: ok\n"))

    def test_a_crashing_checker_still_writes_a_failing_report(self):
        with mock.patch.object(uptime, "check", side_effect=KeyError("boom")):
            code, written, _ = self.check_cli({})
        self.assertEqual(code, 1)
        self.assertIn("FAIL internal: KeyError", written)
        self.assertTrue(written.endswith("verdict: FAIL\n"))

    def test_only_https_targets_are_accepted(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            uptime.main(["check", "--api", "http://example.com"])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
