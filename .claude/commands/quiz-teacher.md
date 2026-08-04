---
description: 선생님 모드 통합. 수집 → 반 현황 → 비교 → 관심 학생을 순서대로 돌려 하나의 브리핑을 만든다
argument-hint: [카테고리] — 예 "지리", 생략하면 전체
allowed-tools: Bash(python3:*), Read
---

선생님 모드를 한 번에 돌려줘. 아래를 순서대로 밟고 **하나의 브리핑으로 종합**한다.

| 단계 | 내용 | 실패 시 |
| --- | --- | --- |
| 1 | 제출물 수집·검증 | **중단** |
| 2 | 반 전체 현황 | 중단 |
| 3 | 학생 비교와 순위 | 중단 |
| 4 | 관심 학생 상세 | 건너뛰고 계속 |
| 5 | 종합 브리핑 | — |

**1단계가 실패하면 그 자리에서 멈춘다.** 읽을 기록이 없으면 나머지가 전부 무의미하다.
그때는 학생에게 줄 내보내기 안내를 함께 제시한다 (`/quiz-teacher-collect` 참고).

인자로 카테고리를 주면 3단계 순위를 그 분야 기준으로 매긴다.

## 1~3단계 — 수집 · 현황 · 비교

한 번에 실행한다.

```bash
QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
# ── 제출물 로더 (선생님 모드 공통) ────────────────────────────────
# 학생이 브라우저에서 내보낸 기록을 teacher/submissions/ 에서 읽는다.
# 앱은 서버가 없어 기록이 각 학생 브라우저에만 남는다 (PRD 9.1).
import json, glob, os, re, sys
from collections import defaultdict

SUB_DIR = 'teacher/submissions'
MODES = ('category', 'all')
CATEGORIES = ('history', 'science', 'geography', 'general')
KO = {'history': '한국사', 'science': '과학', 'geography': '지리', 'general': '일반상식'}
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

# ── 등급 규칙 ──────────────────────────────────────────────────
# 정의는 /create-report 에 있다. 여기서는 그 규칙을 그대로 따른다.
# 값을 고칠 일이 있으면 두 파일을 함께 고쳐야 한다.
CUTS = ((0.20, 'A'), (0.40, 'B'), (0.70, 'C'))
EPS = 1e-9


def grade_of(ratio):
    for cut, g in CUTS:
        if ratio <= cut + EPS:
            return g
    return 'D'


def assign(pairs):
    """[(값, 이름)] → ({이름: 등급}, {이름: 순위}, {이름: 상위비율}). 동점은 같은 등급."""
    n = len(pairs)
    rank, prev = 0, None
    grades, ranks, ratios = {}, {}, {}
    for i, (v, name) in enumerate(sorted(pairs, key=lambda x: -x[0]), 1):
        if prev is None or v != prev:
            rank, prev = i, v
        ranks[name] = rank
        ratios[name] = rank / n
        grades[name] = grade_of(rank / n)
    return grades, ranks, ratios


# ── 통합 실행 ──────────────────────────────────────────────────
records, problems = load()

print('━━━ 1단계 · 제출물 수집 ━━━')
ignored = os.path.exists('.gitignore') and re.search(
    r'^teacher/submissions/?\s*$', open('.gitignore', encoding='utf-8').read(), re.M)
print(f'  .gitignore 제외: {"예" if ignored else "!! 아니오 — 학생 이름과 성적이 커밋될 수 있습니다"}')
for p in problems:
    print('   !!', p)
if not records:
    print('\n!! 쓸 수 있는 기록이 없습니다. 여기서 중단합니다.')
    print('   학생에게 내보내기 안내를 전달하세요 (/quiz-teacher-collect 의 "학생에게 줄 안내").')
    sys.exit(1)

students = by_student(records)
print(f'  학생 {len(students)}명 · 응시 {len(records)}건')
missing = [n for n, rows in students.items()
           if {r['category'] for r in rows if r['mode'] == 'category'} != set(CATEGORIES)]
if missing:
    print(f'  네 카테고리를 다 풀지 않은 학생: {", ".join(missing)}')

print('\n━━━ 2단계 · 반 전체 현황 ━━━')
accs = [r['accuracy'] for r in records]
s = sorted(accs)
print(f'  정답률  최저 {pct(s[0])} · 중앙 {pct(s[len(s)//2])} · 평균 {pct(sum(s)/len(s))} · 최고 {pct(s[-1])}')
cat_rows = [r for r in records if r['mode'] == 'category']
print('\n  분야별 반 평균')
weak = []
for c in CATEGORIES:
    rows = [r for r in cat_rows if r['category'] == c]
    if not rows:
        print(f'    {KO[c]:<7}{"미응시":>8}')
        continue
    m = sum(r['accuracy'] for r in rows) / len(rows)
    weak.append((m, c))
    print(f'    {KO[c]:<7}{pct(m):>8}  {bar(m)}')
if weak:
    weak.sort()
    print(f'    → 가장 약한 분야: {KO[weak[0][1]]} ({pct(weak[0][0])})')

print('\n━━━ 3단계 · 비교와 순위 ━━━')
want = None
for t in [t for t in re.split(r'[\s,]+', (os.environ.get('QUIZ_ARGS') or '').strip()) if t]:
    if resolve_category(t):
        want = resolve_category(t)

table, rows_cache = [], {}
for name, rows in students.items():
    cells, vals = [], []
    for c in CATEGORIES:
        rs = [r for r in rows if r['mode'] == 'category' and r['category'] == c]
        if rs:
            a = max(r['accuracy'] for r in rs); cells.append(pct(a)); vals.append(a)
        else:
            cells.append('-')
    alls = [r for r in rows if r['mode'] == 'all']
    acell = pct(max(r['accuracy'] for r in alls)) if alls else '-'
    mean = sum(vals) / len(vals) if vals else 0
    table.append((mean, name))
    rows_cache[name] = (cells, acell, mean)

grades, ranks, ratios = assign(table)
print(f"  {'등급':<4}{'학생':<8}" + ''.join(f'{KO[c]:>8}' for c in CATEGORIES) + f"{'전체도전':>9}{'평균':>7}")
for mean, name in sorted(table, key=lambda x: -x[0]):
    cells, acell, _ = rows_cache[name]
    print(f'  {grades[name]:<4}{name:<8}' + ''.join(f'{x:>8}' for x in cells) + f'{acell:>9}{pct(mean):>7}')
print('  등급: 상위 20% A · 40% B · 70% C · 나머지 D (동점은 같은 등급, /create-report 와 같은 규칙)')

if want:
    pool = [(max(r['accuracy'] for r in students[n] if r['mode'] == 'category' and r['category'] == want), n)
            for n in students
            if any(r['mode'] == 'category' and r['category'] == want for r in students[n])]
    label = KO[want]
else:
    pool = [(m, n) for m, n in table]
    label = '카테고리 평균'
pool.sort(reverse=True)
print(f'\n  순위 (기준: {label}) — 동점은 같은 순위')
prev, rank = None, 0
for i, (acc, name) in enumerate(pool, 1):
    if acc != prev:
        rank, prev = i, acc
    g = grades.get(name, grade_of(rank / len(pool)))
    print(f'   {rank:>2}위  {g}  {name:<8}{pct(acc):>7}  {bar(acc)}')

print('\n━━━ 4단계 · 관심 학생 ━━━')
means = sorted(table)
watch = [n for m, n in means[:2]]
spread = []
for name, rows in students.items():
    vals = [r['accuracy'] for r in rows if r['mode'] == 'category']
    if len(vals) >= 2 and max(vals) - min(vals) >= 0.30:
        spread.append((max(vals) - min(vals), name))
spread.sort(reverse=True)
print(f'  평균이 낮은 학생: {", ".join(watch)}')
print(f'  편차가 큰 학생: {", ".join(n for _, n in spread) or "없음"}')

klass = {c: sum(r['accuracy'] for r in cat_rows if r['category'] == c) /
            max(1, len([r for r in cat_rows if r['category'] == c])) for c in CATEGORIES}
for name in dict.fromkeys(watch + [n for _, n in spread]):
    rows = students[name]
    print(f'\n  · {name}')
    gaps = []
    for c in CATEGORIES:
        rs = [r for r in rows if r['mode'] == 'category' and r['category'] == c]
        if not rs:
            continue
        mine = max(r['accuracy'] for r in rs)
        gaps.append((mine - klass[c], c, mine))
    gaps.sort()
    for diff, c, mine in gaps:
        mark = '약함' if diff <= -0.10 else ('강함' if diff >= 0.10 else '평균권')
        print(f'      {KO[c]:<7}{pct(mine):>6}  반 평균 대비 {diff*100:+4.0f}%p  {mark}')
PY
```

## 3단계 — 등급은 어디서 오나

대시보드가 보여주는 **A~D 등급의 분류 규칙은 `/create-report` 가 정의한다.**
이 명령어는 그 규칙을 그대로 따라 쓴다.

| 등급 | 기준 |
| --- | --- |
| A | 상위 20% 이내 |
| B | 상위 40% 이내 |
| C | 상위 70% 이내 |
| D | 나머지 (하위 30%) |

**동점은 같은 등급이다.** 경계에 동점자가 걸리면 모두 위 등급을 준다.
산정 값은 카테고리별 최고 기록의 평균 정답률이다.

**규칙 값을 바꿀 일이 생기면 `/create-report` 와 이 파일을 함께 고친다.**
한쪽만 고치면 같은 학생이 두 명령어에서 다른 등급을 받는다.

성적표 형태로 발급하려면 `/create-report` 를 쓴다. 분야별 등급과 학생별 카드까지 나온다.
대시보드는 반 전체를 한눈에 보는 용도라 종합 등급만 붙인다.

**등급은 상대 평가다.** 반 전체가 잘해도 누군가는 D 를 받는다. 절대 실력을 뜻하지 않으므로
등급 옆의 정답률을 반드시 함께 읽는다.

## 4단계 판정 — 누구를 볼 것인가

스크립트가 두 갈래로 후보를 뽑는다.

- **평균이 낮은 학생** — 전반적으로 처지는 경우. 기초부터 볼 필요가 있다
- **편차가 큰 학생** — 분야 간 격차가 30%p 이상. 특정 분야만 비어 있는 경우라 보강으로 해결된다

둘은 처방이 다르다. 섞어서 "공부를 더 해야 한다"로 뭉뚱그리지 않는다.

더 자세히 볼 학생이 있으면 `/quiz-teacher-student <이름>` 으로 따로 들어간다.

## 5단계 — 종합 브리핑

앞의 출력을 그대로 이어붙이지 말고 **선생님이 읽고 바로 판단할 수 있게** 다시 쓴다.

1. **오늘의 한 줄** — 학생 수, 참여 상태, 가장 중요한 발견 하나
2. **반 전체** — 수준이 고른지 갈렸는지, 가장 약한 분야와 그 이유에 대한 판단
3. **눈여겨볼 학생** — 이름과 함께 **무엇을 어떻게 도울지.** 평균이 낮은 경우와 편차가 큰 경우를 구분한다
4. **다음 수업 제안** — 구체적으로. 어느 분야를 어떤 방식으로
5. **데이터의 한계** — 아래를 반드시 밝힌다

## 반드시 밝힐 한계

- **제출한 학생만 보인다.** 안 낸 학생은 데이터에 없다. 반 전체 평균이 아니라 제출자 평균이다
- **문항별로 무엇을 틀렸는지 알 수 없다.** 앱이 한 판의 요약만 저장한다.
  "어느 문제를 반의 몇 %가 틀렸다"는 분석은 앱을 고쳐야 가능하다
- **표본이 작으면 순위가 한두 문항으로 뒤집힌다.** 학생이 열 명 미만이면 단정하지 않는다
- **소요 시간은 평가에 쓰지 않는다.** 곱씹을 시간을 보장한다는 설계 원칙(PRD 2.1)과 충돌한다
- **분야별 평균이 낮다고 학생이 약한 것은 아니다.** 그 분야에 `hard` 문항이 몰렸을 수 있다.
  `/quiz-stats` 로 난이도 분포를 확인해 구분한다

## 알아둘 것

- 이 명령어는 **읽기만 한다.** 제출 파일도 문제 은행도 고치지 않는다
- `teacher/submissions/` 는 개인정보다. `.gitignore` 에 넣는다. 스크립트가 확인해 경고한다
- 단계별로 따로 보려면 `/quiz-teacher-collect` · `/quiz-teacher-report` ·
  `/quiz-teacher-compare` · `/quiz-teacher-student` 를 쓴다
