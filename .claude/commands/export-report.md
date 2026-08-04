---
description: 선생님 리포트(teacher_report.html)를 읽어 CSV·PDF 로 내보낸다
argument-hint: [csv | pdf] — 생략하면 둘 다
allowed-tools: Bash(python3:*), Read
---

`teacher/teacher_report.html` 을 읽어 CSV 와 PDF 로 내보내줘.

| 입력 | 하는 일 |
| --- | --- |
| (생략) | CSV 와 PDF 모두 |
| `csv` | CSV 만 |
| `pdf` | PDF 만 |

## 먼저 리포트가 있어야 한다

이 명령어는 **읽기만 한다.** 리포트를 만들지 않는다.
`teacher/teacher_report.html` 이 없으면 종료 코드 1로 멈춘다.
그때는 **`/teacher-dashboard` 를 먼저 돌려** 리포트를 만든다.

리포트 HTML 안에는 표를 그리는 마크업과 함께 **원본 데이터가 JSON 으로 박혀 있다**
(`<script type="application/json" id="report-data">`). 이 명령어는 표를 긁지 않고
그 JSON 을 읽는다. 화면 서식이 바뀌어도 내보내기가 깨지지 않는다.

## 1. 실행

```bash
QUIZ_ARGS="$ARGUMENTS" python3 - <<'PY'
"""teacher/teacher_report.html 을 읽어 CSV·PDF 로 내보낸다."""
import csv, json, os, re, shutil, subprocess, sys
from datetime import datetime

REPORT = 'teacher/teacher_report.html'
OUT_DIR = 'teacher/export'
want = (os.environ.get('QUIZ_ARGS') or '').strip().lower()
if re.fullmatch(r'\$\w+', want):
    want = ''
do_csv = 'pdf' not in want or 'csv' in want
do_pdf = 'pdf' in want or want == ''

if not os.path.exists(REPORT):
    print(f'!! {REPORT} 가 없습니다. 먼저 /teacher-dashboard 를 돌려 리포트를 만드세요.')
    sys.exit(1)

html = open(REPORT, encoding='utf-8').read()
m = re.search(r'<script type="application/json" id="report-data">(.*?)</script>', html, re.S)
if not m:
    print('!! 리포트에서 데이터 블록을 찾지 못했습니다.')
    print('   손으로 고친 파일이거나 예전 형식입니다. /teacher-dashboard 로 다시 만드세요.')
    sys.exit(1)
try:
    data = json.loads(m.group(1))
except Exception as e:
    print(f'!! 데이터 블록 파싱 실패 — {e}')
    sys.exit(1)

os.makedirs(OUT_DIR, exist_ok=True)
stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
print(f'■ 원본  {REPORT}')
print(f'  생성 {data.get("generatedAt", "?")} · 학생 {data.get("studentCount")}명 · 응시 {data.get("recordCount")}건')

made = []


def write_csv(name, header, rows):
    """엑셀이 한글을 깨뜨리지 않도록 BOM 을 붙인다."""
    path = os.path.join(OUT_DIR, f'{stamp}-{name}.csv')
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    made.append((path, len(rows)))


if do_csv:
    cats = [c['name'] for c in data['categories']]
    write_csv('students',
              ['학생', '등급', '순위', '상위비율', '평균정답률', '응시수', '미응시분야'] + cats,
              [[s['name'], s['grade'], s['rank'], f"{s['topRatio']*100:.0f}%",
                f"{s['overall']*100:.0f}%", s['attempts'], ', '.join(s['missing'])]
               + [(f"{s['categories'][c]*100:.0f}%" if c in s['categories'] else '미응시') for c in cats]
               for s in data['students']])

    write_csv('categories', ['분야', '평균정답률', '편차', '응시인원'],
              [[c['name'], f"{c['mean']*100:.0f}%", f"{c['spread']*100:.0f}%p", c['takers']]
               for c in data['categories']])

    if data.get('items'):
        write_csv('items', ['문항ID', '분야', '난이도', '정답률', '시간초과율', '응시수', '문제'],
                  [[i['id'], i['category'] or '', i['difficulty'],
                    f"{i['accuracy']*100:.0f}%", f"{i['timeoutRate']*100:.0f}%",
                    i['attempts'], i['question']] for i in data['items']])
    else:
        print('  ※ 문항별 기록이 없어 items.csv 는 만들지 않았습니다.')

    write_csv('tips', ['번호', '제안'], [[i, t] for i, t in enumerate(data.get('tips', []), 1)])

    print(f'\n■ CSV {len(made)}개')
    for path, rows in made:
        print(f'  {path}  ({rows}행)')
    print('  엑셀에서 바로 열리도록 UTF-8 BOM 을 붙였습니다.')

if do_pdf:
    print('\n■ PDF')
    pdf_path = os.path.join(OUT_DIR, f'{stamp}-report.pdf')
    chrome = next((p for p in (
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        shutil.which('google-chrome') or '', shutil.which('chromium') or '',
    ) if p and os.path.exists(p)), None)

    if not chrome:
        print('  크롬을 찾지 못했습니다. 브라우저로 직접 내보내세요.')
        print(f'  1) {REPORT} 를 브라우저로 연다')
        print('  2) Cmd+P (윈도우는 Ctrl+P) → 대상을 «PDF로 저장»')
        print('  리포트에 인쇄용 스타일이 들어 있어 표가 페이지 사이에서 잘리지 않습니다.')
    else:
        try:
            subprocess.run([chrome, '--headless', '--disable-gpu', '--no-pdf-header-footer',
                            f'--print-to-pdf={os.path.abspath(pdf_path)}',
                            'file://' + os.path.abspath(REPORT)],
                           check=True, capture_output=True, timeout=90)
            size = os.path.getsize(pdf_path)
            print(f'  {pdf_path}  ({size:,}바이트)')
        except Exception as e:
            print(f'  자동 변환 실패 — {type(e).__name__}')
            print(f'  브라우저로 {REPORT} 를 열고 Cmd+P → «PDF로 저장» 하세요.')

print('\n■ 주의')
print('  내보낸 파일에는 학생 이름과 성적이 들어 있습니다. teacher/ 는 .gitignore 로 제외돼 있지만,')
print('  메일이나 메신저로 보낼 때는 받는 사람을 확인하세요. 학생 개인에게는 본인 행만 떼어 전달합니다.')
PY
```

## 2. 나오는 것

모두 `teacher/export/` 에 타임스탬프를 붙여 쌓인다. 덮어쓰지 않으므로 이전 회차와 비교할 수 있다.

| 파일 | 내용 |
| --- | --- |
| `<시각>-students.csv` | 학생별 등급·순위·상위비율·평균·분야별 정답률·미응시 |
| `<시각>-categories.csv` | 분야별 평균·편차·응시 인원 |
| `<시각>-items.csv` | 문항별 정답률·시간초과율·난이도·문제 (전 문항) |
| `<시각>-tips.csv` | 교육 제안 목록 |
| `<시각>-report.pdf` | 리포트 전체 |

**CSV 에는 UTF-8 BOM 을 붙인다.** 안 붙이면 엑셀이 한글을 깨뜨린다.

**`items.csv` 는 문항별 기록이 있을 때만 만든다.** 앱 개선 이전에 푼 기록에는 문항 정오가 없다.
없으면 그 사실을 알리고 나머지만 내보낸다.

## 3. PDF 는 어떻게 만드나

**의존성을 새로 깔지 않는다.** 이 프로젝트는 npm 패키지도 파이썬 라이브러리도 쓰지 않기로 했다.

그래서 **이미 깔려 있는 크롬을 헤드리스로 불러** 인쇄한다. 크롬이 없으면 자동 변환을 포기하고
브라우저로 직접 내보내는 방법을 안내한다.

```
1) teacher/teacher_report.html 을 브라우저로 연다
2) Cmd+P (윈도우는 Ctrl+P) → 대상을 «PDF로 저장»
```

리포트에 인쇄용 스타일(`@media print`)이 들어 있어 표가 페이지 사이에서 잘리지 않는다.
자동이든 수동이든 결과는 같다.

## 4. 보고

- 어떤 파일을 몇 개 만들었는지, 각 몇 행인지
- **PDF 를 자동 변환했는지 수동 안내로 넘겼는지.** 이걸 밝히지 않으면 사용자가 파일이 있는 줄 안다
- `items.csv` 를 건너뛰었으면 그 이유
- 마지막에 개인정보 주의를 반드시 붙인다

## 개인정보

**내보낸 파일에는 학생 이름과 성적이 들어 있다.**

- `teacher/` 는 `.gitignore` 로 제외돼 있어 커밋되지 않는다
- **저장소 루트가 곧 배포 루트다** (`SOURCE_DIR: .`). 리포트를 루트에 두면 공개 사이트에 올라간다.
  그래서 `teacher/` 안에 쓴다. 이 경로를 바꾸지 말 것
- 메일이나 메신저로 보낼 때는 받는 사람을 확인한다
- **학생 개인에게는 본인 행만 떼어 전달한다.** 다른 학생 이름이 든 표를 그대로 주지 않는다
- 성적표 형태로 줄 것이 필요하면 `/create-report` 를 쓴다

## 알아둘 것

- 이 명령어는 리포트를 **읽기만 한다.** 제출 파일도 문제 은행도 고치지 않는다
- 리포트를 손으로 고쳤거나 예전 형식이면 데이터 블록을 못 찾아 멈춘다.
  그때는 `/teacher-dashboard` 로 다시 만든다
- `teacher/export/` 가 쌓이면 오래된 것을 지운다. 이 명령어는 지우지 않는다 —
  지우는 일을 자동으로 하지 않는 편이 안전하다
