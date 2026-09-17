---
description: 문제 은행을 점검하고 명시된 부족 범위를 한 번에 안전하게 보강한다
argument-hint: [카테고리] [개수] — 예 "한국사 2". 생략하면 점검만 하고 불균형 카테고리가 있을 때만 추천
allowed-tools: Bash(python3:*), Bash(npm:*), Bash(git:*), Bash(cp:*), Read, Edit, WebSearch, WebFetch
---

문제 은행의 하루치 유지보수를 수행해줘. 단일 기준은 `docs/question-bank-maintenance.md`다.
각 단계가 실패하면 다음 단계로 넘어가지 말고, 파일 수정 여부와 복구 방법을 함께 보고한다.

## 1. 사전 무결성

```bash
python3 tools/check_bank.py
python3 -m unittest discover -s tests -v
```

실패가 있으면 기존 은행을 먼저 고쳐야 하므로 여기서 중단한다.

## 2. 현황과 대상 결정

`/quiz-stats`와 같은 방식으로 전체 분포를 집계한다. 인자로 준 카테고리·개수가 있으면 그 범위를
사용하되, 알 수 없는 카테고리나 1보다 작은 개수는 오류로 종료한다.

인자가 없을 때:

- 카테고리별 문항 수가 다르면 가장 적은 카테고리와 목표 난이도 `40/40/20`의 가장 큰 부족분을 추천한다.
- 모든 카테고리 수가 같으면 임의의 한 카테고리를 늘리지 않는다. `균형 상태라 자동 보강 대상 없음`을
  보고하고 점검만 끝낸다. 균형 배치 또는 특정 카테고리가 명시돼야 추가한다.

정답 위치는 런타임 셔플 때문에 보강 대상의 최우선 기준으로 사용하지 않는다. 태그와 주제 공백을
사람이 읽어 최종 주제를 정한다.

## 3. 수정 전 백업

파일을 추가할 때만 실행한다.

```bash
QUIZ_BACKUP_LABEL="pre-edit" python3 - <<'PY'
import json
import os
import shutil
from datetime import datetime
from pathlib import Path

root = Path.cwd()
files = sorted((root / 'data').glob('*.json'))
if not files:
    raise SystemExit('백업할 data/*.json이 없습니다')
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
label = os.environ.get('QUIZ_BACKUP_LABEL') or 'pre-edit'
dest = root / 'backups' / f'{stamp}-{label}'
dest.mkdir(parents=True, exist_ok=False)
total = 0
for source in files:
    rows = json.loads(source.read_text(encoding='utf-8'))
    total += len(rows)
    shutil.copy2(source, dest / source.name)
(dest / 'MANIFEST.txt').write_text(
    f'생성 {stamp}\n용도 {label}\n파일 {len(files)}개 / 문항 {total}개\n',
    encoding='utf-8',
)
print(dest)
print(f'복구: cp {dest}/*.json data/')
PY
```

백업이 실패하면 수정하지 않는다. `backups/`는 커밋하지 않는다.

## 4. 조사·중복 검토·추가

확정한 카테고리·난이도·개수에 대해 `/quiz-add`의 2–5단계를 그대로 따른다.

- 다음 ID는 최대값 + 1이며 빈 번호를 재사용하지 않는다.
- 연도·수치·순위는 원문 출처 두 곳 이상으로 확인한다.
- 같은 질문뿐 아니라 같은 정답·같은 지식을 표현만 바꾼 중복도 피한다.
- 질문 유사도가 높거나 출처가 충돌한 후보는 버리고 이유를 기록한다.
- `Edit`로 대상 배열 끝만 수정한다. 전체 JSON을 재직렬화하지 않는다.

## 5. 수정 후 게이트

```bash
python3 tools/check_bank.py
python3 -m unittest discover -s tests -v
npm ci
npm run check
git diff --check
git diff -- data/
```

사소한 오타·인덱스 오류는 고치고 전체 게이트를 처음부터 다시 실행한다. 원인을 알 수 없거나
수정 범위가 커지면 백업 경로의 JSON을 `data/`로 복원하고 중단한다.

특정 카테고리만 늘려 문항 수가 달라졌다면 검증기의 균형 경고를 숨기지 않는다. 명시된 단일
카테고리 요청이 아니면 PR이나 커밋 전에 균형 배치를 완성한다.

## 6. 검증 후 백업

검증을 통과한 변경이라면 같은 백업 스크립트를 `verified` 라벨로 한 번 더 실행해 로컬 스냅샷을
남긴다. 백업 경로는 결과에 기록하되 Git에는 넣지 않는다.

## 7. 보고

| 단계 | 결과 | 근거 |
| --- | --- | --- |
| 사전 무결성 | | 검증기·테스트 결과 |
| 현황·대상 | | 카테고리·난이도·주제 선정 이유 |
| 수정 전 백업 | | 경로와 복구 명령 |
| 조사·중복 | | 출처와 버린 후보 |
| 추가 | | 파일과 ID 범위 |
| 수정 후 게이트 | | 각 명령의 실제 결과 |
| 검증 후 백업 | | 경로 |

추가할 대상이 없어 점검만 끝났다면 파일을 수정하거나 빈 백업을 만들지 않는다.
