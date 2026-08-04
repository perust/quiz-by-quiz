---
description: 학생이 내보낸 퀴즈 기록을 모아 검증하고 명단을 만든다. 선생님 모드의 첫 단계
argument-hint: (인자 없음)
allowed-tools: Bash(python3:*), Read
---

학생들이 제출한 퀴즈 기록을 모아 검증하고 명단을 만들어줘.

## 왜 제출이 필요한가

**이 앱은 서버가 없다.** 기록은 각 학생 브라우저의 `localStorage` 에만 남고 어디로도 전송되지 않는다
(PRD 9.1). 그래서 선생님이 학생 성적을 직접 조회할 방법이 원천적으로 없다.
학생이 자기 기록을 내보내 건네주는 수밖에 없다.

이 명령어는 그렇게 모인 파일을 읽어 나머지 선생님 모드 명령어가 쓸 명단을 만든다.

## 1. 수집·검증

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

# ── 수집·검증 ──────────────────────────────────────────────────
records, problems = load()

print(f'■ 제출물 수집 — {SUB_DIR}')
if not os.path.isdir(SUB_DIR):
    os.makedirs(SUB_DIR, exist_ok=True)
    print(f'  폴더가 없어 새로 만들었습니다: {SUB_DIR}')

# 개인정보라 저장소에 올라가면 안 된다
ignored = False
for gi in ('.gitignore',):
    if os.path.exists(gi) and re.search(r'^teacher/(\*|submissions/?)?\s*$', open(gi, encoding='utf-8').read(), re.M):
        ignored = True
print(f'  .gitignore 제외 여부: {"예" if ignored else "!! 아니오 — 학생 이름과 성적이 커밋될 수 있습니다"}')

if problems:
    print(f'\n■ 걸린 것 {len(problems)}건')
    for p in problems:
        print('   !!', p)

if not records:
    print('\n!! 쓸 수 있는 기록이 없습니다. 여기서 중단합니다.')
    print('   학생에게 아래를 안내해 내보낸 JSON을 받아 teacher/submissions/ 에 넣으세요.')
    sys.exit(1)

students = by_student(records)
print(f'\n■ 명단 — {len(students)}명 / 응시 {len(records)}건')
print(f"  {'학생':<8}{'응시':>4}{'카테고리':>8}{'전체':>6}   최근 응시")
for name, rows in students.items():
    cat = sum(1 for r in rows if r['mode'] == 'category')
    allm = len(rows) - cat
    print(f"  {name:<8}{len(rows):>4}{cat:>8}{allm:>6}   {max(r['playedAt'] for r in rows)[:10]}")

missing = [n for n, rows in students.items()
           if {r['category'] for r in rows if r['mode'] == 'category'} != set(CATEGORIES)]
if missing:
    print(f'\n  모든 분야를 풀지 않은 학생: {", ".join(missing)}')
PY
```

**쓸 수 있는 기록이 하나도 없으면 종료 코드 1로 멈춘다.** 그때는 아래 안내를 학생에게 전달한다.

## 2. 학생에게 줄 안내

학생이 퀴즈를 푼 브라우저에서 게임 페이지를 열고 개발자 도구 콘솔(F12 → Console)에 붙여넣게 한다.
결과가 클립보드에 복사되면 파일로 저장해 보내달라고 한다.

```js
copy(JSON.stringify({
  student: prompt('이름을 입력하세요') || '이름없음',
  submittedAt: new Date().toISOString(),
  records: JSON.parse(localStorage.getItem('quiz.rankings') || '[]'),
}, null, 2));
```

받은 파일은 `teacher/submissions/<이름>.json` 으로 저장한다.

**콘솔을 못 여는 학생이 있으면** `/quiz-teacher-register <이름> <분야> <맞은개수>` 로 선생님이 받아 적는다.
결과 화면의 숫자만 있으면 되고 같은 폴더에 같은 형식으로 쌓인다.
대신 문항별 정오가 없어 대시보드 9구획에서는 빠진다. 두 경로를 섞어 써도 된다.

## 3. 받는 형식

두 가지를 모두 읽는다.

**감싼 형태** (위 스니펫의 결과, 권장)

```json
{
  "student": "김민준",
  "class": "3-2",
  "submittedAt": "2026-08-04T10:00:00+09:00",
  "records": [ { "nickname": "김민준", "mode": "category", "category": "history",
                 "score": 80, "correctCount": 8, "totalCount": 10,
                 "durationMs": 96400, "playedAt": "2026-08-04T09:30:00.000Z" } ]
}
```

**배열만 있는 형태** — `localStorage.getItem('quiz.rankings')` 를 그대로 붙여넣은 경우다.
이때는 **파일명이 학생 이름이 된다.**

기록 하나하나는 `nickname` · `mode` · `score` · `correctCount` · `totalCount` · `playedAt` 이 있어야 한다.
`mode` 가 `all` 이면 `category` 는 없어도 된다.

## 4. 판정

- **형식이 깨진 파일** — 건너뛰고 어느 파일인지 알린다. 전체를 멈추지 않는다
- **중복 제출** — 같은 학생의 같은 응시(시각·모드·점수가 모두 같음)는 하나로 합친다
- **미응시** — 모든 분야를 풀지 않은 학생을 짚어준다
- **`.gitignore` 제외 여부** — 아래 참조

## 개인정보 주의

`teacher/submissions/` 에는 **학생 이름과 성적**이 들어간다. 개인정보다.

이 저장소는 공개돼 있으므로 **반드시 `.gitignore` 에 넣어야 한다.** 스크립트가 확인해서
빠져 있으면 경고한다. 경고가 뜨면 커밋하기 전에 아래를 넣는다.

```gitignore
teacher/submissions/
```

이미 커밋한 뒤라면 파일만 지우는 것으로 부족하다. 이력에 남으므로 별도 정리가 필요하다.

## 알아둘 것

- 이 명령어는 **읽기만 한다.** 제출 파일을 고치거나 지우지 않는다
- 학생 이름은 파일에 적힌 대로 쓴다. 동명이인은 파일명으로 구분하게 안내한다
- 다음 단계는 `/quiz-teacher-report` (반 현황), `/quiz-teacher-compare` (비교),
  `/quiz-teacher-student` (개인). 한 번에 보려면 `/quiz-teacher`
