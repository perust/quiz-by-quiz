# teacher/ — 선생님 모드 작업 폴더

이 폴더에는 **학생 이름과 성적**이 담긴다. 개인정보다.

`.gitignore` 가 이 README 를 뺀 전부를 제외한다. 저장소 루트가 곧 배포 루트라
(`SOURCE_DIR: .`) 커밋되면 공개 사이트에 학생 데이터가 올라간다. 규칙을 풀지 말 것.

## 구성

| 경로 | 내용 | 만드는 것 |
| --- | --- | --- |
| `submissions/` | 학생이 내보낸 퀴즈 기록 | 선생님이 직접 넣는다 |
| `teacher_report.html` | 종합 리포트 | `/teacher-dashboard` |
| `export/` | CSV · PDF | `/export-report` |

## 시작하기

1. `/quiz-teacher-collect` 의 안내를 학생에게 전달해 기록을 받는다
2. 받은 파일을 `submissions/<이름>.json` 으로 넣는다
3. `/teacher-dashboard` 로 분석하고, `/export-report` 로 내보낸다

앱은 서버가 없어 기록이 각 학생 브라우저에만 남는다 (PRD 9.1).
학생이 내보내 주기 전까지 선생님이 볼 수 있는 데이터는 존재하지 않는다.
