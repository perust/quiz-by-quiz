---
description: 선생님 모드 통합 대시보드. 수집·분석·비교·등급·시각화를 한 번에 돌려 종합 리포트와 교육 제안을 낸다
argument-hint: (인자 없음)
allowed-tools: Bash(python3:*), Read
---

선생님 모드를 한 번에 돌려 **종합 리포트**를 만들어줘.

여러 학생의 퀴즈 결과를 수집·분석·비교하고, 등급과 시각화까지 붙여
**학급 전체의 강점·약점과 교육 제안**으로 마무리한다. 선생님 모드의 최상위 진입점이다.

| 구획 | 내용 |
| --- | --- |
| 1 | **수집** — 제출물 검증, 개인정보 보호 확인, 등급 규칙 일치 검사 |
| 2 | **학급 개요** — 완주율, 미응시자 |
| 3 | **등급** — A~D 분포와 명단 |
| 4 | **성취 분포** — 정답률 구간별 히스토그램 |
| 5 | **강점과 약점** — 분야별 평균과 편차 |
| 6 | **히트맵** — 학생 × 분야 시각화 |
| 7 | **관심 학생** — 세 갈래로 분류 |
| 8 | **교육 제안** — 데이터에서 자동 도출 |
| 9 | **문항별 분석** — 정답률·난이도 불일치·시간 초과 |

**읽을 기록이 없으면 종료 코드 1로 멈춘다.** 데이터가 없으면 나머지가 전부 무의미하다.
그때는 `/quiz-teacher-collect` 의 학생용 내보내기 안내를 전달한다.

## 1. 실행

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
                # 문항별 정오 (앱 개선 이후 기록에만 있다). 없으면 빈 목록
                'items': [
                    {'id': it['id'], 'correct': bool(it.get('correct')), 'timedOut': bool(it.get('timedOut'))}
                    for it in (r.get('questionResults') or [])
                    if isinstance(it, dict) and isinstance(it.get('id'), str)
                ],
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


def load_bank():
    """문항별 분석에 쓸 문제 은행. 없으면 빈 딕셔너리."""
    bank = {}
    for path in sorted(glob.glob('data/*.json')):
        try:
            for q in json.load(open(path, encoding='utf-8')):
                bank[q['id']] = q
        except Exception:
            continue
    return bank

# ── 등급 규칙 ──────────────────────────────────────────────────
# 정의는 /create-report 에 있다. 세 명령어가 같은 값을 갖는지 아래에서 스스로 검사한다.
CUTS = ((0.20, 'A'), (0.40, 'B'), (0.70, 'C'))
EPS = 1e-9
LEVEL = ((0.90, '█'), (0.70, '▓'), (0.50, '▒'), (0.0, '░'))


def grade_of(ratio):
    for cut, g in CUTS:
        if ratio <= cut + EPS:
            return g
    return 'D'


def assign(pairs):
    n = len(pairs)
    rank, prev = 0, None
    grades, ranks, ratios = {}, {}, {}
    for i, (v, name) in enumerate(sorted(pairs, key=lambda x: -x[0]), 1):
        if prev is None or v != prev:
            rank, prev = i, v
        ranks[name], ratios[name], grades[name] = rank, rank / n, grade_of(rank / n)
    return grades, ranks, ratios


def cell(v):
    for lo, ch in LEVEL:
        if v >= lo:
            return ch
    return '░'


def josa(word, with_batchim, without):
    """받침에 따라 조사를 고른다. '일반상식 는' 같은 어색함을 막는다."""
    ch = word[-1] if word else ''
    if '가' <= ch <= '힣':
        return word + (with_batchim if (ord(ch) - 0xAC00) % 28 else without)
    return word + with_batchim


def stat(vals):
    s = sorted(vals)
    n = len(s)
    return s[0], (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2), sum(s) / n, s[-1]


print('━' * 58)
print('  선생님 대시보드')
print('━' * 58)

# ── 1. 수집 ────────────────────────────────────────────────────
records, problems = load()
print('\n[1] 수집')
ignored = os.path.exists('.gitignore') and re.search(
    r'^teacher/submissions/?\s*$', open('.gitignore', encoding='utf-8').read(), re.M)
print(f'  개인정보 제외(.gitignore): {"예" if ignored else "!! 아니오 — 학생 이름과 성적이 커밋될 수 있습니다"}')
for p in problems:
    print('   !!', p)
if not records:
    print('\n!! 쓸 수 있는 기록이 없습니다. 여기서 중단합니다.')
    print('   학생 내보내기 안내는 /quiz-teacher-collect 를 참고하세요.')
    sys.exit(1)

students = by_student(records)
n = len(students)
print(f'  학생 {n}명 · 응시 {len(records)}건')

# 등급 규칙이 다른 명령어와 어긋나지 않았는지 스스로 검사한다
mine = "CUTS = ((0.20, 'A'), (0.40, 'B'), (0.70, 'C'))"
drift = []
for other in ('create-report', 'quiz-teacher'):
    path = f'.claude/commands/{other}.md'
    if os.path.exists(path) and mine not in open(path, encoding='utf-8').read():
        drift.append(other)
print(f'  등급 규칙 일치: {"예" if not drift else "!! " + ", ".join(drift) + " 와 어긋남 — 같이 고쳐야 합니다"}')

# ── 2. 학급 개요 ───────────────────────────────────────────────
print('\n[2] 학급 개요')
done = {name: {r['category'] for r in rows if r['mode'] == 'category'} for name, rows in students.items()}
full = [x for x in done if done[x] == set(CATEGORIES)]
print(f'  네 분야 완주 {len(full)}명 / {n}명 ({pct(len(full)/n)})')
partial = {x: sorted(set(CATEGORIES) - done[x]) for x in done if done[x] != set(CATEGORIES)}
for name, miss in partial.items():
    print(f'   · {name} 미응시: {", ".join(KO[c] for c in miss)}')
alls = [r for r in records if r['mode'] == 'all']
print(f'  전체 도전 응시 {len({r["student"] for r in alls})}명')

# 종합 점수 = 카테고리별 최고 기록의 평균
best, overall = {}, []
for name, rows in students.items():
    best[name] = {}
    for c in CATEGORIES:
        rs = [r for r in rows if r['mode'] == 'category' and r['category'] == c]
        if rs:
            best[name][c] = max(r['accuracy'] for r in rs)
    vals = list(best[name].values())
    overall.append((sum(vals) / len(vals) if vals else 0.0, name))
grades, ranks, ratios = assign(overall)

# ── 3. 등급 ────────────────────────────────────────────────────
print('\n[3] 등급 (상위 20% A · 40% B · 70% C · 나머지 D · 동점은 같은 등급)')
if n < 10:
    print(f'  !! 학생이 {n}명뿐이라 상대 평가가 거칩니다. 정답률을 함께 보세요.')
dist = {g: [nm for nm, x in grades.items() if x == g] for g in 'ABCD'}
for g in 'ABCD':
    who = ', '.join((nm + '*' if nm in partial else nm) for nm in sorted(dist[g], key=lambda x: ranks[x]))
    print(f'  {g}  {len(dist[g]):>2}명 {bar(len(dist[g])/n)}  {who}')
if partial:
    print('  * 미응시 분야가 있어 푼 분야만으로 계산된 등급입니다. 다 푼 학생과 같은 잣대로 보지 마세요.')

# ── 4. 성취 분포 ───────────────────────────────────────────────
print('\n[4] 성취 분포')
accs = [r['accuracy'] for r in records]
lo, mid, avg, hi = stat(accs)
print(f'  최저 {pct(lo)} · 중앙 {pct(mid)} · 평균 {pct(avg)} · 최고 {pct(hi)}')
for label, lo_b, hi_b in (('90% 이상', 0.90, 1.01), ('70~89%', 0.70, 0.90),
                          ('50~69%', 0.50, 0.70), ('30~49%', 0.30, 0.50), ('30% 미만', 0.0, 0.30)):
    c = sum(1 for a in accs if lo_b <= a < hi_b)
    print(f'  {label:<9}{c:>3}건 {bar(c / len(accs))}')

# ── 5. 분야별 강점·약점 ────────────────────────────────────────
print('\n[5] 학급 강점과 약점')
cat_stat = []
for c in CATEGORIES:
    vals = [v[c] for v in best.values() if c in v]
    if not vals:
        continue
    _, _, m, _ = stat(vals)
    cat_stat.append((m, max(vals) - min(vals), c, len(vals)))
for m, spread, c, cnt in sorted(cat_stat, reverse=True):
    print(f'  {KO[c]:<7}{pct(m):>6}  {bar(m)}   응시 {cnt}명 · 편차 {pct(spread)}')
if cat_stat:
    strong = max(cat_stat)[2]
    weak = min(cat_stat)[2]
    widest = max(cat_stat, key=lambda x: x[1])
    print(f'  → 강점 {KO[strong]} · 약점 {KO[weak]} · 편차가 가장 큰 분야 {KO[widest[2]]}({pct(widest[1])})')

# ── 6. 히트맵 ──────────────────────────────────────────────────
print('\n[6] 히트맵   █ 90%+  ▓ 70%+  ▒ 50%+  ░ 50%-  · 미응시')
print(f"  {'등급':<4}{'학생':<10}" + ''.join(f'{KO[c]:<7}' for c in CATEGORIES))
for v, name in sorted(overall, key=lambda x: -x[0]):
    row = ''.join(f'{(cell(best[name][c]) * 3 if c in best[name] else "·  "):<7}' for c in CATEGORIES)
    mark = '*' if name in partial else ' '
    print(f'  {grades[name]}{mark:<3}{name:<10}{row}  {pct(v)}')

# ── 7. 관심 학생 ───────────────────────────────────────────────
print('\n[7] 관심 학생')
low = [nm for nm in dist['D']]
spread_students = sorted(
    ((max(v.values()) - min(v.values()), nm) for nm, v in best.items() if len(v) >= 2),
    reverse=True)
wide = [nm for d, nm in spread_students if d >= 0.30]
print(f'  등급 D          : {", ".join(low) or "없음"}')
print(f'  분야 편차 30%p+ : {", ".join(wide) or "없음"}')
print(f'  미응시 있음      : {", ".join(partial) or "없음"}')

# ── 8. 교육 제안 ───────────────────────────────────────────────
print('\n[8] 교육 제안')
tips = []
if cat_stat:
    m, _, c, _ = min(cat_stat)
    tips.append(f'{KO[c]} 반 평균이 {pct(m)}로 가장 낮습니다. 다음 수업에서 우선 다루세요. '
                f'다만 그 분야에 hard 문항이 몰렸을 수 있으니 /quiz-stats 로 난이도를 먼저 확인하세요.')
    if widest[1] >= 0.40:
        tips.append(f'{josa(KO[widest[2]], "은", "는")} 학생 간 편차가 {pct(widest[1])}로 큽니다. '
                    f'한 수준으로 가르치기 어려우니 수준별 과제를 나누세요.')
if wide:
    tips.append(f'{josa(", ".join(wide), "은", "는")} 분야 간 격차가 큽니다. 실력이 아니라 특정 분야가 비어 있는 경우라 '
                f'그 분야만 보강하면 빠르게 올라옵니다.')
if low:
    tips.append(f'{josa(", ".join(low), "은", "는")} 전반적으로 처집니다. 결과 화면의 «틀린 문제 다시 보기» 를 '
                f'같이 읽는 것부터 시작하세요.')
if partial:
    tips.append(f'{josa(", ".join(partial), "이", "가")} 아직 안 푼 분야가 있습니다. 자료가 없으면 지도 판단이 서지 않으니 '
                f'응시를 먼저 챙기세요.')
if avg >= 0.85:
    tips.append(f'학급 평균이 {pct(avg)}로 높습니다. 변별이 되지 않으니 '
                f'/quiz-add 로 hard 문항을 늘리는 것을 검토하세요.')
elif avg <= 0.45:
    tips.append(f'학급 평균이 {pct(avg)}로 낮습니다. 문항이 어려운지 학습이 부족한지 '
                f'/quiz-stats 의 난이도 분포로 먼저 가르세요.')
retried = [(nm, k) for nm, rows in students.items()
           for k in {(r['mode'], r['category']) for r in rows}
           if len([r for r in rows if (r['mode'], r['category']) == k]) >= 2]
if not retried:
    tips.append('같은 과제를 두 번 푼 학생이 없습니다. 재응시는 해설을 읽었는지 확인하는 가장 쉬운 방법입니다.')
for i, t in enumerate(tips, 1):
    print(f'  {i}. {t}')

# ── 9. 문항별 분석 ─────────────────────────────────────────────
print('\n[9] 문항별 분석')
with_items = [r for r in records if r['items']]
if not with_items:
    print('  문항별 기록이 있는 제출물이 없습니다.')
    print('  앱을 고치기 전에 푼 기록에는 문항 정오가 없습니다. 새로 응시한 기록부터 잡힙니다.')
else:
    if len(with_items) < len(records):
        print(f'  ※ {len(records) - len(with_items)}건은 문항 기록이 없어 제외했습니다 (앱 개선 이전 기록).')
    bank = load_bank()
    tally = {}
    for r in with_items:
        for it in r['items']:
            t = tally.setdefault(it['id'], {'n': 0, 'ok': 0, 'to': 0})
            t['n'] += 1
            t['ok'] += it['correct']
            t['to'] += it['timedOut']
    rows = []
    for qid, t in tally.items():
        q = bank.get(qid, {})
        rows.append({'id': qid, 'n': t['n'], 'acc': t['ok'] / t['n'], 'to': t['to'] / t['n'],
                     'diff': q.get('difficulty', '?'), 'cat': q.get('category'),
                     'q': q.get('question', '(문제 은행에 없음)')})
    rows.sort(key=lambda x: x['acc'])
    print(f'  집계 {len(rows)}문항 · 응시 {len(with_items)}건')

    print('\n  가장 많이 틀린 문항')
    for r in rows[:5]:
        print(f"    {pct(r['acc']):>5} ({r['n']}명)  [{r['id']}] {r['diff']:<6} {r['q'][:34]}")

    perfect = [r for r in rows if r['acc'] >= 1.0 and r['n'] >= 2]
    if perfect:
        print(f'\n  모두 맞힌 문항 {len(perfect)}개 — 변별이 되지 않는다')
        for r in perfect[:5]:
            print(f"    [{r['id']}] {r['diff']:<6} {r['q'][:40]}")

    # 선언 난이도와 실제 정답률이 어긋난 문항
    EXPECT = {'easy': 0.70, 'normal': 0.45, 'hard': 0.0}
    mismatch = []
    for r in rows:
        if r['diff'] not in EXPECT or r['n'] < 2:
            continue
        if r['diff'] == 'easy' and r['acc'] < 0.50:
            mismatch.append((r, 'easy 인데 정답률이 낮다 → hard 로 내리거나 문항을 점검'))
        elif r['diff'] == 'hard' and r['acc'] >= 0.90:
            mismatch.append((r, 'hard 인데 다 맞힌다 → easy 로 올리거나 난도를 높임'))
    if mismatch:
        print(f'\n  선언 난이도와 어긋난 문항 {len(mismatch)}개')
        for r, why in mismatch[:6]:
            print(f"    [{r['id']}] {r['diff']} · 실제 {pct(r['acc'])} — {why}")
        print('    → /quiz-range 로 해당 번호대를 열어 난이도를 조정하세요')

    timeouts = [r for r in rows if r['to'] >= 0.30 and r['n'] >= 2]
    if timeouts:
        print(f'\n  시간 초과가 잦은 문항 {len(timeouts)}개 — 몰라서가 아니라 시간이 모자란 것일 수 있다')
        for r in timeouts[:5]:
            print(f"    [{r['id']}] 시간 초과 {pct(r['to'])} · 정답률 {pct(r['acc'])}  {r['q'][:30]}")

PY
```

## 2. 읽는 법

### 등급 (3구획)

분류 규칙은 **`/create-report` 가 정의한다.** 이 명령어는 그대로 따라 쓰고,
1구획에서 두 파일의 값이 어긋나지 않았는지 스스로 검사한다. `어긋남` 이 뜨면 함께 고친다.

**상대 평가라 실력을 뜻하지 않는다.** 반 전체가 잘해도 누군가는 D 를 받는다.
학생이 열 명 미만이면 경고가 뜬다 — 그때는 등급을 단정하지 말고 정답률로 이야기한다.

**`*` 가 붙은 학생은 미응시 분야가 있다.** 푼 분야만으로 계산된 등급이라
다 푼 학생과 같은 잣대로 보면 안 된다.

### 강점과 약점 (5구획)

평균이 낮은 분야가 곧 학생의 약점은 아니다. **그 분야에 `hard` 문항이 몰렸을 수 있다.**
`/quiz-stats` 로 난이도 분포를 확인해 «학생이 약한 것» 과 «문제가 어려운 것» 을 가른다.

**편차도 함께 본다.** 평균이 낮아도 편차가 작으면 반 전체가 고르게 모르는 것이고,
편차가 크면 아는 학생과 모르는 학생이 갈린 것이다. 처방이 다르다.

### 히트맵 (6구획)

한 화면에서 **비어 있는 칸**을 찾는 용도다. 세로로 옅은 줄이 있으면 그 분야를 반 전체가 약한 것이고,
가로로 들쭉날쭉하면 그 학생의 분야 편차가 큰 것이다.

### 관심 학생 (7구획)

세 갈래는 **처방이 다르다.** 뭉뚱그려 "더 공부해야 한다" 로 끝내지 않는다.

- **등급 D** — 전반적으로 처진다. 기초부터, 틀린 문항 해설을 같이 읽는 것부터
- **분야 편차 30%p+** — 실력이 아니라 특정 분야가 비어 있다. 그 분야만 보강하면 빠르게 올라온다
- **미응시** — 판단할 자료가 없다. 응시부터 챙긴다

### 교육 제안 (8구획)

스크립트가 데이터에서 뽑은 초안이다. **그대로 옮기지 말고 판단을 붙인다.**
반 사정을 아는 것은 선생님이지 스크립트가 아니다. 맞지 않는 제안은 왜 맞지 않는지 적는다.

### 문항별 분석 (9구획)

앱이 문항별 정오를 저장하게 되면서 가능해진 분석이다. **문항 단위로 무엇이 무너졌는지** 보여준다.

- **가장 많이 틀린 문항** — 반이 모르는 지점이다. 다음 수업에서 그 내용을 다룬다
- **모두 맞힌 문항** — 변별이 되지 않는다. 난도를 올리거나 교체를 검토한다
- **선언 난이도와 어긋난 문항** — `easy` 인데 정답률이 낮거나 `hard` 인데 다 맞히는 경우다.
  **문항의 문제일 수도, 학생의 문제일 수도 있다.** 정답률이 유독 낮으면 학생이 모르는 것인지
  문항이 잘못된 것인지 `/quiz-check` 로 정답과 보기를 먼저 점검한다
- **시간 초과가 잦은 문항** — 몰라서 틀린 것과 다르다. 질문이 길거나 계산이 필요한 경우가 많다.
  내용을 더 가르칠 게 아니라 문항을 다듬을 신호다

**문항 기록이 없는 제출물은 제외된다.** 앱 개선 이전에 푼 기록에는 문항 정오가 없다.
제외된 건수를 함께 찍으므로, 그 수가 많으면 분석 표본이 작다는 뜻이다.

## 3. 출력

구획별 숫자를 그대로 나열하지 말고 **읽고 판단해서** 다시 쓴다.

1. **오늘의 한 줄** — 학생 수, 참여 상태, 가장 중요한 발견 하나
2. **학급 전체** — 수준이 고른지 갈렸는지. 강점 분야와 약점 분야, 그렇게 판단한 근거
3. **등급 분포** — 상대 평가라는 점을 함께 밝힌다. 미응시자가 섞여 있으면 짚는다
4. **눈여겨볼 학생** — 이름과 함께 **무엇을 어떻게 도울지.** 세 갈래를 구분한다
5. **다음 수업 제안** — 8구획을 바탕으로 하되 구체적으로
6. **데이터의 한계** — 아래를 반드시 밝힌다

## 반드시 밝힐 한계

- **제출한 학생만 보인다.** 안 낸 학생은 데이터에 없다. 반 평균이 아니라 제출자 평균이다
- **문항별 분석은 앱 개선 이후 기록에만 적용된다.** 그 이전에 푼 기록에는 문항 정오가 없어
  9구획에서 제외된다. 표본이 적으면 문항 정답률이 한두 명으로 흔들린다
- **표본이 작으면 등급과 순위가 한두 문항으로 뒤집힌다.** 열 명 미만이면 단정하지 않는다
- **소요 시간은 평가에 쓰지 않는다.** 곱씹을 시간을 보장한다는 설계 원칙(PRD 2.1)과 충돌한다
- **미응시 분야가 있는 학생의 등급은 푼 분야만으로 계산된다.** 같은 잣대가 아니다

## 알아둘 것

- 이 명령어는 **읽기만 한다.** 제출 파일도 문제 은행도 고치지 않는다
- `teacher/submissions/` 는 학생 이름과 성적이 담긴 개인정보다. `.gitignore` 에 들어 있고
  1구획에서 매번 확인한다. `아니오` 가 뜨면 커밋하기 전에 반드시 넣는다
- 더 깊이 보려면 개별 명령어로 들어간다.
  `/quiz-teacher-student <이름>` (개인), `/quiz-teacher-compare` (지정 비교),
  `/create-report` (성적표 발급), `/quiz-teacher-collect` (제출 관리)
- 학생에게 보여줄 자료가 필요하면 `/create-report` 를 쓴다.
  이 대시보드는 **선생님이 판단하려고 보는 화면**이라 다른 학생 정보가 섞여 있다
