---
description: 지정한 ID 번호 범위의 문제를 난이도와 보기 편향 관점에서 검토한다
argument-hint: <범위> [카테고리] — 예 "1-20", "1 20 지리", "예술과문화 5"
allowed-tools: Bash(python3:*), Read
---

`$ARGUMENTS`가 가리키는 문제를 수정하지 말고 검토해줘. 번호는 파일 순서가 아니라
`history-003` 같은 ID의 뒷자리다. 카테고리를 생략하면 모든 카테고리에서 같은 번호 범위를 본다.
문항 품질과 판정 기준은 `docs/question-bank-maintenance.md`를 따른다.

## 1. 집계

먼저 전체 무결성을 확인한다.

```bash
python3 tools/check_bank.py
```

통과한 뒤 아래를 실행한다. `1-20`, `1~20`, `1 20`, `5`, 카테고리 단독을 받는다.

```bash
QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
import os
import re
from collections import Counter
from pathlib import Path
from tools.check_bank import LEVELS, audit_repository, resolve_category

report = audit_repository(Path.cwd())
if report.errors:
    raise SystemExit('문제 은행 검증 실패 — tools/check_bank.py 출력을 먼저 해결하세요')
raw = (os.environ.get('QUIZ_ARGS') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''
text = re.sub(r'[~–—]', '-', raw)
start = end = None
span = re.search(r'(\d+)\s*-\s*(\d+)', text)
if span:
    start, end = int(span.group(1)), int(span.group(2))
    text = text[:span.start()] + ' ' + text[span.end():]
else:
    nums = re.findall(r'\d+', text)
    if nums:
        start = int(nums[0])
        end = int(nums[1]) if len(nums) > 1 else start
        text = re.sub(r'\d+', ' ', text)
if start is not None and end is not None and start > end:
    start, end = end, start

tokens = [token for token in re.split(r'[\s,]+', text) if token and token != '-']
target = None
unknown = []
for token in tokens:
    code = resolve_category(report.config, token)
    if code and target is None:
        target = code
    else:
        unknown.append(token)
if unknown:
    choices = ', '.join(f'{c.name}({c.code})' for c in report.config.categories)
    raise SystemExit(f'알 수 없는 인자: {", ".join(unknown)}. 카테고리: {choices}')

rows = []
for row in report.questions:
    number = int(row.id.rsplit('-', 1)[1])
    if target and row.category != target:
        continue
    if start is not None and not (start <= number <= end):
        continue
    rows.append(row)
if not rows:
    raise SystemExit('해당 범위에 문제가 없습니다')

scope = report.config.name_for(target) if target else '전체 카테고리'
span_label = f'{start}–{end}번' if start is not None else '전체 번호'
print(f'검토 대상: {scope} / {span_label} · {len(rows)}문항')
difficulty = Counter(row.difficulty for row in rows)
positions = Counter(row.answer_index for row in rows)
print('난이도:', ' / '.join(f'{level} {difficulty[level]}' for level in LEVELS))
print('정답 위치:', ' / '.join(f'{i}번 {positions[i]}' for i in range(4)))
longest = [row for row in rows if row.answer_is_longest]
print(f'정답이 가장 긴 문항: {len(longest)}/{len(rows)} ({len(longest)/len(rows):.0%})')
for row in sorted(rows, key=lambda item: (item.category, item.id)):
    flag = ' · 정답 최장' if row.answer_is_longest else ''
    print(f'[{row.id}] {row.difficulty:<6} 정답 {row.answer_index}번{flag} · {row.question}')
PY
```

## 2. 판정

- `difficulty`가 선언값뿐 아니라 실제 체감 난도와 맞는지 읽는다.
- 한 범위에 같은 난이도·주제가 몰렸는지 본다.
- 정답 위치 쏠림은 런타임 셔플 때문에 직접적인 공정성 오류가 아님을 함께 적는다.
- 정답만 길거나 문법·단위가 다른 보기는 위치를 섞어도 단서가 되므로 문항별로 지적한다.
- 같은 번호대에 비슷한 질문 구조가 반복되는지 본다.

## 3. 출력

대상·문항 수, 난이도 분포와 지적, 정답 위치와 길이 편향, 문항별 수정 제안을 순서대로 쓴다.
손댈 것이 없으면 `손댈 것 없음`이라고 명확히 쓴다. 고치라는 지시가 없으면 파일을 변경하지 않는다.
