---
description: 현행 기준에 따라 퀴즈 문제를 조사·추가하고 전체 문제 은행을 검증한다
argument-hint: <카테고리> <난이도> [개수] [주제] — 예 "예술과문화 hard 2 한국미술"
allowed-tools: Bash(python3:*), Bash(npm:*), Bash(git:*), Read, Edit, WebSearch, WebFetch
---

`$ARGUMENTS`에 맞춰 문제를 추가해줘. 작업의 단일 기준은
`docs/question-bank-maintenance.md`다. 먼저 문서를 읽고 아래 순서를 지킨다.

## 1. 인자 확정

필수 인자는 카테고리와 난이도다.

- 카테고리: `src/constants.ts`에 선언된 한국어 이름 또는 영문 코드
- 난이도: `easy` / `normal` / `hard` (`쉬움` / `보통` / `어려움`도 허용)
- 개수: 생략하면 1, 양의 정수만 허용
- 나머지 문자열: 주제 힌트

카테고리나 난이도가 없거나 잘못됐으면 사용법을 보여주고 **파일을 고치지 않은 채 중단**한다.
알 수 없는 카테고리를 전체로 대체하지 않는다.

## 2. 사전 검증과 추가 맥락

먼저 은행 전체가 정상인지 확인한다.

```bash
python3 tools/check_bank.py
```

실패가 있으면 기존 오류를 먼저 보고하고 문제를 추가하지 않는다. 이어서 확정한 값으로 아래를 실행한다.

```bash
QUIZ_CATEGORY="<확정한 카테고리>" QUIZ_COUNT="<개수>" python3 - <<'PY'
import os
from collections import Counter
from pathlib import Path
from tools.check_bank import DIFFICULTY_TARGET, audit_repository, resolve_category

report = audit_repository(Path.cwd())
raw = os.environ['QUIZ_CATEGORY']
code = resolve_category(report.config, raw)
if code is None:
    raise SystemExit(f'알 수 없는 카테고리: {raw}')
count = int(os.environ['QUIZ_COUNT'])
if count < 1:
    raise SystemExit('개수는 양의 정수여야 합니다')
rows = [row for row in report.questions if row.category == code]
nums = [int(row.id.rsplit('-', 1)[1]) for row in rows]
start = max(nums, default=0) + 1
if start + count - 1 > 999:
    raise SystemExit('현재 ID 규칙 category-NNN 범위를 넘습니다. 규칙 변경을 먼저 합의하세요.')

difficulty = Counter(row.difficulty for row in rows)
positions = Counter(row.answer_index for row in rows)
tags = Counter(tag for row in rows for tag in row.tags)
print(f'카테고리: {report.config.name_for(code)}({code}) · 현재 {len(rows)}문항')
print(f'예약 ID: {code}-{start:03d}' + (f' ~ {code}-{start + count - 1:03d}' if count > 1 else ''))
print('난이도:', ' / '.join(f'{level} {difficulty[level]}' for level in DIFFICULTY_TARGET))
print('정답 위치:', ' / '.join(f'{index}번 {positions[index]}' for index in range(4)))
print('많이 쓴 태그:', ', '.join(f'{tag}({n})' for tag, n in tags.most_common(15)))
PY
```

ID는 최대값 다음 번호부터 예약한다. 중간의 빈 번호는 재사용하지 않는다.
한 카테고리만 늘려 카테고리별 수가 달라진다면 그 영향을 먼저 밝힌다.

## 3. 기존 문항과 주제 조사

대상 카테고리의 유사 문항 후보를 먼저 출력한다.

```bash
python3 tools/check_bank.py --category "<카테고리>" --show-similar
```

대상 JSON을 읽고 아래를 확인한다.

- 같은 질문이나 같은 정답을 다른 표현으로 이미 묻지 않는가
- 특정 시대·분야·태그에 치우치지 않는가
- 요청 난이도와 실제 체감 난도가 맞는가
- 정답 위치와 보기 길이가 습관적으로 치우치지 않는가

주제가 지정되지 않았다면 빈 주제와 기존 태그를 근거로 고른다. 단순히 웹에서 흥미로운 사실을
찾았다는 이유만으로 넣지 않는다.

## 4. 사실 확인과 초안

연도·수치·순위·법률·과학 수치처럼 틀리기 쉬운 사실은 신뢰할 수 있는 출처 두 곳 이상에서
교차 확인한다. 검색 결과 요약만 믿지 말고 원문을 읽는다. 출처가 충돌하거나 범위가 모호하면
그 후보는 버린다.

각 문항은 다음을 만족해야 한다.

- 답이 하나뿐이며 질문에 시점·지역·측정 기준이 충분하다.
- 보기 네 개는 같은 종류·문법·단위이고 부분적으로도 정답이 아니다.
- 정답만 유독 길거나 구체적이지 않다.
- 해설은 정답의 이유와 맥락을 1–2문장으로 설명한다.
- 기존 태그를 우선 재사용한다.

초안을 파일에 쓰기 전에 ID, 질문, 정답, 난이도, 태그, 근거 출처를 표로 보여준다.

## 5. 편집

사용자가 추가를 요청한 것이므로 초안 확인을 다시 요구하지 말고, 검증된 문항을
`data/<category>.json` 배열 끝에 `Edit`로 추가한다. 기존 키 순서·공백 2칸·한글 원문을 유지한다.
전체 파일을 `json.dump`로 다시 쓰지 않는다. 애플리케이션 코드는 수정하지 않는다.

## 6. 검증

```bash
python3 tools/check_bank.py
python3 -m unittest discover -s tests -v
npm ci
npm run check
git diff --check
git diff -- data/
```

모두 통과할 때까지 오타·인덱스·형식 오류를 수정한다. 자동 검증 뒤에도 새 문항을 다시 읽어
복수 정답, 사실 오류, 해설과 정답 불일치를 확인한다. 커밋이나 푸시는 별도 지시가 있을 때만 한다.

## 7. 보고

- 추가한 파일과 ID 범위
- 문항별 정답·난이도·태그
- 사실 확인에 사용한 출처와 확인한 주장
- 중복·균형 판단
- 실행한 검증과 실제 결과
- 남은 경고 또는 카테고리 수 불균형
