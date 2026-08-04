---
description: 반 전체 성적을 한눈에 본다. 분포·카테고리별 약점·학생별 요약·재응시 향상
argument-hint: (인자 없음)
allowed-tools: Bash(python3:*), Read
---

반 전체 성적을 한눈에 정리해줘.

개별 점수를 나열하는 게 목적이 아니다. **어느 분야가 약하고 누가 처지는지**가 나와야 한다.

## 1. 집계

```bash
python3 - <<'PY'
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

# ── 반 전체 현황 ────────────────────────────────────────────────
records, problems = load()
if not records:
    print('!! 제출물이 없습니다. 먼저 /quiz-teacher-collect 를 확인하세요.')
    for p in problems:
        print('   ', p)
    sys.exit(1)

students = by_student(records)
cat_rows = [r for r in records if r['mode'] == 'category']
all_rows = [r for r in records if r['mode'] == 'all']

print(f'■ 반 현황 — 학생 {len(students)}명 · 응시 {len(records)}건')
print(f'  카테고리 모드 {len(cat_rows)}건 · 전체 도전 {len(all_rows)}건')

def stats(vals):
    if not vals:
        return None
    s = sorted(vals)
    n = len(s)
    return {'min': s[0], 'max': s[-1], 'mean': sum(s) / n,
            'median': s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2}

accs = [r['accuracy'] for r in records]
st = stats(accs)
print(f"\n■ 정답률 분포\n  최저 {pct(st['min'])} · 중앙 {pct(st['median'])} · 평균 {pct(st['mean'])} · 최고 {pct(st['max'])}")
buckets = [(0.9, '90% 이상'), (0.7, '70~89%'), (0.5, '50~69%'), (0.3, '30~49%'), (0.0, '30% 미만')]
for i, (lo, label) in enumerate(buckets):
    hi = buckets[i - 1][0] if i else 1.01
    n = sum(1 for a in accs if lo <= a < hi)
    print(f'  {label:<9} {n:>3}건 {bar(n / len(accs))}')

print('\n■ 카테고리별 반 평균 (약한 분야 찾기)')
print(f"  {'분야':<7}{'응시':>4}{'평균 정답률':>12}   분포")
rank_cat = []
for c in CATEGORIES:
    rows = [r for r in cat_rows if r['category'] == c]
    if not rows:
        print(f'  {KO[c]:<7}{0:>4}{"-":>12}')
        continue
    m = sum(r['accuracy'] for r in rows) / len(rows)
    rank_cat.append((m, c))
    print(f'  {KO[c]:<7}{len(rows):>4}{pct(m):>12}   {bar(m)}')
if rank_cat:
    rank_cat.sort()
    print(f'  → 가장 약한 분야: {KO[rank_cat[0][1]]} ({pct(rank_cat[0][0])})')

print('\n■ 학생별 요약 (평균 정답률 순)')
summary = []
for name, rows in students.items():
    m = sum(r['accuracy'] for r in rows) / len(rows)
    best = max(r['accuracy'] for r in rows)
    summary.append((m, best, name, len(rows)))
summary.sort(reverse=True)
print(f"  {'학생':<8}{'응시':>4}{'평균':>7}{'최고':>7}   분포")
for m, best, name, n in summary:
    print(f'  {name:<8}{n:>4}{pct(m):>7}{pct(best):>7}   {bar(m)}')

# 재응시 향상도
print('\n■ 재응시 향상')
improved = []
for name, rows in students.items():
    seen = {}
    for r in rows:
        key = (r['mode'], r['category'])
        seen.setdefault(key, []).append(r)
    for key, rs in seen.items():
        if len(rs) >= 2:
            improved.append((name, key, rs[0]['accuracy'], rs[-1]['accuracy']))
if improved:
    for name, key, first, last in improved:
        label = '전체 도전' if key[0] == 'all' else KO[key[1]]
        arrow = '↑' if last > first else ('↓' if last < first else '=')
        print(f'  {name} · {label}: {pct(first)} → {pct(last)} {arrow}')
else:
    print('  같은 과제를 두 번 이상 푼 기록이 없습니다')
PY
```

제출물이 없으면 종료 코드 1로 멈춘다. 그때는 `/quiz-teacher-collect` 부터 확인한다.

## 2. 판정

숫자를 그대로 옮기지 말고 읽어서 판단한다.

**정답률 분포** — 가운데가 두툼한지, 위아래로 갈라졌는지 본다.
양극화돼 있으면 수업을 한 수준에 맞추기 어렵다는 뜻이다.

**카테고리별 반 평균** — 가장 낮은 분야가 다음 수업의 후보다. 다만 **문항 난이도를 함께 봐야 한다.**
그 분야에 `hard` 문항이 몰려 있으면 학생이 약한 게 아니라 문제가 어려운 것이다.
`/quiz-stats` 로 난이도 분포를 확인해 구분한다.

**학생별 요약** — 평균이 낮은 학생과, 평균은 낮은데 최고 점수가 높은 학생을 구분한다.
후자는 실력이 아니라 편차 문제다.

**재응시 향상** — 같은 과제를 다시 푼 학생의 변화다. 오르지 않았다면 해설이 안 읽히고 있다는 신호다.

## 3. 출력

1. **한 줄 요약** — 학생 수, 응시 수, 가장 눈에 띄는 것 하나
2. **분포** — 정답률 구간과 해석
3. **약한 분야** — 카테고리별 평균과 왜 낮은지에 대한 판단
4. **눈여겨볼 학생** — 처지는 학생, 편차가 큰 학생
5. **다음 수업 제안** — 구체적으로. "일반상식을 보강하세요"가 아니라
   "일반상식 반 평균이 62%로 가장 낮고, 그중 hard 2문항을 빼면 78%라 실제로는 특정 문항이 문제입니다"까지

## 알아둘 것

- **소요 시간은 평가에 쓰지 않는다.** 곱씹을 시간을 보장한다는 설계 원칙(PRD 2.1)과 충돌한다.
  개인 지표로만 보여주고 순위나 등급에 반영하지 않는다
- 표본이 작으면 평균이 흔들린다. 학생이 다섯 명 안팎이면 개별 학생의 편차가 반 평균을 좌우한다는 것을 밝힌다
- 문항 자체의 문제는 `/quiz-check` 와 `/quiz-validate` 가 본다. 특정 문항의 정답률이 유독 낮다는
  분석은 이 명령어로 할 수 없다 — 제출 기록에 문항별 정오가 담기지 않기 때문이다 (아래 참조)

## 문항별 분석은 어디서 하나

**`/teacher-dashboard` 9구획**이 한다. 앱이 문항별 정오를 저장하므로
"어느 문항을 반의 몇 %가 틀렸다"를 낼 수 있고, 선언 난이도와 실제 정답률이
어긋난 문항까지 짚어준다.

이 명령어는 **분야 단위까지만** 다룬다. 분야 평균이 낮을 때 그것이 학생 문제인지
특정 문항 문제인지 가르려면 대시보드로 넘어간다.

단, 앱 개선 이전에 푼 기록에는 문항 정오가 없어 그 건은 문항별 분석에서 제외된다.
