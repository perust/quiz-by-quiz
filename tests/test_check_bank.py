import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tools import check_bank

ROOT = Path(__file__).resolve().parents[1]


def question(qid: str, category: str, text: str = "고유한 문제는?") -> dict:
    return {
        "id": qid,
        "category": category,
        "question": text,
        "choices": ["정답", "오답 하나", "오답 둘", "오답 셋"],
        "answerIndex": 0,
        "explanation": "정답을 설명합니다.",
        "difficulty": "easy",
        "tags": ["태그"],
    }


class FixtureProject:
    def __init__(self, root: Path, categories: tuple[tuple[str, str], ...]) -> None:
        self.root = root
        (root / "src").mkdir(parents=True)
        (root / "data").mkdir()
        rows = "\n".join(
            f"  {{ id: '{code}', name: '{name}', icon: 'x', description: 'x' }},"
            for code, name in categories
        )
        (root / "src" / "constants.ts").write_text(
            "export const QUESTIONS_PER_ROUND = 1;\n"
            "export const QUESTIONS_PER_CATEGORY_IN_ALL = 1;\n"
            "export const CATEGORIES: Category[] = [\n"
            f"{rows}\n"
            "];\n",
            encoding="utf-8",
        )

    def write_bank(
        self, category: str, rows: list[object], *, ensure_ascii: bool = False
    ) -> None:
        (self.root / "data" / f"{category}.json").write_text(
            json.dumps(rows, ensure_ascii=ensure_ascii, indent=2),
            encoding="utf-8",
        )


class CheckBankTests(unittest.TestCase):
    def make_project(self, categories=(("history", "한국사"), ("science", "과학"))):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        return FixtureProject(root, categories)

    def test_valid_bank_uses_application_categories_and_round_sizes(self):
        project = self.make_project()
        project.write_bank(
            "history", [question("history-001", "history", "한국사 문제는?")]
        )
        project.write_bank(
            "science", [question("science-001", "science", "과학 문제는?")]
        )

        report = check_bank.audit_repository(project.root)

        self.assertEqual([], report.errors)
        self.assertEqual(("history", "science"), report.config.category_codes)
        self.assertEqual(1, report.config.questions_per_round)
        self.assertEqual(2, report.config.all_round_questions)
        self.assertEqual(2, report.total_questions)

    def test_config_parser_ignores_id_name_objects_outside_categories(self):
        project = self.make_project((("history", "한국사"),))
        constants = project.root / "src" / "constants.ts"
        constants.write_text(
            "export const MASCOT = { id: 'rogue', name: '가짜' };\n"
            + constants.read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        project.write_bank("history", [question("history-001", "history")])

        report = check_bank.audit_repository(project.root)

        self.assertEqual(("history",), report.config.category_codes)
        self.assertEqual([], report.errors)

    def test_config_parser_accepts_field_reordering_and_double_quotes(self):
        project = self.make_project((("history", "한국사"), ("science", "과학")))
        (project.root / "src" / "constants.ts").write_text(
            "export const QUESTIONS_PER_ROUND = 1;\n"
            "export const QUESTIONS_PER_CATEGORY_IN_ALL = 1;\n"
            "export const CATEGORIES: Category[] = [\n"
            "  { name: '한국사', id: 'history', icon: 'x' },\n"
            '  { id: "science", name: "과학", icon: "x" },\n'
            "];\n",
            encoding="utf-8",
        )
        project.write_bank(
            "history", [question("history-001", "history", "한국사 확인 문제는?")]
        )
        project.write_bank(
            "science", [question("science-001", "science", "과학 확인 문제는?")]
        )

        report = check_bank.audit_repository(project.root)

        self.assertEqual(("history", "science"), report.config.category_codes)
        self.assertEqual([], report.errors)

    def test_malformed_rows_are_reported_without_crashing(self):
        project = self.make_project((("history", "한국사"),))
        malformed = question("history-001", "history")
        malformed["answerIndex"] = True
        malformed["choices"] = ["하나", "하나", "셋"]
        malformed["tags"] = [""]
        project.write_bank("history", [None, malformed])

        report = check_bank.audit_repository(project.root)
        joined = "\n".join(report.errors)

        self.assertIn("객체가 아님", joined)
        self.assertIn("answerIndex", joined)
        self.assertIn("보기는 4개", joined)
        self.assertIn("보기 중복", joined)
        self.assertIn("tags", joined)

    def test_non_array_bank_is_an_error(self):
        project = self.make_project((("history", "한국사"),))
        (project.root / "data" / "history.json").write_text("{}", encoding="utf-8")

        report = check_bank.audit_repository(project.root)

        self.assertTrue(any("최상위가 배열이 아님" in error for error in report.errors))

    def test_each_bank_must_cover_the_configured_round_size(self):
        project = self.make_project((("history", "한국사"),))
        constants = project.root / "src" / "constants.ts"
        constants.write_text(
            constants.read_text(encoding="utf-8").replace(
                "QUESTIONS_PER_ROUND = 1", "QUESTIONS_PER_ROUND = 2"
            ),
            encoding="utf-8",
        )
        project.write_bank("history", [question("history-001", "history")])

        report = check_bank.audit_repository(project.root)

        self.assertTrue(
            any("출제 수 2문제보다 적음" in error for error in report.errors)
        )

    def test_category_json_path_must_be_a_regular_file(self):
        project = self.make_project((("history", "한국사"),))
        (project.root / "data" / "history.json").mkdir()

        report = check_bank.audit_repository(project.root)

        self.assertTrue(any("일반 파일이 아님" in error for error in report.errors))

    def test_invalid_utf8_is_reported_without_crashing(self):
        project = self.make_project((("history", "한국사"),))
        (project.root / "data" / "history.json").write_bytes(b"\xff\xfe")

        report = check_bank.audit_repository(project.root)

        self.assertTrue(any("UTF-8" in error for error in report.errors))

    def test_missing_and_unknown_category_files_are_errors(self):
        project = self.make_project()
        project.write_bank("history", [question("history-001", "history")])
        project.write_bank("rogue", [question("rogue-001", "rogue")])

        report = check_bank.audit_repository(project.root)
        joined = "\n".join(report.errors)

        self.assertIn("data/science.json", joined)
        self.assertIn("알 수 없는 카테고리 파일", joined)

    def test_global_duplicate_ids_and_question_text_are_errors(self):
        project = self.make_project()
        project.write_bank(
            "history", [question("history-001", "history", "같은 사실을 묻는 문제?")]
        )
        project.write_bank(
            "science", [question("history-001", "science", "같은 사실을 묻는 문제!")]
        )

        report = check_bank.audit_repository(project.root)
        joined = "\n".join(report.errors)

        self.assertIn("ID 중복", joined)
        self.assertIn("문항 문장 중복", joined)

    def test_ascii_escaped_korean_is_rejected_for_reviewable_diffs(self):
        project = self.make_project((("history", "한국사"),))
        project.write_bank(
            "history", [question("history-001", "history")], ensure_ascii=True
        )

        report = check_bank.audit_repository(project.root)

        self.assertTrue(any("Unicode 이스케이프" in error for error in report.errors))

    def test_cli_accepts_korean_category_and_lists_questions(self):
        project = self.make_project()
        project.write_bank(
            "history", [question("history-001", "history", "한국사 문제는?")]
        )
        project.write_bank(
            "science", [question("science-001", "science", "과학 문제는?")]
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "check_bank.py"),
                "--root",
                str(project.root),
                "--category",
                "한국사",
                "--show-questions",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(0, completed.returncode, completed.stdout + completed.stderr)
        self.assertIn("history-001", completed.stdout)
        self.assertIn("한국사 문제는?", completed.stdout)
        self.assertNotIn("science-001", completed.stdout)

    def test_cli_can_list_near_duplicate_candidates(self):
        project = self.make_project((("history", "한국사"),))
        first = question("history-001", "history", "조선을 세운 인물은 누구인가?")
        second = question("history-002", "history", "조선 왕조를 세운 인물은 누구인가?")
        second["choices"] = ["정도전", "이성계", "이방원", "최영"]
        second["answerIndex"] = 1
        project.write_bank("history", [first, second])

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "check_bank.py"),
                "--root",
                str(project.root),
                "--category",
                "한국사",
                "--show-similar",
                "--similarity-threshold",
                "0.6",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(0, completed.returncode, completed.stdout + completed.stderr)
        self.assertIn("유사 문항 후보 1건", completed.stdout)
        self.assertIn("history-001 ↔ history-002", completed.stdout)

    def test_cli_rejects_unknown_category_instead_of_falling_back_to_all(self):
        project = self.make_project((("history", "한국사"),))
        project.write_bank("history", [question("history-001", "history")])

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "check_bank.py"),
                "--root",
                str(project.root),
                "--category",
                "없는분야",
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertNotEqual(0, completed.returncode)
        self.assertIn("알 수 없는 카테고리", completed.stderr)

    def test_cli_reports_broken_application_constants_as_validation_failure(self):
        project = self.make_project((("history", "한국사"),))
        (project.root / "src" / "constants.ts").write_text(
            "export const CATEGORIES = [];\n",
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "check_bank.py"),
                "--root",
                str(project.root),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(1, completed.returncode)
        self.assertIn("CATEGORIES", completed.stderr)

    def test_cli_reports_non_utf8_application_constants_cleanly(self):
        project = self.make_project((("history", "한국사"),))
        (project.root / "src" / "constants.ts").write_bytes(b"\xff\xfe")

        completed = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "check_bank.py"),
                "--root",
                str(project.root),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(1, completed.returncode)
        self.assertIn("UTF-8", completed.stderr)
        self.assertNotIn("Traceback", completed.stderr)

    def test_current_repository_has_no_blocking_bank_errors(self):
        report = check_bank.audit_repository(ROOT)

        self.assertEqual([], report.errors)
        counts = [report.stats[code].count for code in report.config.category_codes]
        self.assertTrue(counts)
        self.assertEqual(1, len(set(counts)))
        self.assertGreaterEqual(min(counts), report.config.questions_per_round)
        self.assertEqual(sum(counts), report.total_questions)


if __name__ == "__main__":
    unittest.main()
