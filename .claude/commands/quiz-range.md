---
description: 지정한 번호 범위의 문제를 난이도와 정답 분포 관점에서 검토한다
argument-hint: <범위> [카테고리] — 예 "1-20", "1 20 지리", "지리"
allowed-tools: Bash(python3:*), Read
---

`$ARGUMENTS`가 가리키는 문제를 검토해줘.

인자는 한 덩어리로 받아 스크립트가 해석한다. 순서는 상관없고 형태도 가리지 않는다.

| 입력 | 뜻 |
| --- | --- |
| `1-20` · `1~20` · `1 20` | 1번부터 20번까지 |
| `1-20 지리` · `지리 1-20` | 지리 카테고리의 1~20번 |
| `5` | 5번 한 문항 |
| `지리` | 지리 전체 |
| (생략) | 전체 |

번호는 문제 ID의 뒷자리다. `history-003`이면 3번이다. ID는 카테고리마다 따로 매겨지므로
카테고리를 지정하지 않으면 **네 카테고리의 같은 번호대를 한꺼번에** 본다.
`1-3`이면 각 카테고리의 1~3번, 은행이 다 차면 12문항이 된다.

보는 것은 두 가지다.

- **난이도** — `difficulty` 값이 고르게 퍼져 있는가, 값이 실제 체감 난도와 맞는가
- **정답 분포** — 정답 위치가 한쪽으로 쏠렸는가, 정답임을 흘리는 다른 단서가 있는가

`difficulty`는 v1에서 출제에 쓰지 않지만(`CLAUDE.md` 참고) 은행이 커질수록 나중에 손대기 어려워진다.
문제를 쓰는 시점에 균형을 맞춰두는 것이 목적이다.

## 1. 집계

아래를 그대로 실행한다. 인자 해석은 스크립트가 처리하므로 결과를 손으로 추리지 않는다.
집계가 비어 나오면 파싱 결과부터 확인한다. 첫 줄에 무엇을 검토 대상으로 잡았는지 찍힌다.

```bash
QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
import json, glob, os, re
from collections import Counter

CATEGORIES = ('history', 'science', 'geography', 'general')
ALIASES = {'한국사': 'history', '과학': 'science', '지리': 'geography', '일반상식': 'general'}
NAMES = {code: ko for ko, code in ALIASES.items()}
LEVELS = ('easy', 'normal', 'hard')

# ── 인자 파싱 ──────────────────────────────────────────────────
raw = (os.environ.get('QUIZ_ARGS') or '').strip()
# 치환되지 않은 자리표시자가 그대로 오면 인자가 없는 것으로 본다
if re.fullmatch(r'\$\w+', raw):
    raw = ''

text = re.sub(r'[~–—]', '-', raw)
start = end = None

span = re.search(r'(\d+)\s*-\s*(\d+)', text)          # 1-20 형태
if span:
    start, end = int(span.group(1)), int(span.group(2))
    text = text[:span.start()] + ' ' + text[span.end():]
else:                                                  # 1 20 / 5 형태
    nums = re.findall(r'\d+', text)
    if nums:
        start = int(nums[0])
        end = int(nums[1]) if len(nums) > 1 else start
        text = re.sub(r'\d+', ' ', text)

if start and end and start > end:                      # 거꾸로 줘도 받아준다
    start, end = end, start

target, unknown = None, []
for token in [t for t in re.split(r'[\s,]+', text) if t and t != '-']:
    code = token.lower() if token.lower() in CATEGORIES else ALIASES.get(token)
    if code and target is None:
        target = code
    else:
        unknown.append(token)

if unknown:
    print(f"알 수 없는 인자: {', '.join(unknown)}")
    print('쓸 수 있는 형태: 1-20 · 1 20 · 1-20 지리 · 지리 · (생략)')
    print('카테고리: ' + ', '.join(f'{ko}({c})' for ko, c in ALIASES.items()) + '\n')

paths = [f'data/{target}.json'] if target else sorted(glob.glob('data/*.json'))
scope = NAMES[target] if target else '전체 카테고리'
span_label = f'{start}~{end}번' if start else '전체 번호'
print(f'검토 대상: {scope} / {span_label}\n')

# ── 수집 ──────────────────────────────────────────────────────
def number_of(qid):
    hit = re.search(r'-(\d+)$', qid or '')
    return int(hit.group(1)) if hit else None


rows, skipped = [], 0
for path in paths:
    try:
        data = json.load(open(path, encoding='utf-8'))
    except Exception as error:
        print(f'!! 읽기 실패 {path}: {error}')
        continue
    for q in data:
        num = number_of(q.get('id'))
        if num is None:
            skipped += 1
            continue
        if start and not (start <= num <= end):
            continue
        choices = q.get('choices') or []
        idx = q.get('answerIndex')
        correct = choices[idx] if isinstance(idx, int) and 0 <= idx < len(choices) else ''
        others = [c for i, c in enumerate(choices) if i != idx]
        rows.append({
            'id': q.get('id'), 'category': q.get('category'),
            'difficulty': q.get('difficulty'), 'answerIndex': idx,
            'correct_len': len(correct),
            'other_max': max((len(c) for c in others), default=0),
            'other_avg': sum(len(c) for c in others) / len(others) if others else 0,
            'question': q.get('question', ''),
        })

if not rows:
    print('해당 범위에 문제가 없습니다.')
    raise SystemExit

print(f'문항 {len(rows)}개' + (f' (ID 번호 없는 {skipped}개 제외)' if skipped else '') + '\n')

# ── 집계 ──────────────────────────────────────────────────────
print('── 난이도 분포 ──')
diff = Counter(r['difficulty'] for r in rows)
for level in LEVELS:
    n = diff.get(level, 0)
    print(f'  {level:<7} {n:>3}개  {n / len(rows) * 100:5.1f}%  {"█" * n}')
unknown_level = [r for r in rows if r['difficulty'] not in LEVELS]
if unknown_level:
    print(f'  !! 규정 밖 값 {len(unknown_level)}개: '
          + ', '.join(f"{r['id']}={r['difficulty']}" for r in unknown_level))

print('\n── 카테고리별 난이도 ──')
for code in CATEGORIES:
    part = [r for r in rows if r['category'] == code]
    if not part:
        continue
    c = Counter(r['difficulty'] for r in part)
    print(f'  {NAMES[code]:<5} ' + '  '.join(f'{lv} {c.get(lv, 0)}' for lv in LEVELS)
          + f'   (총 {len(part)})')

print('\n── 정답 위치(answerIndex) 분포 ──')
pos = Counter(r['answerIndex'] for r in rows)
for i in range(4):
    n = pos.get(i, 0)
    print(f'  {i}번  {n:>3}개  {n / len(rows) * 100:5.1f}%  {"█" * n}')
spread = max(pos.get(i, 0) for i in range(4)) - min(pos.get(i, 0) for i in range(4))
print(f'  최다-최소 격차: {spread}개')

print('\n── 정답 길이 편향 ──')
longest = [r for r in rows if r['correct_len'] > r['other_max']]
print(f'  정답이 보기 중 가장 긴 문항: {len(longest)}개 / {len(rows)} '
      f'({len(longest) / len(rows) * 100:.0f}%, 무작위 기대 25%)')
for r in longest:
    print(f"    [{r['id']}] 정답 {r['correct_len']}자 vs 오답 최대 {r['other_max']}자 "
          f"· 평균 {r['other_avg']:.1f}자")

print('\n── 문항 목록 ──')
for r in sorted(rows, key=lambda x: (x['category'], x['id'])):
    print(f"  [{r['id']}] {r['difficulty']:<6} 정답 {r['answerIndex']}번 "
          f"· {r['correct_len']}자   {r['question'][:34]}")
PY
```

## 2. 판정

### 난이도

- **값이 스키마를 지키는가** — `easy` / `normal` / `hard` 셋뿐이다. 다른 값이나 누락은 바로 지적한다
- **분포가 한쪽으로 몰렸는가** — 한 등급이 압도적이면 지적한다. 다만 v1 목표는
  "성인이 절반 이상 맞히는 수준"(3-A)이라 `easy`가 많은 것 자체는 문제가 아니다.
  `hard`가 0이면 상위권 변별이 안 된다는 점만 짚어준다
- **선언된 값이 실제와 맞는가** — 문제를 읽고 판단한다. 한국 성인 대다수가 아는 사실인데
  `hard`라면, 반대로 연도·수치를 정확히 외워야 하는데 `easy`라면 어긋난 것이다.
  어긋난 문항은 **제안 등급과 근거**를 함께 적는다

### 정답 분포

- **정답 위치 쏠림** — `answerIndex`가 한쪽에 몰렸는지 본다.
  **다만 실제 플레이에는 영향이 없다.** `sampler.shuffleChoices()`가 매 판 보기 순서를 섞고
  정답 인덱스를 새 위치로 옮기기 때문이다(`CLAUDE.md`). 그러니 쏠림을 발견해도
  "지금 당장 플레이어가 찍어 맞힐 수 있다"고 쓰면 틀린 말이다.
  작성 습관을 드러내는 신호이자 셔플이 사라졌을 때의 대비로만 보고한다
- **정답 길이 편향** — 이건 셔플로도 가려지지 않는다. 정답만 유독 길면 위치와 무관하게 티가 난다(3-A).
  무작위라면 25% 근처여야 한다. 뚜렷이 높으면 해당 문항의 오답 보기를 늘리라고 제안한다
- **그 밖의 흘림** — 정답만 표현이 구체적이거나("1446년" vs "조선 초"), 오답 셋이 서로 닮았는데
  정답만 결이 다르면 짚는다. 이건 목록을 읽고 판단한다

## 3. 출력

집계 숫자를 그대로 옮기지 말고 **판정을 붙여서** 낸다. 순서는 이렇다.

1. 검토 대상과 문항 수 한 줄. 인자를 다르게 해석했으면 그 사실을 먼저 밝힌다
2. **난이도** — 분포 표와 한 줄 평. 등급이 어긋난 문항은 아래 표로

   | ID | 문제 | 현재 | 제안 | 근거 |
   | --- | --- | --- | --- | --- |

3. **정답 분포** — 위치 분포와 길이 편향. 쏠림이 있으면 셔플 때문에 실제 영향은 없다는 점을 함께 적는다
4. 손댈 것이 있으면 문항별 제안. 없으면 "손댈 것 없음"이라고 분명히 쓴다

마지막에 한 줄로 정리한다: 검토 대상, 문항 수, 난이도 지적 수, 정답 분포 지적 수.

고치라는 지시가 없으면 파일은 건드리지 말고 제안까지만 한다.

## 알아둘 것

- 번호는 **ID 뒷자리**다. 파일 안의 순서나 출제 순서가 아니다
- 카테고리를 지정하지 않으면 네 카테고리의 같은 번호대를 함께 본다
- 인자는 통째로 받아 스크립트가 해석한다. 위치 인자(첫째·둘째 자리)로 쪼개 받으면
  치환이 어긋났을 때 조용히 엉뚱한 범위를 보게 된다. 실제로 그런 적이 있어 이 방식으로 바꿨다.
  이 문단에 자리표시자를 그대로 적으면 실행할 때 인자값으로 바뀌어 문장이 깨지므로 풀어 썼다
- 알 수 없는 토큰이 섞이면 안내를 찍고 나머지로 진행한다. 멈추지 않는다
- 정답 위치 쏠림은 **런타임 셔플로 상쇄된다.** 이 사실을 빼고 보고하면 없는 버그를 만드는 셈이다
- 난이도 적정성은 사람이 읽어야 판단된다. 스크립트는 선언된 값만 센다
