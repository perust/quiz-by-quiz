---
description: 현재 문제 은행의 수·난이도·정답 위치·태그 분포를 집계하고 다음 보강 지점을 제안한다
argument-hint: [카테고리 (한국사·과학·지리·일반상식·예술과문화 또는 영문 코드, 생략하면 전체)]
allowed-tools: Bash(python3:*), Read
---

문제 은행 통계를 내고 **다음에 무엇을 채워야 하는지** 판단해줘. 기준은
`docs/question-bank-maintenance.md`다.

## 1. 무결성·기본 통계

```bash
python3 tools/check_bank.py
```

실패가 있으면 통계 해석을 멈추고 오류부터 보고한다. 이어서 아래 스크립트로 현재 코드에서
카테고리를 읽어 상세 분포를 낸다.

```bash
QUIZ_CATEGORY="$ARGUMENTS" python3 - <<'PY'
import os
import re
from collections import Counter
from pathlib import Path
from tools.check_bank import DIFFICULTY_TARGET, audit_repository, resolve_category

report = audit_repository(Path.cwd())
if report.errors:
    raise SystemExit('문제 은행 검증 실패 — tools/check_bank.py 출력을 먼저 해결하세요')
raw = (os.environ.get('QUIZ_CATEGORY') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''
target = resolve_category(report.config, raw)
if raw and target is None:
    choices = ', '.join(f'{c.name}({c.code})' for c in report.config.categories)
    raise SystemExit(f'알 수 없는 카테고리: {raw}. 사용 가능: {choices}')
codes = (target,) if target else report.config.category_codes

print('목표 난이도: easy 40% / normal 40% / hard 20%')
for code in codes:
    rows = [row for row in report.questions if row.category == code]
    difficulty = Counter(row.difficulty for row in rows)
    positions = Counter(row.answer_index for row in rows)
    tags = Counter(tag for row in rows for tag in row.tags)
    nums = sorted(int(row.id.rsplit('-', 1)[1]) for row in rows)
    gaps = [n for n in range(1, max(nums, default=0) + 1) if n not in set(nums)]
    print(f'\n■ {report.config.name_for(code)}({code}) · {len(rows)}문항')
    print(f'  ID {min(nums, default=0):03d}–{max(nums, default=0):03d}'
          + (f' · 빈 번호 {gaps}' if gaps else ' · 연속'))
    for level, target_ratio in DIFFICULTY_TARGET.items():
        n = difficulty[level]
        ratio = n / len(rows) if rows else 0
        deficit = target_ratio * len(rows) - n
        print(f'  {level:<7} {n:>3}개 {ratio:>6.1%} · 목표 대비 {deficit:+.1f}개')
    print('  정답 위치  ' + ' / '.join(f'{i}: {positions[i]}' for i in range(4)))
    print('  주요 태그  ' + ', '.join(f'{tag}({n})' for tag, n in tags.most_common(15)))
    singletons = [tag for tag, n in tags.items() if n == 1]
    if singletons:
        print(f'  1회 태그   {len(singletons)}개 · ' + ', '.join(singletons[:15]))
PY
```

## 2. 해석

- 카테고리별 문항 수는 같게 유지한다. 가장 적은 카테고리를 먼저 채운다.
- 난이도 목표는 **40/40/20 비율**이다. 과거의 절대 목표 `4/4/2`를 현재 은행에 적용하지 않는다.
- 정답 위치는 각 25%가 참고선이지만 런타임이 보기를 섞으므로 플레이 공정성 오류로 과장하지 않는다.
- 정답만 긴 편향은 셔플로 없어지지 않는다.
- 태그는 철자만 다른 동의어와 1회성 파편화를 구분한다.
- 빈 ID는 삭제 흔적이며 재사용 대상이 아니다.

## 3. 출력

1. 대상과 총 문항 수
2. 카테고리 수 균형
3. 난이도 목표 대비 부족분
4. 정답 위치·길이 편향
5. 태그로 본 과다·공백 주제
6. 다음 보강 제안: **카테고리 + 난이도 + 주제**까지 구체적으로

손댈 것이 없으면 `균형 양호, 우선 보강 대상 없음`이라고 쓴다. 이 명령은 파일을 변경하지 않는다.
