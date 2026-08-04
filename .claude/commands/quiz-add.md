---
description: 지정한 카테고리와 난이도로 새 문제를 작성해 문제 은행에 추가한다
argument-hint: <카테고리> <난이도> [개수] [주제] — 예 "한국사 어려움", "science hard 2 원소"
allowed-tools: Bash(python3:*), Read, Edit
---

`$1` 카테고리에 난이도 `$2`인 새 문제를 만들어 추가해줘.

- **카테고리** — `한국사`·`과학`·`지리`·`일반상식` 또는 영문 코드
- **난이도** — `쉬움`(easy)·`보통`(normal)·`어려움`(hard)
- 뒤에 숫자를 붙이면 그 개수만큼(최대 10), 없으면 1문항
- 그 밖의 낱말은 주제 힌트로 쓴다 (예: `한국사 어려움 고려시대`)

이 명령어는 **파일을 고친다.** 앞의 검증 명령어들과 달리 결과가 남으므로,
쓰기 전에 규칙을 지켰는지 확인하고 쓴 뒤에 검증까지 마친다.

## 1. 컨텍스트 수집

먼저 아래를 실행한다. 다음 ID, 기존 문항, 현재 분포를 알아야 중복과 쏠림을 피할 수 있다.

```bash
QUIZ_CAT="$1" QUIZ_LEVEL="$2" QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
import json, os, re
from collections import Counter

CATEGORIES = ('history', 'science', 'geography', 'general', 'art')
ALIASES = {'한국사': 'history', '과학': 'science', '지리': 'geography',
           '일반상식': 'general', '예술과문화': 'art'}
NAMES = {code: ko for ko, code in ALIASES.items()}
LEVELS = ('easy', 'normal', 'hard')
LEVEL_ALIASES = {'쉬움': 'easy', '보통': 'normal', '어려움': 'hard',
                 '중간': 'normal', 'medium': 'normal',
                 '초급': 'easy', '중급': 'normal', '상급': 'hard'}


def env(name):
    value = (os.environ.get(name) or '').strip()
    return '' if re.fullmatch(r'\$\w+', value) else value   # 치환 안 된 자리표시자는 무시


def as_category(token):
    return token.lower() if token.lower() in CATEGORIES else ALIASES.get(token.lower())


def as_level(token):
    return token.lower() if token.lower() in LEVELS else LEVEL_ALIASES.get(token.lower())


cat_arg, level_arg, rest = env('QUIZ_CAT'), env('QUIZ_LEVEL'), env('QUIZ_ARGS')
category, level = as_category(cat_arg), as_level(level_arg)

# 위치 인자가 비었거나 어긋나면 인자 전체에서 다시 찾는다
leftovers = []
for token in [t for t in re.split(r'[\s,]+', rest) if t]:
    if category is None and as_category(token):
        category = as_category(token)
    elif level is None and as_level(token):
        level = as_level(token)
    elif as_category(token) or as_level(token):
        continue
    else:
        leftovers.append(token)

count = 1
for token in list(leftovers):
    if token.isdigit():
        count = max(1, min(int(token), 10))
        leftovers.remove(token)
topic = ' '.join(leftovers)

if category is None:
    print('!! 카테고리를 알 수 없습니다. 첫 인자로 주세요.')
    print('   ' + ', '.join(f'{ko}({c})' for ko, c in ALIASES.items()))
    raise SystemExit(1)
if level is None:
    print('!! 난이도를 알 수 없습니다. 둘째 인자로 주세요.')
    print('   쉬움(easy), 보통(normal), 어려움(hard)')
    raise SystemExit(1)

path = f'data/{category}.json'
try:
    bank = json.load(open(path, encoding='utf-8'))
except Exception as error:
    print(f'!! {path} 읽기 실패: {error}')
    raise SystemExit(1)

nums = [int(m.group(1)) for q in bank if (m := re.search(r'-(\d+)$', q.get('id', '')))]
next_num = max(nums, default=0) + 1

print(f'추가 대상: {NAMES[category]} ({category}) / 난이도 {level} / {count}문항')
print(f'파일: {path}   현재 {len(bank)}문항')
print('다음 ID: ' + ', '.join(f'{category}-{n:03d}' for n in range(next_num, next_num + count)))
if topic:
    print(f'주제 힌트: {topic}')

print('\n── 기존 문항 (주제 중복 방지) ──')
for q in bank:
    tags = ', '.join(q.get('tags') or [])
    print(f"  [{q.get('id')}] {q.get('difficulty', '?'):<6} {q.get('question', '')[:38]}   태그: {tags}")

print('\n── 현재 분포 ──')
diff = Counter(q.get('difficulty') for q in bank)
print('  난이도   ' + ' · '.join(f'{lv} {diff.get(lv, 0)}' for lv in LEVELS))
pos = Counter(q.get('answerIndex') for q in bank)
print('  정답위치 ' + ' · '.join(f'{i}번 {pos.get(i, 0)}' for i in range(4)))
unused = [str(i) for i in range(4) if pos.get(i, 0) == 0]
if unused:
    print(f'  → 아직 안 쓴 정답 위치: {", ".join(unused)}번')

print('\n── 이 카테고리에서 쓴 태그 ──')
tag_count = Counter(t for q in bank for t in (q.get('tags') or []))
print('  ' + (', '.join(f'{t}({n})' for t, n in tag_count.most_common()) or '(없음)'))
PY
```

카테고리나 난이도를 못 알아들으면 스크립트가 멈춘다. 그때는 임의로 정하지 말고 사용자에게 되묻는다.

## 2. 문제 작성

`CLAUDE.md`의 **문제 작성 규칙 다섯 가지를 문항마다 통과시킨다.** 하나라도 걸리면 그 문제는 쓰지 않는다.

1. **정답이 하나뿐인가** — 다른 해석이 가능하면 조건을 문장에 넣는다
2. **최상급 표현에 기준이 있는가** — `가장 큰`은 면적인지 인구인지 밝힌다.
   `/quiz-validate`가 나중에 잡아낼 것을 미리 막는다
3. **시간과 범위가 명확한가** — 변하는 정보는 시점을, 비교는 지리적·분류적 범위를 한정한다
4. **교차 검증했는가** — 연도·수치·순위는 출처 두 곳 이상에서 확인한다.
   1·2위 격차가 근소한 순위는 아예 피한다
5. **확신이 서는가** — 서지 않으면 **넣지 말고**, 작업 끝에 "검증이 필요한 문제"로 따로 보고한다

여기에 `docs/quiz-game-claude-code-prompts.md` 3-A의 품질 기준을 더한다.

- 오답 보기 셋도 그럴듯해야 한다. 명백히 말이 안 되는 보기는 넣지 않는다
- **보기 넷의 길이를 비슷하게 맞춘다.** 정답만 유독 길면 셔플로도 안 가려진다
- 해설은 1~2문장. 정답인 이유를 설명하되 문제 문장을 그대로 반복하지 않는다
- `difficulty`와 `tags`를 채운다. 태그는 기존에 쓰던 것을 재사용해 갈래가 흩어지지 않게 한다

### 난이도를 실제로 맞춘다

인자로 받은 등급은 **라벨이 아니라 목표다.** 라벨만 붙이고 내용이 따라가지 않으면 안 된다.

| 등급 | 기준 |
| --- | --- |
| `easy` | 한국 성인 대다수가 바로 답한다. 함정 없음 |
| `normal` | 알 만한 사람은 안다. 헷갈리는 오답이 하나쯤 섞인다 |
| `hard` | 연도·수치·개념 구분을 정확히 알아야 갈린다. 다만 찍기 문제로 가면 안 된다 |

요청받은 등급으로 **논쟁 없는 사실만 써서** 문제를 만들 수 없으면, 억지로 만들지 말고
왜 어려운지 말한 뒤 다른 주제를 제안한다.

### 정답 위치

`answerIndex`를 한쪽에 몰지 말고 스크립트가 알려준 "아직 안 쓴 위치"를 우선 쓴다.
실제 플레이에는 영향이 없지만(`sampler.shuffleChoices()`가 매 판 섞는다) 데이터 위생 문제다.

## 3. 파일에 추가

`data/<카테고리>.json` 배열 끝에 덧붙인다. **키 순서와 서식을 기존 문항과 똑같이 맞춘다.**

```json
  {
    "id": "history-004",
    "category": "history",
    "question": "...",
    "choices": ["...", "...", "...", "..."],
    "answerIndex": 0,
    "explanation": "...",
    "difficulty": "hard",
    "tags": ["...", "..."]
  }
```

- ID는 스크립트가 알려준 다음 번호를 쓴다. **기존 ID는 절대 재사용하지 않는다** (FR-1.8)
- `category` 값은 파일명과 같아야 한다
- 들여쓰기 2칸, `choices`는 한 줄

**Edit로 덧붙인다.** `json.dump`로 파일을 통째로 다시 쓰면 안 된다 —
기본값이 `ensure_ascii=True`라 한글이 전부 `\uXXXX`로 바뀌고, 기존 서식도 무너진다.

## 4. 검증

쓴 뒤에 반드시 확인한다. 하나라도 걸리면 고치고 다시 돌린다.

```bash
for f in data/*.json; do
  python3 -c "import json;d=json.load(open('$f'));print('$f',len(d),'OK' if all(0<=q['answerIndex']<len(q['choices'])==4 for q in d) else 'FAIL')"
done
python3 -c "
import json,glob,collections
ids=[q['id'] for f in sorted(glob.glob('data/*.json')) for q in json.load(open(f))]
dup=[k for k,v in collections.Counter(ids).items() if v>1]
print('총',len(ids),'문제 / ID 중복:',dup or '없음')
"
```

- JSON이 파싱되는가, 보기가 4개인가, `answerIndex`가 실제 정답을 가리키는가
- ID 중복이 없는가 (카테고리를 넘나들며)
- 이어서 `/quiz-validate <카테고리>`로 최상급 표현에 기준이 붙었는지 확인한다
- `/quiz-range`로 난이도·정답 분포가 의도대로 움직였는지 확인한다

## 5. 보고

- 추가한 문항을 ID·문제·정답·난이도로 요약한다
- 규칙에 걸려 **버린 후보가 있으면 왜 버렸는지** 밝힌다. 조용히 빼면 같은 주제를 다음에 또 시도하게 된다
- **확신이 서지 않는 문항은 "검증이 필요한 문제"로 따로 목록화한다.** 규칙 5번이다
- 검증 스크립트 결과를 그대로 옮기지 말고 통과 여부만 한 줄로 정리한다

## 알아둘 것

- 문제 추가는 **JSON만 고치면 된다.** 코드는 손대지 않는다. 코드를 고쳐야 한다면 설계가 틀어진 것이다
- `QUESTIONS_PER_ROUND`(10)는 은행 크기와 무관한 상수다. 문제를 늘려도 코드 수정 없이 출제 수가 유지된다
- `difficulty`와 `tags`는 v1에서 출제에 쓰지 않지만 스키마에 넣는다. 나중에 일괄 수정을 피하려는 것이다
- 카테고리·난이도를 못 알아들으면 되묻는다. 짐작해서 엉뚱한 파일에 쓰면 되돌리기 번거롭다
