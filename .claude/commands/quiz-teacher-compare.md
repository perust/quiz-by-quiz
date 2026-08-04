---
description: 학생들의 성적을 나란히 비교하고 순위를 매긴다
argument-hint: [학생 이름들] [카테고리] — 예 "김민준 박지호", "지리", 생략하면 전체
allowed-tools: Bash(python3:*), Read
---

학생들의 성적을 나란히 비교해줘.

인자로 학생 이름을 주면 그 학생들만, 카테고리를 주면 그 분야 기준으로 순위를 매긴다.
둘 다 없으면 전체 학생을 카테고리 평균으로 비교한다. 순서는 상관없다.

| 입력 | 뜻 |
| --- | --- |
| (생략) | 전체 학생, 카테고리 평균 기준 |
| `김민준 박지호` | 두 학생만 비교 |
| `지리` | 전체 학생, 지리 기준 순위 |
| `지리 김민준 박지호` | 두 학생을 지리 기준으로 |

## 1. 집계

```bash
QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
# ── 제출물 로더 (선생님 모드 공통) ────────────────────────────────
# 학생이 브라우저에서 내보낸 기록을 teacher/submissions/ 에서 읽는다.
# 앱은 서버가 없어 기록이 각 학생 브라우저에만 남는다 (PRD 9.1).
import json, glob, os, re, sys
from collections import defaultdict

SUB_DIR = 'teacher/submissions'
MODES = ('category', 'all')
CATEGORIES = ('history', 'science', 'geography', 'general', 'art')
KO = {'history': '한국사', 'science': '과학', 'geography': '지리',
      'general': '일반상식', 'art': '예술과문화'}
ALIASES = {v: k for k, v in KO.items()}


def _valid(r):
    return (isinstance(r, dict)
            and isinstance(r.get('nickname'), str) and r['nickname'].strip()
            and r.get('mode') in MODES
            and all(isinstance(r.get(k), (int, float)) and not isinstance(r.get(k), bool)
                    for k in ('score', 'correctCount', 'totalCount'))
            and r.get('totalCount')
            and isinstance(r.get('playedAt'), str))


def load(strict=True):
    """teacher/submissions/*.json → (records, problems). records 는 정규화된 딕셔너리 목록."""
    problems, records = [], []
    if not os.path.isdir(SUB_DIR):
        problems.append(f'{SUB_DIR} 폴더가 없습니다')
        return records, problems

    files = sorted(glob.glob(os.path.join(SUB_DIR, '*.json')))
    if not files:
        problems.append(f'{SUB_DIR} 에 제출 파일(.json)이 없습니다')
        return records, problems

    for path in files:
        base = os.path.basename(path)
        try:
            data = json.load(open(path, encoding='utf-8'))
        except Exception as e:
            problems.append(f'{base}: JSON 파싱 실패 — {e}')
            continue

        # 배열이면 파일명을 학생 이름으로, 객체면 student 필드를 쓴다
        if isinstance(data, list):
            student, rows = os.path.splitext(base)[0], data
        elif isinstance(data, dict):
            student = (data.get('student') or os.path.splitext(base)[0]).strip()
            rows = data.get('records')
            if not isinstance(rows, list):
                problems.append(f'{base}: records 가 배열이 아닙니다')
                continue
        else:
            problems.append(f'{base}: 최상위가 배열도 객체도 아닙니다')
            continue

        kept = 0
        for r in rows:
            if not _valid(r):
                problems.append(f'{base}: 형식이 맞지 않는 기록 1건 (건너뜀)')
                continue
            cat = r.get('category')
            records.append({
                'student': student,
                'file': base,
                'nickname': r['nickname'],
                'mode': r['mode'],
                'category': None if r['mode'] == 'all' else cat,
                'score': int(r['score']),
                'correct': int(r['correctCount']),
                'total': int(r['totalCount']),
                'accuracy': int(r['correctCount']) / int(r['totalCount']),
                'durationMs': int(r.get('durationMs') or 0),
                'playedAt': r['playedAt'],
            })
            kept += 1
        if kept == 0:
            problems.append(f'{base}: 쓸 수 있는 기록이 없습니다')

    # 같은 학생의 완전히 같은 응시가 중복 제출된 경우 하나로 본다
    seen, unique = set(), []
    for r in records:
        key = (r['student'], r['playedAt'], r['mode'], r['category'], r['score'])
        if key in seen:
            continue
        seen.add(key)
        unique.append(r)
    dropped = len(records) - len(unique)
    if dropped:
        problems.append(f'중복 제출 {dropped}건을 하나로 합쳤습니다')

    return unique, problems


def by_student(records):
    d = defaultdict(list)
    for r in records:
        d[r['student']].append(r)
    for rows in d.values():
        rows.sort(key=lambda x: x['playedAt'])
    return dict(sorted(d.items()))


def resolve_category(token):
    t = (token or '').strip()
    return t.lower() if t.lower() in CATEGORIES else ALIASES.get(t)


def pct(x):
    return f'{x * 100:.0f}%'


def bar(ratio, width=16):
    return '█' * round(max(0.0, min(1.0, ratio)) * width)

# ── 비교와 순위 ─────────────────────────────────────────────────
records, problems = load()
if not records:
    print('!! 제출물이 없습니다. 먼저 /quiz-teacher-collect 를 확인하세요.')
    sys.exit(1)

students = by_student(records)
raw = (os.environ.get('QUIZ_ARGS') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''
tokens = [t for t in re.split(r'[\s,]+', raw) if t]

want_cat = None
picked = []
unknown = []
for t in tokens:
    c = resolve_category(t)
    if c:
        want_cat = c
    elif t in students:
        picked.append(t)
    else:
        unknown.append(t)
if unknown:
    print(f'  명단에 없는 이름: {", ".join(unknown)}')
    print(f'  명단: {", ".join(students)}\n')
targets = picked or list(students)

print(f'■ 비교 대상 — {len(targets)}명' + (f' / {KO[want_cat]}' if want_cat else ' / 전체'))

print('\n■ 카테고리별 정답률')
header = f"  {'학생':<8}" + ''.join(f'{KO[c]:>8}' for c in CATEGORIES) + f"{'전체도전':>9}{'평균':>7}"
print(header)
table = []
for name in targets:
    rows = students[name]
    cells, vals = [], []
    for c in CATEGORIES:
        rs = [r for r in rows if r['mode'] == 'category' and r['category'] == c]
        if rs:
            a = max(r['accuracy'] for r in rs)
            cells.append(pct(a)); vals.append(a)
        else:
            cells.append('-')
    alls = [r for r in rows if r['mode'] == 'all']
    acell = pct(max(r['accuracy'] for r in alls)) if alls else '-'
    mean = sum(vals) / len(vals) if vals else 0
    table.append((mean, name, cells, acell))
    print(f'  {name:<8}' + ''.join(f'{c:>8}' for c in cells) + f'{acell:>9}{pct(mean):>7}')

print('\n■ 순위')
if want_cat:
    pool = [(max(r['accuracy'] for r in students[n] if r['mode'] == 'category' and r['category'] == want_cat),
             max(r['score'] for r in students[n] if r['mode'] == 'category' and r['category'] == want_cat), n)
            for n in targets
            if any(r['mode'] == 'category' and r['category'] == want_cat for r in students[n])]
    label = KO[want_cat]
else:
    pool = [(m, round(m * 100), n) for m, n, _, _ in table]
    label = '카테고리 평균'
pool.sort(reverse=True)
print(f'  기준: {label}')
prev, rank = None, 0
for i, (acc, score, name) in enumerate(pool, 1):
    if acc != prev:
        rank = i
        prev = acc
    print(f'  {rank:>2}위  {name:<8}{pct(acc):>7}   {bar(acc)}')

print('\n■ 분야별 최고·최저')
for c in CATEGORIES:
    vals = []
    for n in targets:
        rs = [r for r in students[n] if r['mode'] == 'category' and r['category'] == c]
        if rs:
            vals.append((max(r['accuracy'] for r in rs), n))
    if len(vals) < 2:
        continue
    vals.sort()
    print(f'  {KO[c]:<7} 최고 {vals[-1][1]}({pct(vals[-1][0])})   최저 {vals[0][1]}({pct(vals[0][0])})   격차 {pct(vals[-1][0] - vals[0][0])}')
PY
```

명단에 없는 이름을 주면 알려주고 나머지로 진행한다. 멈추지 않는다.

## 2. 판정

**같은 학생의 같은 과제가 여러 번이면 최고 기록을 쓴다.** 재응시로 나아진 것을 인정하는 편이
학습 동기에 맞는다. 향상 폭 자체는 `/quiz-teacher-report` 가 따로 본다.

**동점 처리** — 정답률이 같으면 같은 순위로 묶는다. 앱의 랭킹(FR-6.3)은 먼저 달성한 순으로 가르지만,
그건 게임의 순위 규칙이고 학습 평가에서 먼저 푼 사람을 위로 두는 것은 근거가 없다.

**격차를 짚는다.** 분야별 최고·최저 격차가 크면 그 분야에서 학생 간 편차가 크다는 뜻이다.
반 전체를 한 수준으로 가르치기 어렵다는 신호다.

**미응시를 순위로 오해하지 않는다.** `-` 는 아직 풀지 않은 것이지 0점이 아니다.

## 3. 출력

1. **비교 대상** — 몇 명, 어느 기준
2. **카테고리별 표** — 그대로 옮기되 눈에 띄는 칸을 짚어준다
3. **순위** — 동점은 같은 순위로. 격차가 근소하면 그 사실을 밝힌다
4. **분야별 격차** — 가장 벌어진 분야와 그 의미
5. **짝지어 볼 만한 학생** — 서로 강약이 엇갈리는 조합이 있으면 제안한다.
   한 명이 강한 분야를 다른 한 명이 약하면 짝 활동에 쓸 수 있다

## 알아둘 것

- **순위를 학생에게 그대로 보여줄 필요는 없다.** 이 명령어는 선생님이 판단하려고 보는 것이다
- 소요 시간은 비교에 넣지 않는다 (PRD 2.1)
- 표본이 작으면 순위가 한두 문항으로 뒤집힌다. 그 사실을 밝히고 단정하지 않는다
