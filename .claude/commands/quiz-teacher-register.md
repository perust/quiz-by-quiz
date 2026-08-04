---
description: 선생님이 학생 점수를 직접 입력한다. 학생이 내보내기를 못 할 때 쓰는 두 번째 경로
argument-hint: <이름> <분야> <맞은개수> — 예 "홍길동 한국사 8", "홍길동 8,7,9,6"
allowed-tools: Bash(python3:*), Read
---

학생 점수를 받아 적어줘. `$ARGUMENTS` 로 이름과 점수를 준다.

## 왜 이 경로가 필요한가

원래 방식은 **학생이 개발자 도구를 열어 기록을 JSON 으로 내보내는 것**이다 (`/quiz-teacher-collect`).
정확하지만 번거롭다. 어린 학생이나 수업 중에는 현실적이지 않다.

이 명령어는 **학생이 결과 화면을 보여주면 선생님이 숫자만 받아 적는** 경로다.
같은 `teacher/submissions/<이름>.json` 에 쌓이므로 나머지 명령어가 그대로 읽는다.

**대신 문항별 정오는 얻지 못한다.** 어느 문항을 틀렸는지는 점수만 봐서는 알 수 없다.
그래서 대시보드 9구획(문항별 분석)에서는 이 기록이 제외된다. 두 경로를 함께 쓰는 것이 낫다.

## 입력 형태

| 입력 | 뜻 |
| --- | --- |
| `홍길동 한국사 8` | 한국사 8/10 |
| `홍길동 과학 7/10` | 총문항을 밝힐 때 |
| `홍길동 8,7,9,6` | 네 분야를 한 번에 (한국사·과학·지리·일반상식 순) |
| `홍길동 전체 32/40` | 전체 도전 |

분야는 `한국사` · `과학` · `지리` · `일반상식` · `전체` 를 받는다.
인자가 없으면 사용법을 보여주고 멈춘다.

## 1. 실행

```bash
QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
"""선생님이 학생 점수를 직접 입력한다. 학생이 내보내기를 못 할 때 쓰는 두 번째 경로."""
import json, os, re, sys
from datetime import datetime

SUB_DIR = 'teacher/submissions'
CATEGORIES = ('history', 'science', 'geography', 'general')
KO = {'history': '한국사', 'science': '과학', 'geography': '지리', 'general': '일반상식'}
ALIASES = {v: k for k, v in KO.items()}
ALIASES.update({'전체': 'all', 'all': 'all'})

raw = (os.environ.get('QUIZ_ARGS') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''

USAGE = """사용법
  /quiz-teacher-register <이름> <분야> <맞은개수>[/<총문항>]
  /quiz-teacher-register <이름> <맞은개수>,<맞은개수>,<맞은개수>,<맞은개수>

예
  /quiz-teacher-register 홍길동 한국사 8          한국사 8/10
  /quiz-teacher-register 홍길동 과학 7/10         총문항을 밝힐 때
  /quiz-teacher-register 홍길동 8,7,9,6           한국사·과학·지리·일반상식 순
  /quiz-teacher-register 홍길동 전체 32/40        전체 도전

분야: 한국사 · 과학 · 지리 · 일반상식 · 전체"""

if not raw:
    print(USAGE)
    sys.exit(1)

tokens = [t for t in re.split(r'\s+', raw) if t]
name = tokens[0] if tokens else ''
if not name or re.fullmatch(r'[\d,/]+', name):
    print('!! 첫 인자는 학생 이름이어야 합니다.\n')
    print(USAGE)
    sys.exit(1)

rest = tokens[1:]
entries = []   # (mode, category, correct, total)

# 형태 1 — 쉼표로 네 카테고리를 한 번에
comma = next((t for t in rest if ',' in t), None)
if comma:
    parts = [p.strip() for p in comma.split(',')]
    if len(parts) != 4:
        print(f'!! 쉼표 형식은 네 값이어야 합니다 (한국사,과학,지리,일반상식). 받은 값 {len(parts)}개\n')
        print(USAGE)
        sys.exit(1)
    for c, p in zip(CATEGORIES, parts):
        m = re.fullmatch(r'(\d+)(?:/(\d+))?', p)
        if not m:
            print(f"!! '{p}' 를 점수로 읽을 수 없습니다.\n"); print(USAGE); sys.exit(1)
        entries.append(('category', c, int(m.group(1)), int(m.group(2) or 10)))
else:
    # 형태 2 — 분야 하나
    cat_token = next((t for t in rest if ALIASES.get(t) or t.lower() in CATEGORIES), None)
    score_token = next((t for t in rest if re.fullmatch(r'\d+(?:/\d+)?', t)), None)
    if not cat_token or not score_token:
        print('!! 분야와 점수를 함께 주세요.\n'); print(USAGE); sys.exit(1)
    code = ALIASES.get(cat_token) or cat_token.lower()
    m = re.fullmatch(r'(\d+)(?:/(\d+))?', score_token)
    correct = int(m.group(1))
    total = int(m.group(2) or (40 if code == 'all' else 10))
    entries.append(('all' if code == 'all' else 'category',
                    None if code == 'all' else code, correct, total))

# 값 검증
for mode, cat, correct, total in entries:
    if total <= 0 or correct < 0 or correct > total:
        label = '전체 도전' if mode == 'all' else KO[cat]
        print(f'!! {label} 점수가 범위를 벗어납니다: {correct}/{total}')
        sys.exit(1)

os.makedirs(SUB_DIR, exist_ok=True)
path = os.path.join(SUB_DIR, f'{name}.json')
if os.path.exists(path):
    try:
        doc = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        print(f'!! 기존 파일을 읽을 수 없습니다 — {e}')
        print('   손으로 고쳤거나 깨진 파일입니다. 확인한 뒤 다시 시도하세요.')
        sys.exit(1)
    if isinstance(doc, list):
        doc = {'student': name, 'records': doc}
    doc.setdefault('student', name)
    doc.setdefault('records', [])
    existed = len(doc['records'])
else:
    doc = {'student': name, 'records': []}
    existed = 0

now = datetime.now().isoformat(timespec='milliseconds') + 'Z'
added = []
for mode, cat, correct, total in entries:
    doc['records'].append({
        'nickname': name, 'mode': mode, 'category': cat,
        'score': correct * 10, 'correctCount': correct, 'totalCount': total,
        'durationMs': 0, 'playedAt': now,
        # 문항별 정오는 없다. 손으로 받아 적은 점수라 어느 문항인지 알 수 없다
    })
    added.append(('전체 도전' if mode == 'all' else KO[cat], correct, total))

doc['submittedAt'] = now
doc['source'] = 'teacher-input'   # 학생 내보내기가 아니라 선생님이 입력했다는 표시
with open(path, 'w', encoding='utf-8') as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)

print(f'■ {name} — 기록 {len(added)}건 추가 (이전 {existed}건 → 총 {len(doc["records"])}건)')
for label, c, t in added:
    print(f'  {label:<8} {c}/{t}  {c/t*100:.0f}%  {int(c*10)}점')
print(f'\n  저장: {path}')
print('\n  ※ 손으로 입력한 점수라 문항별 정오가 없습니다.')
print('     대시보드 9구획(문항별 분석)에서는 이 기록이 제외됩니다.')
print('     문항 분석까지 필요하면 학생이 직접 내보내야 합니다 (/quiz-teacher-collect).')
PY
```

## 2. 판정

**맞은 개수를 받는다. 점수가 아니다.** 정답당 10점이라 8문항이면 80점인데,
`80` 을 넣으면 80/10 이 되어 범위를 벗어나 멈춘다. 학생이 «8 / 10문제» 라고 말한 그 숫자를 넣는다.

**같은 파일에 이어 붙인다.** 이미 있는 기록을 지우지 않는다.
같은 분야를 두 번 넣으면 재응시로 기록되고, 대시보드가 향상도를 잡아준다.

**되돌리려면 파일을 직접 고친다.** 이 명령어에는 취소가 없다.
잘못 넣었으면 `teacher/submissions/<이름>.json` 의 `records` 에서 해당 항목을 지운다.

## 3. 보고

- 누구에게 몇 건을 더했는지, 이전 건수와 총 건수
- 분야별 맞은 개수·정답률·점수
- **문항별 정오가 없다는 점을 반드시 밝힌다.** 이걸 빼면 나중에 9구획이 비어 있는 이유를 모른다
- 파일 경로

## 알아둘 것

- 기록에 `source: "teacher-input"` 를 남긴다. 학생이 내보낸 것과 구분하려는 표시다
- `durationMs` 는 0 으로 둔다. 손으로 받아 적을 때 알 수 없는 값이고,
  **소요 시간은 어차피 평가에 쓰지 않는다** (PRD 2.1)
- `playedAt` 은 입력 시각이다. 실제로 푼 시각이 아니다.
  응시 순서가 중요하면 학생 내보내기 쪽을 쓴다
- `teacher/submissions/` 는 학생 이름과 성적이 담긴 개인정보다. `.gitignore` 에 들어 있다
- 넣은 뒤에는 `/teacher-dashboard` 로 확인한다
