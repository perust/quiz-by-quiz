"""문제 은행 배치 검증. 한 배치를 넣을 때마다 돌린다.

/quiz-add 의 4구획(검증)과 /quiz-validate 의 스캔을 한 번에 돌리고,
그 둘이 못 잡는 것 — 문항 중복, 정답 중복, 보기 안 겹침 — 을 더 본다.
문제 수가 500까지 가면 사람 눈으로는 중복을 못 잡기 때문이다.
"""
import json, glob, re, sys
from collections import Counter, defaultdict

CATEGORIES = ('history', 'science', 'geography', 'general', 'art')
KO = {'history': '한국사', 'science': '과학', 'geography': '지리',
      'general': '일반상식', 'art': '예술과문화'}
LEVELS = ('easy', 'normal', 'hard')
SUPERLATIVE = re.compile('|'.join([
    '가장', '제일', '최초', '최대', '최소', '최고', '최장', '최단', '최상', '유일', '으뜸',
    r'\d+\s*번째', r'[첫둘두셋세넷네]\s*번째', '첫째', '둘째', '셋째', r'\d+\s*위']))
# 기준·범위를 밝히는 말. 최상급 옆에 이런 말이 하나도 없으면 사람이 봐야 한다
QUALIFIER = re.compile(
    '면적|넓이|인구|길이|높이|깊이|수심|해발|지름|부피|무게|생산량|규모|수용|낙차|'
    '현존|기록상|상용화|공식|기준|가운데|중에서|중\\s|에서|나라|대륙|태양계|지구|'
    '대한민국|우리나라|세계|한반도|아프리카|아시아|유럽|일\\s*년|열두\\s*달|가까운')

fail, warn = [], []
banks, all_rows = {}, []

for code in CATEGORIES:
    path = f'data/{code}.json'
    try:
        bank = json.load(open(path, encoding='utf-8'))
    except Exception as error:
        fail.append(f'{path}: JSON 파싱 실패 — {error}')
        continue
    banks[code] = bank

    for q in bank:
        # ── 스키마 ────────────────────────────────────────────────
        for key in ('id', 'category', 'question', 'choices', 'answerIndex',
                    'explanation', 'difficulty', 'tags'):
            if key not in q:
                fail.append(f"[{q.get('id','?')}] 키 없음: {key}")
        if q.get('category') != code:
            fail.append(f"[{q.get('id')}] category 가 파일명과 다름: {q.get('category')}")
        choices = q.get('choices') or []
        if len(choices) != 4:
            fail.append(f"[{q.get('id')}] 보기가 {len(choices)}개")
        if len(set(choices)) != len(choices):
            fail.append(f"[{q.get('id')}] 보기에 같은 값이 두 번 들어감")
        idx = q.get('answerIndex')
        if not isinstance(idx, int) or not 0 <= idx < len(choices):
            fail.append(f"[{q.get('id')}] answerIndex 범위 밖: {idx}")
        if q.get('difficulty') not in LEVELS:
            fail.append(f"[{q.get('id')}] difficulty 규정 밖: {q.get('difficulty')}")
        if not (q.get('tags') or []):
            fail.append(f"[{q.get('id')}] tags 비어 있음")
        if not (q.get('explanation') or '').strip():
            fail.append(f"[{q.get('id')}] explanation 비어 있음")

        if len(choices) == 4 and isinstance(idx, int) and 0 <= idx < 4:
            correct = choices[idx]
            others = [c for i, c in enumerate(choices) if i != idx]
            all_rows.append({
                'id': q['id'], 'cat': code, 'q': q['question'], 'a': correct,
                'longest': len(correct) > max(len(c) for c in others),
                'diff': q.get('difficulty'), 'idx': idx,
            })

        # ── 최상급에 기준이 붙었는가 ───────────────────────────────
        for field in ('question', 'explanation'):
            text = q.get(field) or ''
            if SUPERLATIVE.search(text) and not QUALIFIER.search(text):
                warn.append(f"[{q.get('id')}] {field} 의 최상급에 기준·범위가 안 보임: {text[:46]}")

# ── ID 중복 (카테고리를 넘나들며) ──────────────────────────────────
ids = [r['id'] for r in all_rows]
for dup, n in Counter(ids).items():
    if n > 1:
        fail.append(f'ID 중복: {dup} ({n}번)')

# ── 문항 중복 ─────────────────────────────────────────────────────
def norm(s):
    return re.sub(r'[^가-힣a-zA-Z0-9]', '', s)

by_text = defaultdict(list)
for r in all_rows:
    by_text[norm(r['q'])].append(r['id'])
for text, group in by_text.items():
    if len(group) > 1:
        fail.append(f"문항 문장 중복: {', '.join(group)}")

# 같은 카테고리에서 정답이 겹치면 물어보는 각도가 같을 수 있다 (경고)
by_answer = defaultdict(list)
for r in all_rows:
    by_answer[(r['cat'], norm(r['a']))].append(r['id'])
for (cat, a), group in by_answer.items():
    if len(group) > 1:
        warn.append(f"{KO[cat]} 정답이 같은 문항: {', '.join(group)} → {a}")

# ── 요약 ─────────────────────────────────────────────────────────
print(f'문항 {len(all_rows)}개')
for code in CATEGORIES:
    rows = [r for r in all_rows if r['cat'] == code]
    if not rows:
        continue
    d = Counter(r['diff'] for r in rows)
    p = Counter(r['idx'] for r in rows)
    longest = sum(r['longest'] for r in rows)
    print(f"  {KO[code]:<6} {len(rows):>3}개 | "
          + ' '.join(f'{lv} {d.get(lv,0):>2}' for lv in LEVELS)
          + ' | 정답위치 ' + '/'.join(str(p.get(i, 0)) for i in range(4))
          + f' | 정답이 최장 {longest/len(rows)*100:.0f}%')

total_longest = sum(r['longest'] for r in all_rows)
print(f'전체 정답 길이 편향 {total_longest/len(all_rows)*100:.0f}% (무작위 기대 25%)')

if warn:
    print(f'\n확인 필요 {len(warn)}건')
    for w in warn:
        print('  ?', w)
if fail:
    print(f'\n실패 {len(fail)}건')
    for f in fail:
        print('  !!', f)
    sys.exit(1)
print('\n통과')
