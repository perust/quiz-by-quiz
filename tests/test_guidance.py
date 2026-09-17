import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tools.check_bank import load_project_config

ROOT = Path(__file__).resolve().parents[1]
COMMANDS = ROOT / ".claude" / "commands"
QUESTION_COMMANDS = (
    "quiz-add.md",
    "quiz-check.md",
    "quiz-validate.md",
    "quiz-stats.md",
    "quiz-range.md",
    "quiz-daily.md",
)


def python_snippets(filename: str) -> list[str]:
    text = (COMMANDS / filename).read_text(encoding="utf-8")
    pattern = re.compile(r"python3\s+-\s+<<'PY'\n(?P<source>.*?)\nPY", re.DOTALL)
    return [match.group("source") for match in pattern.finditer(text)]


def workflow_run_script(filename: str) -> str:
    lines = (
        (ROOT / ".github" / "workflows" / filename)
        .read_text(encoding="utf-8")
        .splitlines()
    )
    commands: list[str] = []
    index = 0
    while index < len(lines):
        match = re.match(r"^(?P<indent>\s*)run:\s*(?P<value>.*)$", lines[index])
        if not match:
            index += 1
            continue

        base_indent = len(match.group("indent"))
        value = match.group("value").strip()
        if value and value not in {"|", ">"}:
            commands.append(value)
            index += 1
            continue

        index += 1
        while index < len(lines):
            line = lines[index]
            stripped = line.strip()
            indent = len(line) - len(line.lstrip())
            if stripped and indent <= base_indent:
                break
            if stripped and not stripped.startswith("#"):
                commands.append(stripped)
            index += 1
    return "\n".join(commands)


class GuidanceConsistencyTests(unittest.TestCase):
    def test_embedded_python_in_current_commands_parses(self):
        failures = []
        for path in sorted(COMMANDS.glob("*.md")):
            for index, source in enumerate(python_snippets(path.name), start=1):
                try:
                    ast.parse(source, filename=f"{path.name}#snippet-{index}")
                except SyntaxError as error:
                    failures.append(str(error))
        self.assertEqual([], failures)

    def test_read_only_question_command_snippets_execute(self):
        cases = (
            ("quiz-add.md", {"QUIZ_CATEGORY": "과학", "QUIZ_COUNT": "1"}, "예약 ID"),
            ("quiz-stats.md", {"QUIZ_CATEGORY": "과학"}, "목표 난이도"),
            ("quiz-range.md", {"QUIZ_ARGS": "1-3 지리"}, "검토 대상"),
        )
        for filename, extra_env, expected in cases:
            with self.subTest(filename=filename):
                snippets = python_snippets(filename)
                self.assertEqual(1, len(snippets))
                env = os.environ.copy()
                env.update(extra_env)
                proc = subprocess.run(
                    [sys.executable, "-c", snippets[0]],
                    cwd=ROOT,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(0, proc.returncode, proc.stderr)
                self.assertIn(expected, proc.stdout)

    def test_daily_backup_snippet_creates_a_labeled_snapshot(self):
        snippets = python_snippets("quiz-daily.md")
        self.assertEqual(1, len(snippets))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            data.mkdir()
            (data / "history.json").write_text(
                json.dumps([{"id": "history-001"}], ensure_ascii=False),
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["QUIZ_BACKUP_LABEL"] = "test"
            proc = subprocess.run(
                [sys.executable, "-c", snippets[0]],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, proc.returncode, proc.stderr)
            snapshots = list((root / "backups").glob("*-test"))
            self.assertEqual(1, len(snapshots))
            self.assertTrue((snapshots[0] / "history.json").is_file())
            manifest = (snapshots[0] / "MANIFEST.txt").read_text(encoding="utf-8")
            self.assertIn("용도 test", manifest)
            self.assertIn("파일 1개 / 문항 1개", manifest)

    def test_teacher_register_uses_current_all_round_total(self):
        snippets = python_snippets("quiz-teacher-register.md")
        self.assertEqual(1, len(snippets))
        config = load_project_config(ROOT)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "src").mkdir()
            shutil.copy2(ROOT / "src" / "constants.ts", root / "src" / "constants.ts")
            env = os.environ.copy()
            env["PYTHONPATH"] = str(ROOT)
            env["QUIZ_ARGS"] = "테스트학생 전체 20"
            proc = subprocess.run(
                [sys.executable, "-c", snippets[0]],
                cwd=root,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
            record = json.loads(
                (root / "teacher" / "submissions" / "테스트학생.json").read_text(
                    encoding="utf-8"
                )
            )["records"][0]
            self.assertEqual(config.all_round_questions, record["totalCount"])
            self.assertEqual(200, record["score"])

    def test_leaderboard_command_checks_current_source_and_passes(self):
        snippets = python_snippets("quiz-leaderboard.md")
        self.assertEqual(1, len(snippets))
        self.assertNotIn("glob.glob('js/", snippets[0])
        proc = subprocess.run(
            [sys.executable, "-c", snippets[0]],
            cwd=ROOT,
            env=os.environ.copy(),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(0, proc.returncode, proc.stdout + proc.stderr)
        result = re.search(r"(\d+)/(\d+) 통과", proc.stdout)
        self.assertIsNotNone(result, proc.stdout)
        assert result is not None
        self.assertEqual(result.group(1), result.group(2))

    def test_current_commands_do_not_copy_category_tuple(self):
        offenders = []
        copied_tuple = re.compile(r"^CATEGORIES\s*=\s*\(", re.MULTILINE)
        for path in sorted(COMMANDS.glob("*.md")):
            if copied_tuple.search(path.read_text(encoding="utf-8")):
                offenders.append(path.name)
        self.assertEqual([], offenders)

    def test_question_commands_reference_the_canonical_guide(self):
        missing = []
        for filename in QUESTION_COMMANDS:
            text = (COMMANDS / filename).read_text(encoding="utf-8")
            if "docs/question-bank-maintenance.md" not in text:
                missing.append(filename)
        self.assertEqual([], missing)

    def test_live_docs_use_current_round_and_build_model(self):
        config = load_project_config(ROOT)
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        prd = (ROOT / "docs" / "quiz-game-prd.md").read_text(encoding="utf-8")
        historical = (ROOT / "docs" / "quiz-game-claude-code-prompts.md").read_text(
            encoding="utf-8"
        )

        self.assertIn(f"**{config.all_round_questions}문제**", readme)
        self.assertIn("npm ci", readme)
        self.assertIn("전체 모드 250점 만점", prd)
        self.assertIn(f"카테고리 {len(config.categories)}종", prd)
        self.assertIn("역사 자료 — 현행 작업에 실행하지 않는다", historical[:500])
        self.assertNotRegex(readme, r"전체 도전[^\n]*(?:40|50)문제")
        self.assertNotIn("빌드 단계가 없다", readme)

    def test_pull_requests_run_the_same_quality_gates(self):
        workflow_file = ROOT / ".github" / "workflows" / "validate.yml"
        workflow = workflow_file.read_text(encoding="utf-8")
        self.assertRegex(workflow, r"(?m)^\s*pull_request:\s*$")
        run_script = workflow_run_script("validate.yml")
        bank = run_script.index("python3 tools/check_bank.py")
        tests = run_script.index("python3 -m unittest discover -s tests -v")
        install = run_script.index("npm ci")
        types = run_script.index("npm run check")
        self.assertLess(bank, tests)
        self.assertLess(tests, install)
        self.assertLess(install, types)

    def test_pages_workflow_runs_bank_gate_before_build(self):
        run_script = workflow_run_script("pages.yml")
        bank = run_script.index("python3 tools/check_bank.py")
        tests = run_script.index("python3 -m unittest discover -s tests -v")
        install = run_script.index("npm ci")
        build = run_script.index("npm run build")
        self.assertLess(bank, tests)
        self.assertLess(tests, install)
        self.assertLess(install, build)


if __name__ == "__main__":
    unittest.main()
