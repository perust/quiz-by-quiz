---
description: 모든 문제의 정답이 사실에 맞는지 검증한다 (형식 검사 + 교차 검증)
argument-hint: [카테고리 (한국사·과학·지리·일반상식, 생략하면 전체)]
allowed-tools: Bash(python3:*), Read, WebSearch, WebFetch
---

`data/` 의 모든 문제에 대해 **정답이 사실에 맞는지** 검증해줘.

형식 검사와 사실 검증은 다르다. `answerIndex` 가 0~3 범위에 있어도 그 보기가 틀린 답일 수 있다.
스크립트는 형식만 걸러내고, **정답이 맞는지는 읽고 판단해야 한다.** 이 명령어의 무게는 뒤쪽에 있다.

40문항 전체를 한 번에 보면 주의가 흩어진다. 인자로 카테고리를 주고 한 번에 하나씩 보는 편이 낫다.

## 1. 형식 검사와 자료 수집

아래를 그대로 실행한다.

```bash
QUIZ_CATEGORY="$ARGUMENTS" python3 - <<'PY'
import json, glob, os, re
from difflib import SequenceMatcher

CATEGORIES = ('history', 'science', 'geography', 'general', 'art')
ALIASES = {'한국사': 'history', '과학': 'science', '지리': 'geography',
           '일반상식': 'general', '예술과문화': 'art'}
NAMES = {c: k for k, c in ALIASES.items()}
LEVELS = ('easy', 'normal', 'hard')
REQUIRED = ('id', 'category', 'question', 'choices', 'answerIndex', 'explanation', 'difficulty', 'tags')

raw = (os.environ.get('QUIZ_CATEGORY') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''
target = raw.lower() if raw.lower() in CATEGORIES else ALIASES.get(raw)
if raw and target is None:
    print(f"'{raw}'은(는) 카테고리가 아닙니다. 전체를 검사합니다.")
    print('쓸 수 있는 값: ' + ', '.join(f'{k}({c})' for k, c in ALIASES.items()) + '\n')

paths = [f'data/{target}.json'] if target else sorted(glob.glob('data/*.json'))
print(f"검사 대상: {NAMES[target] if target else '전체 카테고리'}\n")

items, defects = [], []
for path in paths:
    cat = os.path.basename(path)[:-5]
    try:
        bank = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        defects.append(f'{path}: 파싱 실패 {e}')
        continue
    for q in bank:
        qid = q.get('id', '?')
        for key in REQUIRED:
            if key not in q or q[key] in (None, '', []):
                defects.append(f'{qid}: 필드 누락/빈값 — {key}')
        ch = q.get('choices') or []
        idx = q.get('answerIndex')
        if len(ch) != 4:
            defects.append(f'{qid}: 보기 {len(ch)}개 (4개여야 함)')
        if len(set(ch)) != len(ch):
            defects.append(f'{qid}: 보기 중복 — {[c for c in ch if ch.count(c) > 1]}')
        if not isinstance(idx, int) or not (0 <= idx < len(ch)):
            defects.append(f'{qid}: answerIndex 범위 밖 ({idx})')
        if q.get('category') != cat:
            defects.append(f'{qid}: category({q.get("category")}) ≠ 파일명({cat})')
        if q.get('difficulty') not in LEVELS:
            defects.append(f'{qid}: difficulty 값 이상 ({q.get("difficulty")})')
        if not re.fullmatch(r'[a-z]+-\d{3}', qid or ''):
            defects.append(f'{qid}: ID 형식이 <카테고리>-<3자리>가 아님')
        items.append(q)

# ID 전역 중복 (범위와 무관하게 항상 본다)
all_ids = [q['id'] for p in sorted(glob.glob('data/*.json')) for q in json.load(open(p, encoding='utf-8'))]
dups = sorted({i for i in all_ids if all_ids.count(i) > 1})
if dups:
    defects.append(f'ID 중복: {dups}')

print(f'■ 기계 검사 — {"이상 없음" if not defects else str(len(defects)) + "건"}')
for d in defects:
    print('   !!', d)

def norm(s):
    return re.sub(r'[^가-힣a-zA-Z0-9]', '', s or '')

print('\n■ 중복·유사 문제 후보')
pairs = []
for i in range(len(items)):
    for j in range(i + 1, len(items)):
        a, b = items[i], items[j]
        r = SequenceMatcher(None, norm(a['question']), norm(b['question'])).ratio()
        same_ans = a['choices'][a['answerIndex']] == b['choices'][b['answerIndex']]
        if r >= 0.55 or same_ans:
            pairs.append((r, same_ans, a['id'], b['id'], a['question'][:26], b['question'][:26]))
if pairs:
    for r, same, ida, idb, qa, qb in sorted(pairs, reverse=True):
        tag = '정답동일' if same else f'유사도 {r:.2f}'
        print(f'   [{ida}] × [{idb}]  {tag}\n      {qa} / {qb}')
else:
    print('   없음')

print(f'\n■ 사실 검증 대상 {len(items)}문항\n')
for q in items:
    ch = q['choices']
    idx = q['answerIndex']
    print(f"[{q['id']}] {q['difficulty']}")
    print(f"  Q. {q['question']}")
    for k, c in enumerate(ch):
        print(f"     {'▶' if k == idx else ' '} {k}. {c}")
    print(f"  해설: {q['explanation']}\n")
PY
```

## 2. 정답 검증

문항마다 아래를 확인한다. `▶` 표시가 현재 정답으로 지정된 보기다.

### 2-1. 지정된 정답이 실제로 맞는가

가장 중요한 항목이다. 질문과 `▶` 보기의 조합이 사실인지 본다.

- **연도·수치·순위**는 특히 틀리기 쉽다. 기억에 의존하지 말고 웹으로 확인한다
- **순위 주장**은 1·2위 격차를 본다. 근소하면 자료마다 갈려 정답이 흔들린다
- **과학적 사실**은 학계 합의가 있는지 본다. 교과 과정 표기와 다르면 짚는다
- 확신이 서지 않으면 `⚠️ 확인 필요`로 남긴다. 넘겨짚어 `정확`으로 표시하지 않는다

### 2-2. 오답 보기 중 정답이 될 만한 것이 없는가

정답이 둘이 되면 문제가 깨진다. 조건이 빠져 오답 보기도 성립하는 경우를 찾는다.
반대로 오답이 너무 허술해 소거법으로 풀리는 경우도 짚는다.

### 2-3. 해설이 정답을 뒷받침하는가

- 해설 안의 연도·수치·고유명사도 검증 대상이다. 문제는 맞는데 해설이 틀린 경우가 있다
- 해설이 문제의 기준과 어긋나지 않는지 본다 (문제는 면적 기준인데 해설은 인구 순위를 말하는 식)
- 문제 문장을 그대로 되풀이하고 있지 않은지 본다

### 2-4. 중복·유사 문제

스크립트가 후보를 뽑아 준다. 정답이 같은 문항 쌍은 실제로 겹치는지 읽고 판단한다.
질문 형태만 다르고 같은 지식을 묻는다면 한쪽을 바꾸도록 제안한다.

## 3. 출력

**문항별 결과**

| ID | 문제 | 정답 | 정확성 | 해설 | 비고 |
| --- | --- | --- | --- | --- | --- |

`정확성` 은 `✅ 정확` / `⚠️ 확인 필요` / `❌ 오류` 셋 중 하나다.
`⚠️` 와 `❌` 는 표 아래에 **무엇이 왜 문제이고 어떻게 고칠지**를 문항별로 적는다.

이어서 이렇게 정리한다.

- **교차 검증한 항목** — 무엇을 어떤 출처로 확인했는지. 확인 결과 값이 달랐다면 그 사실도 적는다
- **중복 의심 쌍** — 스크립트 후보 중 실제로 겹친다고 판단한 것만
- **종합** — 검사 문항 수 / 정확 / 확인 필요 / 오류 / 중복 의심

## 4. 고치기

**지시가 없으면 파일을 건드리지 않는다.** 수정안 제시까지만 한다.
고치라는 지시가 있으면 `data/<카테고리>.json` 을 Edit 로 고친 뒤 이 명령어를 다시 돌려 확인한다.

## 알아둘 것

- 스크립트는 형식만 본다. `정확성` 판정은 전부 읽고 하는 일이다
- 웹 검색은 **의심스러운 것에만** 쓴다. 40문항을 전부 검색하면 오래 걸리고 얻는 것도 적다.
  연도·수치·순위·최신성이 걸린 항목이 대상이다
- ID 중복은 카테고리를 좁혀도 항상 전체를 대상으로 검사한다 (FR-1.8)
- 이 명령어는 정답의 **사실성**을 본다. 최상급 표현의 기준·범위는 `/quiz-validate` 가,
  난이도·분포는 `/quiz-stats` 가 본다
