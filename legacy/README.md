# legacy — 이전 버전 보관

저장소의 주력 앱이 **React/TypeScript 버전에서 빌드 도구 없는 순수 HTML/CSS/JS 버전으로 교체**되면서,
이전 코드를 지우지 않고 이곳에 그대로 옮겨 두었습니다. 현재 앱은 저장소 루트에 있습니다.

이 폴더의 코드는 **더 이상 유지보수하지 않습니다.** 참고와 이력 보존이 목적입니다.

## 무엇이 들어 있나

| 경로 | 내용 |
| --- | --- |
| `quiz-challenge/` | 이전 React 앱 전체 (CRA + TypeScript + Tailwind) |
| `claude-commands/` | 이전 앱을 대상으로 만든 Claude Code 명령어 14개 |
| `workflows/ci.yml` | 이전 앱의 CI 워크플로 |
| `README-react.md` | 이전 저장소 루트 README |

## 왜 그대로 합치지 않았나

두 버전은 기술 스택이 정면으로 다릅니다.

| | 현재 (루트) | 이전 (`legacy/quiz-challenge/`) |
| --- | --- | --- |
| 스택 | 순수 HTML/CSS/JS | React + TypeScript + Tailwind |
| 빌드 | 없음 | Create React App (`npm ci` → `npm run build`) |
| 문제 데이터 | `data/*.json` 4개 파일 | `src/data/questions.ts` |
| 카테고리 | 한국사·과학·지리·일반상식 | 한국사·과학·지리·예술과문화 |

코드를 섞을 수 없어 통째로 보존하는 쪽을 택했습니다.

## 이전 앱을 다시 돌려보려면

```bash
cd legacy/quiz-challenge
npm install
npm start
```

`workflows/ci.yml`은 `.github/workflows/`에서 빼 두었습니다. 그대로 두면 경로가 맞지 않아
실패하고, 유지보수하지 않는 코드에 CI를 돌릴 이유도 없기 때문입니다. 다시 쓰려면
`working-directory`와 `cache-dependency-path`의 `quiz-challenge`를
`legacy/quiz-challenge`로 고친 뒤 `.github/workflows/`로 옮기면 됩니다.

## 이전 명령어를 다시 쓰려면

`claude-commands/`의 파일들은 `quiz-challenge/src/data/questions.ts`를 읽도록 쓰여 있어
현재 앱에는 맞지 않습니다. 특히 `quiz-add.md` · `quiz-range.md` · `quiz-validate.md`는
루트 `.claude/commands/`에 **같은 이름의 현재 앱용 명령어**가 있습니다. 되살릴 때는
경로를 고치고 이름이 겹치지 않게 하위 폴더로 옮겨 이름공간을 나누세요
(`.claude/commands/legacy/quiz-add.md` → `/legacy:quiz-add`).

교사용 명령어(`quiz-teacher-*`)와 `quiz-daily` · `quiz-stats` · `quiz-leaderboard` ·
`export-report`는 현재 앱에 대응하는 기능이 없습니다.
