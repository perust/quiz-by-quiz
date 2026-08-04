---
description: 문제 은행을 점검하고 부족한 곳을 채우는 일과. 7단계를 순서대로 밟고 실패하면 즉시 멈춘다
argument-hint: [카테고리] [개수] — 예 "한국사 2", 생략하면 가장 부족한 곳에 1문항
allowed-tools: Bash(python3:*), Read, Edit, WebSearch, WebFetch
---

문제 은행을 하루치 점검하고 부족한 곳을 채워줘. 아래 7단계를 **순서대로** 밟는다.

## 지켜야 할 규칙

**어느 단계든 실패하면 즉시 멈추고 보고한다.** 다음 단계로 넘어가지 않는다.
스크립트가 종료 코드 1로 끝나면 그게 실패 신호다. 실패를 "일단 넘어가고 나중에 고치자"로 처리하지 않는다.

멈출 때는 이렇게 보고한다.

- 몇 단계에서 멈췄는지
- 무엇이 실패했는지 (스크립트 출력 그대로가 아니라 원인을 풀어서)
- 그때까지 **파일을 고쳤는지 여부**. 고쳤다면 백업으로 되돌리는 방법
- 다음에 무엇을 해야 하는지

인자로 카테고리와 개수를 줄 수 있다. 없으면 3단계가 추천하는 곳에 1문항을 넣는다.

---

## 1~3단계 — 구조 파악 · 현황 집계 · 부족한 곳 찾기

한 번에 실행한다. 데이터가 깨져 있으면 여기서 멈춘다. **깨진 은행에 문제를 더하면 안 된다.**

```bash
python3 - <<'PY'
"""1~3단계: 구조 파악 · 현황 집계 · 부족한 곳 찾기. 데이터가 깨져 있으면 여기서 멈춘다."""
import json, glob, os, re, sys
from collections import Counter

CATEGORIES = ('history', 'science', 'geography', 'general')
ALIASES = {'한국사': 'history', '과학': 'science', '지리': 'geography', '일반상식': 'general'}
NAMES = {c: k for k, c in ALIASES.items()}
LEVELS = ('easy', 'normal', 'hard')
TARGET_PER_CATEGORY = {'easy': 4, 'normal': 4, 'hard': 2}
REQUIRED = ('id', 'category', 'question', 'choices', 'answerIndex', 'explanation', 'difficulty', 'tags')

fatal = []
banks = {}

print('■ 1단계 — 파일 구조')
paths = sorted(glob.glob('data/*.json'))
if not paths:
    print('  !! data/*.json 이 없습니다'); sys.exit(1)
for path in paths:
    cat = os.path.basename(path)[:-5]
    if cat not in CATEGORIES:
        fatal.append(f'{path}: 알 수 없는 카테고리 파일명')
        continue
    try:
        bank = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        fatal.append(f'{path}: JSON 파싱 실패 — {e}'); continue
    if not isinstance(bank, list):
        fatal.append(f'{path}: 최상위가 배열이 아님'); continue
    banks[cat] = bank
    keys = sorted({k for q in bank for k in q}) if bank else []
    print(f'  {path:<22} {len(bank):>3}문항  필드 {len(keys)}종 {keys}')
missing = [c for c in CATEGORIES if c not in banks]
if missing:
    fatal.append(f'파일 없음: {", ".join(missing)}')

if fatal:
    print('\n!! 구조 이상 — 여기서 중단합니다')
    for f in fatal: print('   ', f)
    sys.exit(1)

# 무결성 게이트
print('\n■ 무결성 게이트')
bad = []
all_ids = []
for cat, bank in banks.items():
    for q in bank:
        qid = q.get('id', '?')
        all_ids.append(qid)
        for k in REQUIRED:
            if k not in q or q[k] in (None, '', []): bad.append(f'{qid}: {k} 누락/빈값')
        ch, idx = q.get('choices') or [], q.get('answerIndex')
        if len(ch) != 4: bad.append(f'{qid}: 보기 {len(ch)}개')
        if len(set(ch)) != len(ch): bad.append(f'{qid}: 보기 중복')
        if not isinstance(idx, int) or not (0 <= idx < len(ch)): bad.append(f'{qid}: answerIndex {idx}')
        if q.get('category') != cat: bad.append(f'{qid}: category 불일치')
        if q.get('difficulty') not in LEVELS: bad.append(f'{qid}: difficulty {q.get("difficulty")}')
dups = sorted({i for i in all_ids if all_ids.count(i) > 1})
if dups: bad.append(f'ID 중복: {dups}')
if bad:
    print('  !! 이상 — 여기서 중단합니다 (문제 추가 전에 고쳐야 함)')
    for b in bad: print('   ', b)
    sys.exit(1)
print(f'  통과 — {len(all_ids)}문항, ID 고유')

print('\n■ 2단계 — 현재 개수와 분포')
total = sum(len(b) for b in banks.values())
print(f'  총 {total}문항')
print(f"  {'카테고리':<7}{'문항':>5}{'easy':>6}{'normal':>8}{'hard':>6}   정답위치(0/1/2/3)")
for c in CATEGORIES:
    b = banks[c]; d = Counter(q['difficulty'] for q in b); p = Counter(q['answerIndex'] for q in b)
    print(f"  {NAMES[c]:<7}{len(b):>5}{d.get('easy',0):>6}{d.get('normal',0):>8}{d.get('hard',0):>6}"
          f"   {p.get(0,0)}/{p.get(1,0)}/{p.get(2,0)}/{p.get(3,0)}")

print('\n■ 3단계 — 부족한 곳')
gaps = []
for c in CATEGORIES:
    b = banks[c]; d = Counter(q['difficulty'] for q in b)
    short = {lv: TARGET_PER_CATEGORY[lv] - d.get(lv, 0) for lv in LEVELS if d.get(lv, 0) < TARGET_PER_CATEGORY[lv]}
    tags = Counter(t for q in b for t in q.get('tags') or [])
    top = tags.most_common(1)[0] if tags else ('-', 0)
    pos = Counter(q['answerIndex'] for q in b)
    unused = [str(i) for i in range(4) if pos.get(i, 0) == 0]
    note = []
    if short: note.append('난이도 부족 ' + ', '.join(f'{lv} {n}개' for lv, n in short.items()))
    if len(b) < 10: note.append(f'문항 {10 - len(b)}개 모자람')
    if top[1] >= max(3, len(b) // 2): note.append(f'태그 편중 {top[0]}({top[1]})')
    if unused: note.append('미사용 정답 위치 ' + ','.join(unused))
    print(f'  {NAMES[c]:<7} ' + ('; '.join(note) if note else '균형 양호'))
    if short or len(b) < 10:
        gaps.append((c, short, 10 - len(b)))

print('\n■ 추천')
if gaps:
    c, short, lack = gaps[0]
    lv = next(iter(short), 'normal')
    print(f'  {NAMES[c]}에 {lv} 문항을 먼저 채우는 것을 권합니다.')
else:
    print('  목표 분포를 모두 채웠습니다. 주제 편중만 보고 판단하세요.')
PY
```

**실패하면 중단한다.** 구조 이상이나 무결성 위반은 문제 추가와 무관하게 먼저 고쳐야 한다.

출력에서 읽어야 할 것:

- **1단계** 파일 4개가 모두 있고 필드 8종이 일정한가
- **2단계** 카테고리별 문항 수, 난이도, 정답 위치 분포
- **3단계** 어디가 부족한가 — 난이도 결손, 문항 수 모자람, 태그 편중, 미사용 정답 위치

---

## 백업 (파일을 고치기 전에)

**요청받은 순서에서는 백업이 6단계지만, 실제로는 여기서 한 번 떠야 한다.**
5단계 검증이 실패했을 때 되돌릴 지점이 없으면 "즉시 중단"이 의미가 없기 때문이다.
6단계에서 한 번 더 떠서 확정본을 남긴다.

```bash
QUIZ_BACKUP_LABEL="pre-edit" python3 - <<'PY'
"""백업: data/ 를 통째로 타임스탬프 폴더에 복사한다."""
import glob, json, os, shutil, sys
from datetime import datetime

label = os.environ.get('QUIZ_BACKUP_LABEL') or 'snapshot'
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
dest = os.path.join('backups', f'{stamp}-{label}')
try:
    os.makedirs(dest, exist_ok=False)
    files = sorted(glob.glob('data/*.json'))
    if not files:
        print('!! 백업할 파일이 없습니다'); sys.exit(1)
    total = 0
    for f in files:
        shutil.copy2(f, dest)
        total += len(json.load(open(f, encoding='utf-8')))
    (open(os.path.join(dest, 'MANIFEST.txt'), 'w', encoding='utf-8')
     .write(f'생성 {stamp}\n용도 {label}\n파일 {len(files)}개 / 문항 {total}개\n'
            + '\n'.join(f'  {os.path.basename(f)}' for f in files) + '\n'))
except Exception as e:
    print(f'!! 백업 실패 — {e}'); sys.exit(1)
print(f'■ 백업 완료 — {dest}  ({len(files)}개 파일 / {total}문항)')
print(f'  되돌리려면: cp {dest}/*.json data/')
PY
```

**실패하면 중단한다.** 되돌릴 수단 없이 파일을 고치지 않는다.

---

## 4단계 — 새 문제 후보의 중복 체크

먼저 3단계가 짚은 빈 곳을 메울 문항을 **초안으로 작성한다.** 아직 파일에 쓰지 않는다.

작성 기준은 `CLAUDE.md`의 문제 작성 규칙 다섯 가지와 `docs/quiz-game-claude-code-prompts.md` 3-A를 따른다.
정답이 하나뿐인지, 최상급에 기준이 있는지, 시점·범위가 명확한지, 교차 검증했는지, 확신이 서는지.
연도·수치·순위가 들어가면 웹으로 확인한다.

초안을 JSON 배열로 만들어 아래에 넘긴다. ID는 1단계에서 본 각 카테고리 최대 번호 + 1이다.

```bash
QUIZ_DRAFT='[{"id":"...","question":"...","choices":["...","...","...","..."],"answerIndex":0}]' python3 - <<'PY'
"""4단계: 추가하려는 후보가 기존 문항과 겹치는지 본다. 파일을 고치기 전에 돌린다."""
import json, glob, os, sys
from difflib import SequenceMatcher
import re

draft = os.environ.get('QUIZ_DRAFT') or ''
if not draft.strip():
    print('!! QUIZ_DRAFT 가 비었습니다. 후보 문항을 JSON 배열로 넘기세요.'); sys.exit(1)
try:
    cands = json.loads(draft)
except Exception as e:
    print(f'!! 후보 JSON 파싱 실패 — {e}'); sys.exit(1)
if not isinstance(cands, list) or not cands:
    print('!! 후보는 비어 있지 않은 배열이어야 합니다'); sys.exit(1)

bank = [q for p in sorted(glob.glob('data/*.json')) for q in json.load(open(p, encoding='utf-8'))]
existing_ids = {q['id'] for q in bank}
norm = lambda s: re.sub(r'[^가-힣a-zA-Z0-9]', '', s or '')

blocking, warn = [], []
print(f'■ 4단계 — 후보 {len(cands)}문항 중복 체크 (기존 {len(bank)}문항 대조)\n')
for c in cands:
    cid = c.get('id', '?')
    print(f"  [{cid}] {c.get('question', '')[:44]}")
    if cid in existing_ids:
        blocking.append(f'{cid}: ID가 이미 있습니다 (FR-1.8 위반)')
    ans = (c.get('choices') or [None] * 4)[c.get('answerIndex', 0)] if c.get('choices') else None
    hit = False
    for q in bank:
        r = SequenceMatcher(None, norm(c.get('question')), norm(q['question'])).ratio()
        same = ans is not None and q['choices'][q['answerIndex']] == ans
        if r >= 0.70:
            blocking.append(f"{cid}: [{q['id']}] 와 질문 유사도 {r:.2f} — 사실상 같은 문제")
            hit = True
        elif r >= 0.50 or same:
            warn.append(f"{cid}: [{q['id']}] {'정답 동일' if same else f'유사도 {r:.2f}'} — {q['question'][:32]}")
            hit = True
    if not hit:
        print('       겹치는 문항 없음')
print()
for w in warn: print('  주의 ', w)
if blocking:
    print('\n!! 중복 — 여기서 중단합니다')
    for b in blocking: print('   ', b)
    sys.exit(1)
print('■ 통과 — 차단할 중복 없음' + (f' (주의 {len(warn)}건은 읽고 판단)' if warn else ''))
PY
```

**차단 조건에 걸리면 중단한다.** ID가 이미 있거나 질문 유사도가 0.70 이상이면 사실상 같은 문제다.
주제를 바꿔 다시 초안을 잡고 이 단계를 다시 밟는다.

`주의`로 뜬 항목(유사도 0.50~0.70, 정답 텍스트 동일)은 차단은 아니지만 **읽고 판단한다.**
질문 형태만 다르고 같은 지식을 묻는다면 바꾼다.

---

## 5단계 — 문제 추가 후 형식 검증

초안을 `data/<카테고리>.json` 배열 끝에 **Edit로** 덧붙인다.
`json.dump`로 파일을 다시 쓰면 한글이 `\uXXXX`로 바뀌고 서식이 무너진다.

키 순서와 들여쓰기는 기존 문항과 똑같이 맞춘다.

```json
  {
    "id": "history-012",
    "category": "history",
    "question": "...",
    "choices": ["...", "...", "...", "..."],
    "answerIndex": 0,
    "explanation": "...",
    "difficulty": "hard",
    "tags": ["...", "..."]
  }
```

쓴 뒤 바로 검증한다.

```bash
python3 - <<'PY'
"""5단계: 추가 후 형식 검증. 하나라도 걸리면 종료 코드 1."""
import json, glob, os, re, sys
CATEGORIES = ('history', 'science', 'geography', 'general')
LEVELS = ('easy', 'normal', 'hard')
REQUIRED = ('id', 'category', 'question', 'choices', 'answerIndex', 'explanation', 'difficulty', 'tags')
bad, ids, total = [], [], 0
for path in sorted(glob.glob('data/*.json')):
    cat = os.path.basename(path)[:-5]
    try:
        bank = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        bad.append(f'{path}: 파싱 실패 — {e}'); continue
    total += len(bank)
    for q in bank:
        qid = q.get('id', '?'); ids.append(qid)
        for k in REQUIRED:
            if k not in q or q[k] in (None, '', []): bad.append(f'{qid}: {k} 누락/빈값')
        ch, idx = q.get('choices') or [], q.get('answerIndex')
        if len(ch) != 4: bad.append(f'{qid}: 보기 {len(ch)}개')
        if len(set(ch)) != len(ch): bad.append(f'{qid}: 보기 중복')
        if not isinstance(idx, int) or not (0 <= idx < len(ch)): bad.append(f'{qid}: answerIndex {idx}')
        if q.get('category') != cat: bad.append(f'{qid}: category 불일치')
        if q.get('difficulty') not in LEVELS: bad.append(f'{qid}: difficulty {q.get("difficulty")}')
        if not re.fullmatch(r'[a-z]+-\d{3}', qid or ''): bad.append(f'{qid}: ID 형식')
d = sorted({i for i in ids if ids.count(i) > 1})
if d: bad.append(f'ID 중복: {d}')
raw = ''.join(open(p, encoding='utf-8').read() for p in glob.glob('data/*.json'))
if '\\u' in raw: bad.append('한글이 \\uXXXX 로 이스케이프됨 (json.dump 로 덮어쓴 흔적)')
print(f'■ 5단계 — 형식 검증 ({total}문항)')
if bad:
    print('  !! 실패 — 여기서 중단합니다')
    for b in bad: print('   ', b)
    sys.exit(1)
print('  통과 — 형식·정답 인덱스·ID·인코딩 이상 없음')
PY
```

**실패하면 중단한다.** 이때는 이미 파일을 고친 뒤이므로, 보고에 **되돌리는 명령**을 반드시 포함한다.

```bash
cp backups/<타임스탬프>-pre-edit/*.json data/
```

고칠 수 있는 사소한 실수(오타, 인덱스)면 고치고 이 단계를 다시 돌린다.
원인을 모르겠으면 되돌리고 멈춘다.

---

## 6단계 — 전체 데이터 백업

검증을 통과한 상태를 확정본으로 남긴다.

```bash
QUIZ_BACKUP_LABEL="verified" python3 - <<'PY'
"""백업: data/ 를 통째로 타임스탬프 폴더에 복사한다."""
import glob, json, os, shutil, sys
from datetime import datetime

label = os.environ.get('QUIZ_BACKUP_LABEL') or 'snapshot'
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
dest = os.path.join('backups', f'{stamp}-{label}')
try:
    os.makedirs(dest, exist_ok=False)
    files = sorted(glob.glob('data/*.json'))
    if not files:
        print('!! 백업할 파일이 없습니다'); sys.exit(1)
    total = 0
    for f in files:
        shutil.copy2(f, dest)
        total += len(json.load(open(f, encoding='utf-8')))
    (open(os.path.join(dest, 'MANIFEST.txt'), 'w', encoding='utf-8')
     .write(f'생성 {stamp}\n용도 {label}\n파일 {len(files)}개 / 문항 {total}개\n'
            + '\n'.join(f'  {os.path.basename(f)}' for f in files) + '\n'))
except Exception as e:
    print(f'!! 백업 실패 — {e}'); sys.exit(1)
print(f'■ 백업 완료 — {dest}  ({len(files)}개 파일 / {total}문항)')
print(f'  되돌리려면: cp {dest}/*.json data/')
PY
```

**실패하면 중단한다.** 다만 이 시점의 데이터는 이미 검증을 통과했으므로 데이터 자체는 성한 상태다.
디스크 문제인지 권한 문제인지 밝혀 보고한다.

---

## 7단계 — 실행 결과 상세 보고

아래를 빠짐없이 적는다.

**단계별 결과**

| 단계 | 결과 | 요약 |
| --- | --- | --- |
| 1. 구조 파악 | | 파일·필드 |
| 2. 현황 집계 | | 총 문항, 카테고리별 분포 |
| 3. 부족한 곳 | | 어디가 왜 부족한가 |
| 백업(사전) | | 경로 |
| 4. 중복 체크 | | 후보 수, 차단·주의 건수 |
| 5. 형식 검증 | | 통과 여부 |
| 6. 백업(확정) | | 경로 |

**추가한 문항** — ID, 문제, 정답, 난이도, 태그, 그리고 **왜 이 주제를 골랐는지**(3단계의 어느 빈 곳을 메우는지)

**교차 검증** — 무엇을 어떤 출처로 확인했는지. 확인 과정에서 값이 달랐다면 그 사실도

**버린 후보** — 중복이나 규칙에 걸려 뺀 것이 있으면 이유와 함께. 조용히 빼면 다음에 같은 주제를 또 시도한다

**검증이 필요한 문제** — 확신이 서지 않아 넣지 않은 것 (규칙 5번)

**변화** — 이번 실행으로 분포가 어떻게 달라졌는지. 2단계 숫자와 비교

**다음 일과에 할 것** — 남은 빈 곳

---

## 알아둘 것

- **백업은 두 번 뜬다.** 고치기 전(`pre-edit`)과 검증 통과 후(`verified`). 앞의 것이 롤백 지점이다
- `backups/` 는 저장소에 커밋하지 않는다. `.gitignore` 에 `backups/` 를 넣어 둔다
- 백업이 쌓이면 오래된 것을 지운다. 이 명령어는 지우지 않는다 — 지우는 일을 자동으로 하지 않는 편이 안전하다
- 문제 추가는 **JSON만 고친다.** 코드를 고쳐야 한다면 설계가 틀어진 것이다
- 이 명령어는 형식만 기계로 본다. **정답이 사실인지는 `/quiz-check`**, 최상급 표현은 `/quiz-validate`,
  은행 전체 통계는 `/quiz-stats` 가 본다. 일과를 마친 뒤 `/quiz-check <카테고리>` 를 한 번 더 돌리면 좋다
