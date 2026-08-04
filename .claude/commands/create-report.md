---
description: 학생 성적표를 발급한다. 등급은 상위 비율 기준 상대 평가
argument-hint: (인자 없음)
allowed-tools: Bash(python3:*), Read
---

학생 성적표를 만들어줘. 등급은 **상위 비율 기준 상대 평가**다.

## 등급 기준

| 등급 | 기준 |
| --- | --- |
| **A** | 상위 20% 이내 |
| **B** | 상위 40% 이내 |
| **C** | 상위 70% 이내 |
| **D** | 나머지 (하위 30%) |

**동점은 같은 등급이다.** 경계에 동점자가 걸리면 모두 위 등급을 준다. 같은 성적인데
등급이 갈리는 일을 막기 위해서다. 그래서 실제 인원 비율은 표의 값과 조금 달라진다.

등급을 매기는 값은 **카테고리별 최고 기록의 평균 정답률**이다. 재응시로 나아진 것을 인정한다.
분야별 등급은 그 분야 안에서 따로 상대 평가한다.

## 1. 산정

```bash
python3 - <<'PY'
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

# ── 상대 평가 성적표 ────────────────────────────────────────────
# 상위 20% A · 상위 40% B · 상위 70% C · 나머지(하위 30%) D
# 동점은 같은 등급이다. 경계에 걸리면 모두 위 등급을 준다.
CUTS = ((0.20, 'A'), (0.40, 'B'), (0.70, 'C'))
EPS = 1e-9


def grade_of(ratio):
    for cut, g in CUTS:
        if ratio <= cut + EPS:
            return g
    return 'D'


def assign(pairs):
    """[(값, 이름)] → ({이름: 등급}, {이름: 순위}, {이름: 상위비율})"""
    n = len(pairs)
    ordered = sorted(pairs, key=lambda x: -x[0])
    rank, prev = 0, None
    ranks, grades, ratios = {}, {}, {}
    for i, (v, name) in enumerate(ordered, 1):
        if prev is None or v != prev:
            rank, prev = i, v
        ranks[name] = rank
        ratios[name] = rank / n
        grades[name] = grade_of(rank / n)
    return grades, ranks, ratios


records, problems = load()
if not records:
    print('!! 제출물이 없습니다. 먼저 /quiz-teacher-collect 를 확인하세요.')
    for p in problems:
        print('   ', p)
    sys.exit(1)

students = by_student(records)
n = len(students)

# 종합 점수 = 카테고리별 최고 기록의 평균 정답률
overall, per_cat_best = [], {}
for name, rows in students.items():
    vals = []
    per_cat_best[name] = {}
    for c in CATEGORIES:
        rs = [r for r in rows if r['mode'] == 'category' and r['category'] == c]
        if rs:
            b = max(r['accuracy'] for r in rs)
            per_cat_best[name][c] = b
            vals.append(b)
    overall.append((sum(vals) / len(vals) if vals else 0.0, name))

grades, ranks, ratios = assign(overall)

print(f'■ 성적표 — 학생 {n}명')
print('  등급 기준: 상위 20% A · 상위 40% B · 상위 70% C · 나머지 D (동점은 같은 등급)')
if n < 10:
    print(f'  !! 학생이 {n}명뿐이라 상대 평가가 거칠게 나옵니다. 아래 정답률을 함께 보세요.')

print('\n■ 종합')
print(f"  {'등급':<5}{'순위':>4}  {'학생':<8}{'정답률':>8}{'상위':>8}   분포")
for v, name in sorted(overall, key=lambda x: -x[0]):
    print(f"  {grades[name]:<5}{ranks[name]:>4}  {name:<8}{pct(v):>8}{pct(ratios[name]):>8}   {bar(v)}")

dist = {g: sum(1 for x in grades.values() if x == g) for g in 'ABCD'}
print('  등급 분포: ' + ' · '.join(f'{g} {dist[g]}명' for g in 'ABCD'))

# 분야별 등급 — 각 카테고리 안에서 따로 상대 평가한다
print('\n■ 분야별 등급')
cat_grades = {}
for c in CATEGORIES:
    pairs = [(v[c], nm) for nm, v in per_cat_best.items() if c in v]
    cat_grades[c] = assign(pairs)[0] if len(pairs) >= 2 else {}
print(f"  {'학생':<10}" + ''.join(f'{KO[c]:>10}' for c in CATEGORIES))
for v, name in sorted(overall, key=lambda x: -x[0]):
    cells = []
    for c in CATEGORIES:
        if c not in per_cat_best[name]:
            cells.append('미응시')
        else:
            g = cat_grades[c].get(name, '-')
            cells.append(f"{g} {pct(per_cat_best[name][c])}")
    print(f'  {name:<10}' + ''.join(f'{x:>10}' for x in cells))

print('\n■ 학생별 성적표')
for v, name in sorted(overall, key=lambda x: -x[0]):
    rows = students[name]
    print(f"\n  ── {name} ──")
    print(f"     종합 등급 {grades[name]}  ·  {n}명 중 {ranks[name]}위 (상위 {pct(ratios[name])})  ·  평균 정답률 {pct(v)}")
    strong = [c for c in CATEGORIES if cat_grades[c].get(name) in ('A', 'B')]
    weak = [c for c in CATEGORIES if cat_grades[c].get(name) == 'D']
    if strong:
        print(f"     잘하는 분야: {', '.join(KO[c] for c in strong)}")
    if weak:
        print(f"     보강할 분야: {', '.join(KO[c] for c in weak)}")
    missing = [c for c in CATEGORIES if c not in per_cat_best[name]]
    if missing:
        print(f"     아직 안 푼 분야: {', '.join(KO[c] for c in missing)}")
    alls = [r for r in rows if r['mode'] == 'all']
    if alls:
        b = max(alls, key=lambda r: r['accuracy'])
        print(f"     전체 도전: {b['score']}점 ({b['correct']}/{b['total']}, {pct(b['accuracy'])})")
PY
```

제출물이 없으면 종료 코드 1로 멈춘다. `/quiz-teacher-collect` 부터 확인한다.

## 2. 읽는 법

**상대 평가는 실력을 말하지 않는다.** 이것이 가장 중요하다.

- 반 전체가 90%대여도 **누군가는 반드시 D를 받는다.** 잘하는 반에서 D는 못한다는 뜻이 아니다
- 반대로 반 전체가 40%대여도 누군가는 A다. 잘한다는 뜻이 아니다
- 그래서 스크립트가 **등급 옆에 항상 절대 정답률을 함께 찍는다.** 둘을 같이 봐야 한다

**학생 수가 적으면 등급이 거칠어진다.** 다섯 명이면 상위 20%가 정확히 한 명이라
한 문항 차이로 A와 B가 갈린다. 열 명 미만이면 스크립트가 경고한다. 그때는
등급을 단정적으로 말하지 말고 정답률 위주로 이야기한다.

**미응시를 D로 읽지 않는다.** 안 푼 분야는 `미응시` 로 나온다. 0점이 아니다.
종합 등급은 푼 분야만으로 계산하므로, 한 분야만 푼 학생과 네 분야를 다 푼 학생을
같은 잣대로 비교하고 있지 않은지 확인한다.

## 3. 출력

1. **등급 기준과 인원 분포** — A·B·C·D 각 몇 명인지. 동점 때문에 목표 비율과 어긋나면 그 사실을 밝힌다
2. **종합 성적표** — 등급 · 순위 · 정답률 · 상위 비율
3. **분야별 등급** — 학생 × 카테고리 표
4. **학생별 카드** — 잘하는 분야, 보강할 분야, 아직 안 푼 분야, 전체 도전 기록
5. **해석** — 등급만 옮기지 말고 이렇게 읽어야 한다는 설명을 붙인다.
   특히 반 전체 수준이 높거나 낮을 때는 그 사실을 먼저 말한다

## 학생과 학부모에게 전할 때

- **등급만 떼어 전달하지 않는다.** 절대 정답률과 반 전체 분포를 함께 준다
- 하위 등급 학생에게는 **틀린 문항의 해설을 다시 읽는 것**을 구체적인 다음 걸음으로 제시한다.
  등급은 결과일 뿐 지도 방법이 아니다
- 다른 학생의 이름이 들어간 표를 그대로 공유하지 않는다. 개인 카드만 떼어 준다

## 알아둘 것

- 이 명령어는 **읽기만 한다.** 제출 파일도 문제 은행도 고치지 않는다
- **소요 시간은 등급에 반영하지 않는다.** 곱씹을 시간을 보장한다는 설계 원칙(PRD 2.1)과 충돌한다
- **문항별로 무엇을 틀렸는지는 알 수 없다.** 앱이 한 판의 요약만 저장하기 때문이다.
  등급이 낮은 이유를 문항 단위로 짚으려면 앱이 문항별 정오를 저장하도록 고쳐야 한다
- 절대 기준으로 보고 싶으면 `/quiz-teacher-report` 가 반 평균과 분포를 보여준다.
  이 명령어는 **상대 평가 전용**이다
- `teacher/submissions/` 는 학생 이름과 성적이 담긴 개인정보다. `.gitignore` 에 들어 있다
