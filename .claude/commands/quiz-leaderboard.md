---
description: 순위 시스템의 규칙과 경계를 점검하고, 브라우저에 쌓인 기록을 다루는 방법을 준다
argument-hint: [review | records | (생략하면 점검)]
allowed-tools: Bash(python3:*), Read
---

순위(랭킹) 시스템을 점검해줘.

**먼저 알아야 할 것: 랭킹 기록은 이 저장소에 없다.** 각 방문자의 브라우저 `localStorage` 에만
쌓이고 서버로 오지 않는다(PRD 9.1). 그래서 이 명령어는 기록을 읽어 순위표를 그리지 못한다.
대신 **순위를 만드는 규칙과 코드 경계가 성한지** 점검하고, 내 브라우저의 기록을 다룰 방법을 준다.

인자에 따라 하는 일이 달라진다.

| 인자 | 하는 일 |
| --- | --- |
| (생략) | 규칙·경계 점검 |
| `review` | 점검 + 코드를 읽고 개선점 제안 |
| `records` | 내 브라우저 기록을 보고·내보내고·지우는 방법 |

## 1. 점검 (기본)

아래를 그대로 실행한다. FR 요구사항이 코드에 살아 있는지 기계적으로 확인한다.

```bash
python3 - <<'PY'
import glob, os, re

def strip_comments(text):
    # 주석에 적힌 window.confirm 같은 말이 호출로 오인되지 않게 걷어낸다
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'^\s*//.*$', '', text, flags=re.M)


def read(p):
    try:
        return open(p, encoding='utf-8').read()
    except OSError:
        return ''

src = {p: read(p) for p in glob.glob('js/**/*.js', recursive=True)}
joined = '\n'.join(src.values())
core = {p: t for p, t in src.items() if p.startswith('js/core/')}
ui = {p: t for p, t in src.items() if p.startswith('js/ui/')}

checks = []
def ok(name, cond, detail=''):
    checks.append((cond, name, detail))

# FR-6.8 / 6.9 — 어댑터 경계
adapter = read('js/storage/adapter.js')
store = read('js/storage/local-store.js')
iface = ['saveRecord', 'getRankings', 'getBestScore', 'clearAll']
ok('어댑터 인터페이스 4종', all(m in store for m in iface),
   ', '.join(m for m in iface if m not in store) or '전부 존재')
ok('모든 메서드가 async (Promise 반환)',
   all(re.search(rf'async {m}\s*\(', store) for m in iface),
   ', '.join(m for m in iface if not re.search(rf'async {m}\s*\(', store)) or 'OK')
ok('교체 지점이 adapter.js 한 곳', 'createLocalRankingStore()' in adapter,
   'rankingStore export')

# localStorage 경계
touch = sorted(p for p, t in src.items() if 'window.localStorage' in t)
ok('localStorage 직접 호출이 한 파일뿐', touch == ['js/storage/local-store.js'], ', '.join(touch) or '없음')
leak = sorted(p for p, t in {**core, **ui}.items() if 'storage/' in t)
ok('core·ui가 저장소를 import하지 않음', not leak, ', '.join(leak) or '없음')
ok('core에 DOM 참조 없음',
   not any(re.search(r'\b(document|window)\.', t) for t in core.values()),
   ', '.join(p for p, t in core.items() if re.search(r'\b(document|window)\.', t)) or '없음')

# FR-6.3 — 정렬 규칙
rank = read('js/core/ranking.js')
ok('점수 내림차순 정렬', 'b.score - a.score' in rank)
ok('동점 시 먼저 달성한 순', 'playedAtValue(a) - playedAtValue(b)' in rank)
ok('소요 시간이 정렬에 안 쓰임', 'durationMs' not in rank, 'durationMs 미등장')
ok('깨진 시각은 뒤로', 'POSITIVE_INFINITY' in rank)

# FR-6.4 — 상위 N
const = read('js/constants.js')
m = re.search(r'RANKING_TOP_N\s*=\s*(\d+)', const)
ok('RANKING_TOP_N 상수 존재', bool(m), f'값 {m.group(1)}' if m else '없음')
ok('저장 시에도 상위 N개로 자름', 'placeRecord' in store and 'RANKING_TOP_N' in store)

# PRD 8 — 무결성
ok('레코드 단위 검증', 'isValidRecord' in store)
ok('배열 아님/파싱 실패 복구', 'Array.isArray(parsed)' in store and 'warnOnce' in store)
ok('스키마 버전 관리', 'ensureSchemaVersion' in store and 'quiz.schemaVersion' in store)

# FR-6.5 / 6.10 / 6.12 — 화면
lb = read('js/ui/ranking.js')
html = read('index.html')
ok('방금 등록 기록 강조', 'ranking-item--mine' in lb and '방금 등록' in lb)
ok('저장 범위 안내 문구', '이 브라우저에 저장된' in html)
ok('빈 상태 안내', 'ranking-empty' in lb and '아직 없습니다' in lb)
ok('목록에 소요 시간 미표시', 'durationMs' not in lb, 'durationMs 미등장')
modal = re.search(r'\bwindow\.(confirm|alert|prompt)\s*\(', strip_comments(joined))
ok('브라우저 모달 미사용', not modal, modal.group(0) if modal else '없음')
ok('초기화가 인페이지 다이얼로그', 'clear-dialog' in lb and 'confirmClear' in lb)

width = max(len(n) for _, n, _ in checks)
passed = sum(1 for c, _, _ in checks if c)
print(f'■ 순위 시스템 점검 — {passed}/{len(checks)} 통과\n')
for cond, name, detail in checks:
    print(f"  {'OK  ' if cond else '!!  '}{name:<{width}}  {detail}")
if passed != len(checks):
    print('\n실패 항목은 FR 위반이거나 리팩터링 중 경계가 무너진 것이다. 코드를 열어 확인한다.')
PY
```

실패한 항목이 있으면 해당 파일을 열어 **왜 깨졌는지** 밝힌다. 검사 자체가 오탐일 수도 있으니
코드를 보고 판단한다. 실제로 규칙이 깨졌다면 어느 FR 위반인지 적고 고칠 방법을 제안한다.

## 2. 규칙 요약

점검 결과와 함께 현재 시스템이 어떻게 도는지 정리한다.

| 항목 | 현재 구현 | 근거 |
| --- | --- | --- |
| 저장 위치 | | |
| 정렬 기준 | | FR-6.3 |
| 동점 처리 | | FR-6.3 |
| 보관 개수 | | FR-6.4 |
| 랭킹 구분 | | FR-6.2 |
| 소요 시간 반영 | | PRD 2.1 |
| 손상 복구 | | PRD 8 |
| 교체 지점 | | FR-6.8 |

**소요 시간이 순위에 들어가지 않는 것은 실수가 아니다.** 곱씹을 시간을 보장한다는
설계 원칙(PRD 2.1)과 충돌해서 뺀 것이다. "속도도 반영하면 좋겠다"는 개선 제안을 내지 않는다.

## 3. `review` — 코드 리뷰

점검을 마친 뒤 아래를 읽고 개선점을 찾는다.

- `js/core/ranking.js` — 정렬·상위 N·최고 점수. 순수 함수라 저장소를 모른다
- `js/storage/local-store.js` — localStorage 구현체. 손상 복구와 스키마 버전
- `js/storage/adapter.js` — 인터페이스와 교체 지점
- `js/ui/ranking.js` — 탭·목록·초기화 다이얼로그
- `js/app.js` — 등록 흐름 (`registerRecord`)

볼 것: 정렬 안정성, 동점·빈 목록·같은 닉네임 같은 경계 상황, 상위 10위 밖 기록의 처리,
저장 실패(용량 초과) 시 사용자에게 알리는지, 접근성.

제안은 `🔴 필수 / 🟡 권장 / 🟢 선택` 으로 나눠 우선순위를 붙인다.
**지시 없이 파일을 고치지 않는다.**

## 4. `records` — 내 브라우저 기록 다루기

CLI로는 못 읽으므로 브라우저 콘솔에서 실행할 것을 준다. 게임을 연 탭에서 F12 → Console 이다.

**기록 보기**

```js
JSON.parse(localStorage.getItem('quiz.rankings') || '[]')
  .sort((a, b) => b.score - a.score || Date.parse(a.playedAt) - Date.parse(b.playedAt))
  .forEach((r, i) => console.log(
    `${i + 1}. ${r.nickname} ${r.score}점 (${r.correctCount}/${r.totalCount}) ` +
    `${r.mode === 'all' ? '전체' : r.category} ${r.playedAt.slice(0, 10)}`));
```

**CSV로 내보내기** — 클립보드에 복사된다

```js
copy(['nickname,mode,category,score,correctCount,totalCount,durationMs,playedAt']
  .concat(JSON.parse(localStorage.getItem('quiz.rankings') || '[]')
    .map(r => [r.nickname, r.mode, r.category ?? '', r.score, r.correctCount,
               r.totalCount, r.durationMs, r.playedAt].join(','))).join('\n'));
```

**지우기** — 앱의 랭킹 화면에 있는 `전체 기록 초기화` 버튼을 쓰는 편이 낫다.
확인 절차가 있고 어댑터를 거친다(FR-6.6). 콘솔로 지우려면 아래다.

```js
localStorage.removeItem('quiz.rankings');  // 닉네임·설정은 남는다
```

기록을 지우는 것은 되돌릴 수 없다. 먼저 CSV로 내보내라고 안내한다.

## 알아둘 것

- **v1 랭킹은 경쟁용이 아니다.** 배포해서 여러 사람이 들어와도 기록은 공유되지 않는다.
  자기 최고 기록 갱신용이고, 사용자 간 경쟁은 서버를 붙여야 성립한다(PRD 9.1)
- 서버 랭킹으로 갈 때 고칠 곳은 `js/storage/adapter.js` 의 `rankingStore` 한 줄이다.
  점검 항목에 그 경계가 들어 있는 이유가 이것이다
- 문제 은행 통계는 `/quiz-stats`, 문항 검토는 `/quiz-range` 다. 이 명령어는 순위 시스템만 본다
