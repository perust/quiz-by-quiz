# quiz by quiz

브라우저에서 실행되는 4지선다 상식 퀴즈 게임. 한국사·과학·지리·일반상식·예술과문화 다섯 분야를 제공한다.

애플리케이션은 프레임워크와 번들러 없이 TypeScript를 `tsc`로 JavaScript에 컴파일한다.
브라우저 런타임 의존성은 없으며 생성된 `js/`는 커밋하지 않는다.

> 이전 React/TypeScript 구현은 [`legacy/`](legacy/)에 보존되어 있으며 유지보수하지 않는다.

## 무엇을 할 수 있나

- 카테고리 하나를 골라 **10문제**를 풀거나, **전체 도전**으로 카테고리마다 5문제씩 **25문제**를 푼다.
- 문항당 20초 안에 답하며, 시간이 끝나면 오답으로 처리하고 정답과 해설을 보여준다.
- 한 판을 마치면 점수·정답률·소요 시간, 오답 리뷰, 최고 기록과의 비교를 볼 수 있다.
- 닉네임을 넣어 모드·카테고리별 상위 10개 기록을 이 브라우저에 저장한다.
- 🙂 **내 캐릭터** — 슬라임 여섯 색과 도트 몬스터 여섯 마리 중 하나를 고른다.
- 🕹️ **게임 모드** — 십자로 나뉜 2×2 바닥 위에서 캐릭터를 움직여 보기를 선택한다.
  PC는 방향키, 휴대폰은 화면의 이동 스틱을 사용한다.

> **랭킹은 이 브라우저에만 저장된다.** 배포 사이트의 다른 사용자와 기록을 공유하지 않는다.

## 로컬 실행

Node.js 22와 Python 3 환경에서 다음을 실행한다.

```bash
npm ci
npm run build
npm run serve
```

<http://localhost:8765>로 접속한다. 소스를 수정하면서 컴파일하려면 별도 터미널에서
`npm run watch`를 실행한다.

**`index.html`을 `file://`로 직접 열면 동작하지 않는다.** 브라우저가 ES 모듈과 `fetch`를
제한하므로 반드시 HTTP 서버를 사용한다.

## 검증

```bash
python3 tools/check_bank.py
python3 -m unittest discover -s tests -v
npm run check
```

- `tools/check_bank.py`: 문제 JSON의 스키마, ID, 중복, 카테고리 동기화와 품질 경고를 검사한다.
- Python 단위 테스트: 검증기가 손상된 데이터에서도 안전하게 실패하는지 확인한다.
- `npm run check`: TypeScript를 출력 없이 검사한다.

## 문제 추가하기

문제 추가는 `data/<카테고리>.json`만 수정하고 애플리케이션 코드는 건드리지 않는다.
ID·스키마·사실 확인·중복 점검·검증 순서는
[`docs/question-bank-maintenance.md`](docs/question-bank-maintenance.md)를 따른다.

최소 절차는 다음과 같다.

1. `python3 tools/check_bank.py`로 현재 은행이 정상인지 확인한다.
2. 해당 카테고리의 최대 ID 다음 번호를 사용한다. 빈 번호를 재사용하지 않는다.
3. 연도·수치·순위는 신뢰할 수 있는 출처 두 곳 이상에서 교차 확인한다.
4. 질문·정답·주제가 기존 문항과 겹치지 않는지 확인한다.
5. 검증기, 단위 테스트, TypeScript 검사를 모두 통과시킨다.

특정 카테고리 문항을 사람이 검토하려면 다음처럼 출력할 수 있다.

```bash
python3 tools/check_bank.py --category 과학 --show-questions
```

## 구조

```text
index.html             화면별 <section data-screen="...">
css/style.css          화면 스타일
src/constants.ts       제한 시간·출제 수·배점·카테고리 정의
src/characters.ts      선택 가능한 캐릭터
src/core/              DOM과 분리된 게임 규칙
src/ui/                DOM 렌더링
src/storage/           localStorage 어댑터
src/data/              JSON 로드와 런타임 검증
src/audio.ts           Web Audio 효과음
src/app.ts             진입점
js/                    tsc 생성물, Git에서 제외
data/<카테고리>.json    문제 은행
tools/check_bank.py    저장소 문제 은행 검증기
tests/                 Python 검증기 회귀 테스트
```

로직과 화면을 나눈 것이 핵심 설계다. `src/core/`는 DOM을 직접 다루지 않는다.
랭킹 저장은 저장소 어댑터를 통해서만 접근하므로 서버 저장소로 바꿀 때 게임 규칙을 수정하지 않는다.

## 접근성

- 마우스 없이 키보드만으로 홈 → 퀴즈 → 결과 → 랭킹을 진행할 수 있다.
- 보기는 숫자 키 `1`–`4`로도 고른다.
- 정답과 오답은 색상뿐 아니라 `✓ 정답` / `✗ 오답` 텍스트로 구분한다.
- 화면이 바뀌면 포커스를 옮기고 스크린리더가 새 제목부터 읽는다.
- 타이머는 매초 낭독하지 않고 남은 5초 경고만 한 번 알린다.
- 애니메이션은 `prefers-reduced-motion`을 따른다.
- 320px 폭까지 레이아웃을 유지한다.

## 저장되는 값

서버 전송 없이 `localStorage`만 사용한다.

| 키 | 내용 |
| --- | --- |
| `quiz.rankings` | 랭킹 기록 |
| `quiz.settings` | 음소거·게임 모드·선택 캐릭터 |
| `quiz.nickname` | 마지막 닉네임 |
| `quiz.recentQuestionIds` | 최근 출제 문제 ID |
| `quiz.schemaVersion` | 저장 데이터 스키마 버전 |

손상된 값은 정상 레코드만 살리고 나머지를 버린 뒤 빈 상태로 복구한다.

## 배포

`.github/workflows/pages.yml`이 `main` 푸시 때 문제 은행을 검증하고 TypeScript를 컴파일한 뒤
GitHub Pages 아티팩트를 만든다. 저장소 설정의 **Settings → Pages → Source**는
`GitHub Actions`를 사용한다.

모든 웹 경로는 상대 경로라 `https://<사용자>.github.io/<저장소>/` 같은 하위 경로에서도 동작한다.

## 기술 제약

- 프레임워크와 번들러를 사용하지 않는다.
- npm은 TypeScript 개발 의존성에만 사용하며 브라우저 런타임 외부 라이브러리는 없다.
- ES 모듈과 `fetch`를 사용한다.
- 브라우저 저장은 `localStorage` 어댑터를 통해서만 한다.
- UI 문구와 주석은 한국어로 쓴다.
