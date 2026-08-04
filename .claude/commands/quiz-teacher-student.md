---
description: 학생 한 명의 응시 이력과 분야별 강약을 반 평균과 견주어 본다
argument-hint: <학생 이름> — 예 "김민준"
allowed-tools: Bash(python3:*), Read
---

학생 한 명을 자세히 봐줘. 인자로 이름을 준다.

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

# ── 학생 한 명 상세 ─────────────────────────────────────────────
records, problems = load()
if not records:
    print('!! 제출물이 없습니다. 먼저 /quiz-teacher-collect 를 확인하세요.')
    sys.exit(1)

students = by_student(records)
raw = (os.environ.get('QUIZ_ARGS') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''
name = next((t for t in re.split(r'[\s,]+', raw) if t in students), None)
if not name:
    print(f'!! 학생을 지정하세요. 명단: {", ".join(students)}')
    sys.exit(1)

rows = students[name]
klass_avg = {}
for c in CATEGORIES:
    vals = [r['accuracy'] for r in records if r['mode'] == 'category' and r['category'] == c]
    if vals:
        klass_avg[c] = sum(vals) / len(vals)

print(f'■ {name} — 응시 {len(rows)}건')
mean = sum(r['accuracy'] for r in rows) / len(rows)
print(f"  평균 정답률 {pct(mean)} · 최고 {pct(max(r['accuracy'] for r in rows))}")

print('\n■ 응시 이력')
print(f"  {'날짜':<12}{'과제':<10}{'점수':>6}{'정답':>8}{'정답률':>8}   소요")
for r in sorted(rows, key=lambda x: x['playedAt']):
    task = '전체 도전' if r['mode'] == 'all' else KO[r['category']]
    mins, secs = divmod(round(r['durationMs'] / 1000), 60)
    dur = f'{mins}분 {secs}초' if mins else f'{secs}초'
    hit = f"{r['correct']}/{r['total']}"
    print(f"  {r['playedAt'][:10]:<12}{task:<10}{r['score']:>6}{hit:>8}{pct(r['accuracy']):>8}   {dur}")

print('\n■ 분야별 강약 (반 평균 대비)')
print(f"  {'분야':<7}{'본인':>7}{'반 평균':>9}{'차이':>8}   판정")
gaps = []
for c in CATEGORIES:
    rs = [r for r in rows if r['mode'] == 'category' and r['category'] == c]
    if not rs or c not in klass_avg:
        print(f'  {KO[c]:<7}{"미응시":>7}')
        continue
    mine = max(r['accuracy'] for r in rs)
    diff = mine - klass_avg[c]
    gaps.append((diff, c))
    verdict = '강함' if diff >= 0.10 else ('약함' if diff <= -0.10 else '평균권')
    print(f'  {KO[c]:<7}{pct(mine):>7}{pct(klass_avg[c]):>9}{diff*100:>+7.0f}%p   {verdict}')
if gaps:
    gaps.sort()
    print(f'  → 보강이 필요한 분야: {KO[gaps[0][1]]}')
PY
```

이름을 주지 않거나 명단에 없으면 명단을 보여주고 멈춘다.

## 2. 판정

**반 평균 대비로 읽는다.** 절대 점수보다 또래와의 차이가 지도에 쓸모 있다.
정답률 50%가 반 평균이 45%인 분야에서는 나쁘지 않고, 반 평균이 80%인 분야에서는 뒤처진 것이다.

**응시 이력의 흐름을 본다.**

- 날짜가 지나며 나아지는가, 제자리인가
- 특정 분야만 유독 낮은가, 전반적으로 낮은가 — 전자는 보강, 후자는 기초부터다
- 소요 시간이 유독 짧은 응시가 있으면 찍었을 가능성을 짚는다.
  다만 **소요 시간으로 평가하지 않는다.** 참고 신호일 뿐이다 (PRD 2.1)

**미응시를 빠뜨리지 않는다.** 안 푼 분야가 있으면 그것부터 권한다. 자료가 없는 분야는 판단할 수 없다.

## 3. 출력

1. **한 줄 요약** — 전반적 수준과 가장 두드러진 특징
2. **응시 이력** — 표를 옮기되 흐름을 해석한다
3. **분야별 강약** — 반 평균 대비. 강한 분야도 반드시 짚는다
4. **지도 제안** — 어느 분야를 어떻게 볼지. 틀린 문항의 해설을 다시 읽게 하는 것이 기본이다
5. **학생에게 전할 말** — 그대로 읽어줘도 되는 두세 문장.
   못한 것만 늘어놓지 말고 나아진 지점을 함께 적는다

## 알아둘 것

- **문항별로 무엇을 틀렸는지는 알 수 없다.** 앱이 한 판의 요약만 저장하기 때문이다.
  "어느 문제를 틀렸나"를 보려면 학생이 결과 화면의 «틀린 문제 다시 보기» 를 직접 보여줘야 한다
- 한 번의 응시로 단정하지 않는다. 표본이 하나면 그 사실을 밝힌다
- 다른 학생과의 비교는 `/quiz-teacher-compare` 가 한다
