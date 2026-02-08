`quiz-challenge/src/data/students.ts`의 학생 데이터를 읽어 CSV 또는 PDF로 내보냅니다.

## 매개변수

- `$ARGUMENTS`: 내보내기 형식 (필수)
  - `csv` — CSV 파일로 저장
  - `pdf` — 브라우저에서 PDF 인쇄 화면 열기
  - 빈값 — 형식을 안내하고 중단

## 작업 순서

### Step 1: 파일 읽기

`quiz-challenge/src/data/students.ts` 파일을 읽습니다.

**파일이 없으면** 아래를 출력하고 중단합니다:

```
## ❌ 학생 데이터가 없습니다

`/quiz-teacher-register 이름 점수`로 학생을 먼저 등록하세요.
```

### Step 2: 데이터 파싱

students 배열에서 각 학생의 **최신 결과**(results 배열의 마지막 항목)를 기준으로 아래 데이터를 추출합니다:

- 이름, 등록일, 응시횟수
- 최신 총점, 등급 (label)
- 카테고리별 점수 (한국사, 과학, 지리, 예술과문화)
- 최신 응시일

### Step 3: 형식별 내보내기

---

#### 3A: CSV (`$ARGUMENTS`가 `csv`일 때)

`quiz-challenge/public/report.csv` 파일을 생성합니다.

**CSV 형식:**

```csv
이름,등록일,응시횟수,최신응시일,총점,등급,한국사,과학,지리,예술과문화
김민준,2026.02.05 09:00,2,2026.02.07 14:20,37,A,10,9,9,9
이서연,2026.02.05 09:00,1,2026.02.05 10:00,28,B,7,6,8,7
```

마지막에 요약 행을 추가합니다:

```csv
[반 평균],,,,[반평균점수],[반평균등급],[한국사평균],[과학평균],[지리평균],[예술평균]
```

파일 저장 후 아래를 출력합니다:

```
## ✅ CSV 내보내기 완료

📁 `quiz-challenge/public/report.csv`
- 학생 N명의 성적 데이터
- 반 평균 요약 행 포함

터미널에서 확인: `cat quiz-challenge/public/report.csv`
```

---

#### 3B: PDF (`$ARGUMENTS`가 `pdf`일 때)

1. `quiz-challenge/public/teacher-dashboard.html` 파일이 존재하는지 확인합니다.
2. **HTML이 있으면**: `quiz-challenge/src/data/students.ts`의 현재 데이터로 `teacher-dashboard.html` 내 `const students = [...]` 부분을 동기화합니다.
3. `open quiz-challenge/public/teacher-dashboard.html` 명령으로 브라우저에서 엽니다.

출력:

```
## 📄 PDF 내보내기 준비

브라우저에서 대시보드가 열렸습니다.

### PDF 저장 방법
1. **⌘ + P** (또는 Ctrl + P) 로 인쇄 대화상자를 엽니다
2. 대상을 **"PDF로 저장"** 으로 변경합니다
3. **저장** 을 클릭합니다

> 💡 커맨드 가이드 섹션은 자동으로 제외됩니다 (인쇄 스타일 적용)
```

**HTML이 없으면**: 아래를 출력하고 중단합니다:

```
## ❌ 대시보드 HTML 파일이 없습니다

`quiz-challenge/public/teacher-dashboard.html` 파일을 먼저 생성해 주세요.
```

---

#### 3C: 형식 미지정 (`$ARGUMENTS`가 빈값 또는 다른 값일 때)

```
## 📦 보고서 내보내기

사용법: `/export-report [형식]`

| 형식 | 설명 | 출력 파일 |
|------|------|-----------|
| `csv` | 학생 성적 데이터를 CSV로 저장 | `public/report.csv` |
| `pdf` | 브라우저에서 PDF 인쇄 화면 열기 | 브라우저 인쇄 |

### 예시
- `/export-report csv` — CSV 파일 생성
- `/export-report pdf` — 브라우저에서 PDF 저장
```
