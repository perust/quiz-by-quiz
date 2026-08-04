---
description: 문제 은행의 통계를 집계하고 균형이 무너진 곳을 짚는다
argument-hint: [카테고리 (한국사·과학·지리·일반상식, 생략하면 전체)]
allowed-tools: Bash(python3:*), Read
---

문제 은행의 통계를 내고 **균형이 무너진 곳**을 짚어줘.

숫자를 늘어놓는 게 목적이 아니다. 어디가 치우쳤고 다음에 무엇을 채워야 하는지가 나와야 한다.

## 1. 집계

아래를 그대로 실행한다.

```bash
QUIZ_CATEGORY="$ARGUMENTS" python3 - <<'PY'
import json, glob, os, re
from collections import Counter

CATEGORIES = ('history', 'science', 'geography', 'general')
ALIASES = {'한국사': 'history', '과학': 'science', '지리': 'geography', '일반상식': 'general'}
NAMES = {c: k for k, c in ALIASES.items()}
LEVELS = ('easy', 'normal', 'hard')
# 이 프로젝트가 정한 목표. 카테고리당 easy 4 / normal 4 / hard 2
TARGET = {'easy': 0.40, 'normal': 0.40, 'hard': 0.20}

raw = (os.environ.get('QUIZ_CATEGORY') or '').strip()
if re.fullmatch(r'\$\w+', raw):
    raw = ''
target = raw.lower() if raw.lower() in CATEGORIES else ALIASES.get(raw)
if raw and target is None:
    print(f"'{raw}'은(는) 카테고리가 아닙니다. 전체를 봅니다.\n")

banks = {}
for path in sorted(glob.glob('data/*.json')):
    cat = os.path.basename(path)[:-5]
    try:
        banks[cat] = json.load(open(path, encoding='utf-8'))
    except Exception as e:
        print(f'!! {path} 읽기 실패: {e}')
        banks[cat] = []
scope = [target] if target else [c for c in CATEGORIES if c in banks]
items = [q for c in scope for q in banks.get(c, [])]
if not items:
    print('대상 문항이 없습니다.'); raise SystemExit

bar = lambda ratio, width=20: '█' * round(ratio * width)
print(f"대상: {NAMES[target] if target else '전체 카테고리'} · {len(items)}문항\n")

print('■ 개요')
print(f'  총 문항       {len(items)}')
for c in scope:
    n = len(banks.get(c, []))
    nums = sorted(int(m.group(1)) for q in banks.get(c, []) if (m := re.search(r'-(\d+)$', q['id'])))
    gaps = [i for i in range(1, (max(nums) if nums else 0) + 1) if i not in nums]
    print(f'  {NAMES[c]:<5} {n:>3}문항  ID {min(nums) if nums else "-"}~{max(nums) if nums else "-"}'
          + (f'  빈 번호 {gaps}' if gaps else '  연속'))

print('\n■ 난이도 (목표 easy 40% / normal 40% / hard 20%)')
diff = Counter(q.get('difficulty') for q in items)
dev_total = 0
for lv in LEVELS:
    n = diff.get(lv, 0); r = n / len(items); d = r - TARGET[lv]; dev_total += abs(d)
    print(f'  {lv:<7} {n:>3}개 {r*100:5.1f}%  목표 {TARGET[lv]*100:.0f}%  편차 {d*100:+5.1f}%  {bar(r)}')
print(f'  편차 합 {dev_total*100:.1f}%p → ' + ('양호' if dev_total <= 0.15 else '보통' if dev_total <= 0.30 else '불균형'))

if not target:
    print('\n■ 카테고리별 난이도')
    print(f"  {'카테고리':<7}{'easy':>6}{'normal':>8}{'hard':>6}   편차합  판정")
    for c in scope:
        part = banks.get(c, [])
        if not part: continue
        cc = Counter(q.get('difficulty') for q in part)
        dv = sum(abs(cc.get(lv, 0) / len(part) - TARGET[lv]) for lv in LEVELS)
        verdict = '양호' if dv <= 0.15 else '보통' if dv <= 0.30 else '불균형'
        print(f"  {NAMES[c]:<7}{cc.get('easy',0):>6}{cc.get('normal',0):>8}{cc.get('hard',0):>6}   {dv*100:5.1f}%p  {verdict}")

print('\n■ 정답 위치 (이상 각 25%)')
pos = Counter(q.get('answerIndex') for q in items)
dev = sum(abs(pos.get(i, 0) / len(items) - 0.25) for i in range(4))
for i in range(4):
    n = pos.get(i, 0); r = n / len(items)
    print(f'  {i}번 {n:>3}개 {r*100:5.1f}%  {bar(r)}')
print(f'  편차 합 {dev*100:.1f}%p → ' + ('양호' if dev <= 0.20 else '보통' if dev <= 0.40 else '불균형'))
print('  ※ 런타임에 보기를 매 판 섞으므로 플레이에는 영향이 없다 (sampler.shuffleChoices)')

print('\n■ 문항 길이')
def stat(vals):
    vals = sorted(vals)
    return f'최소 {vals[0]:>3}  중앙 {vals[len(vals)//2]:>3}  최대 {vals[-1]:>3}  평균 {sum(vals)/len(vals):5.1f}'
print(f"  질문   {stat([len(q['question']) for q in items])}")
print(f"  해설   {stat([len(q['explanation']) for q in items])}")
print(f"  보기   {stat([len(c) for q in items for c in q['choices']])}")
longest = [q for q in items if len(q['choices'][q['answerIndex']]) > max(len(c) for i, c in enumerate(q['choices']) if i != q['answerIndex'])]
print(f'  정답이 최장인 문항  {len(longest)}개 / {len(items)} ({len(longest)/len(items)*100:.0f}%, 무작위 기대 25%)')
for q in longest:
    print(f"     [{q['id']}] {q['choices'][q['answerIndex']]}")

print('\n■ 태그')
tags = Counter(t for q in items for t in (q.get('tags') or []))
print(f'  종류 {len(tags)}개 · 문항당 평균 {sum(len(q.get("tags") or []) for q in items)/len(items):.1f}개')
print('  ' + ', '.join(f'{t}({n})' for t, n in tags.most_common(14)))
once = [t for t, n in tags.items() if n == 1]
if once:
    print(f'  한 번만 쓰인 태그 {len(once)}개: ' + ', '.join(once[:12]) + ('…' if len(once) > 12 else ''))
PY
```

## 2. 판정

### 난이도

목표는 **카테고리당 easy 4 / normal 4 / hard 2** (40% / 40% / 20%)다.
v1 목표가 "성인이 절반 이상 맞히는 수준"(3-A)이라 easy 쪽으로 기울여 잡은 값이다.

- `hard` 가 0이면 상위권이 갈리지 않는다. 만점자가 몰려 동점 처리(먼저 달성한 순)로만 순위가 정해진다
- `easy` 가 과하면 변별이 안 되고, 적으면 초심자가 첫 판에서 이탈한다
- 카테고리 간 편차도 본다. 한 카테고리만 무르면 전체 도전에서 그 구간이 헐거워진다

### 정답 위치

이상은 각 25%다. 다만 **런타임에 보기를 매 판 섞으므로(`sampler.shuffleChoices`) 플레이에는 영향이 없다.**
쏠림을 발견해도 "찍으면 맞는다"고 쓰면 틀린 말이다. 작성 습관을 드러내는 신호이자,
고정 세트 챌린지(PRD 12)처럼 셔플이 빠지는 모드를 붙일 때를 위한 대비로만 보고한다.

### 문항 길이

- **정답이 최장인 비율**이 중요하다. 이건 셔플로도 가려지지 않아 위치와 무관하게 티가 난다(3-A).
  무작위면 25% 근처다. 뚜렷이 높으면 해당 문항의 오답 보기를 늘리라고 제안한다
- 질문이 유독 긴 문항은 20초 안에 읽고 답하기 벅찬지 본다
- 해설은 1~2문장이 기준이다. 지나치게 긴 것이 있으면 짚는다

### 태그

- 한 번만 쓰인 태그가 많으면 갈래가 흩어진 것이다. 기존 태그로 묶을 수 있는지 본다
- 특정 태그에 몰려 있으면 주제가 편중된 것이다. 한국사가 전부 조선이면 시대가 좁다

### ID 연속성

빈 번호가 있으면 문제를 지운 흔적이다. **지운 번호를 다시 쓰면 안 된다** (FR-1.8).
다음 번호는 항상 최대값 + 1이다.

## 3. 출력

집계 숫자를 그대로 옮기지 말고 **판정을 붙여서** 낸다.

1. **한 줄 요약** — 대상, 문항 수, 가장 눈에 띄는 불균형 하나
2. **난이도** — 분포와 목표 대비 편차, 카테고리 간 비교
3. **정답 위치** — 분포와 길이 편향. 셔플 때문에 실제 영향은 없다는 점을 함께 적는다
4. **주제 분포** — 태그로 본 편중과 빈 곳
5. **다음에 채울 것** — 구체적으로. "hard를 늘리세요"가 아니라
   "과학에 hard 2문항이 필요하고, 태그를 보면 물리 쪽이 비어 있습니다"까지 간다

손댈 것이 없으면 "균형 양호, 손댈 것 없음"이라고 분명히 쓴다.

## 알아둘 것

- **플레이 기록은 볼 수 없다.** 점수·정답률·소요 시간은 각 방문자의 브라우저 `localStorage` 에만
  있고 서버로 오지 않는다(PRD 9.1). 이 명령어가 다루는 건 **문제 은행의 통계**뿐이다.
  내 브라우저에 쌓인 기록을 보려면 `/quiz-leaderboard` 를 쓴다
- `/quiz-range` 와 겹쳐 보이지만 쓰임이 다르다. 그쪽은 **번호 범위를 지정해 문항을 하나씩 검토**하고,
  이쪽은 **은행 전체의 현황과 공백**을 본다. 문제를 새로 쓰기 전에는 이쪽, 쓴 뒤 점검은 그쪽이다
- 목표 비율(40/40/20)은 이 프로젝트가 정한 값이다. 바꾸려면 스크립트의 `TARGET` 을 고친다
