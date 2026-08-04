# 상식왕 퀴즈 챌린지 - 프로젝트 가이드

## 프로젝트 개요
React + TypeScript 기반의 웹 퀴즈 게임 애플리케이션입니다.
4개 카테고리(한국사, 과학, 지리, 예술과문화)에서 총 40문제를 풀고 등급을 받는 게임입니다.

## 기술 스택
- React 18
- TypeScript
- Tailwind CSS 3
- Create React App

## 프로젝트 구조
```
src/
├── components/          # UI 컴포넌트
│   ├── StartScreen.tsx      # 시작 화면 (닉네임 입력)
│   ├── CategorySelect.tsx   # 카테고리 선택 화면
│   ├── QuizScreen.tsx       # 퀴즈 진행 화면
│   ├── FeedbackOverlay.tsx  # 정답/오답 피드백
│   ├── ResultScreen.tsx     # 결과 화면
│   ├── Leaderboard.tsx      # 순위표
│   ├── ProgressBar.tsx      # 진행률 바
│   └── ErrorBoundary.tsx    # 에러 바운더리
├── data/
│   └── questions.ts     # 퀴즈 문제 데이터 (40문제)
├── hooks/
│   └── useQuizGame.ts   # 게임 상태 관리 커스텀 훅
├── types/
│   └── index.ts         # TypeScript 타입 정의
├── utils/
│   └── helpers.ts       # 유틸리티 함수
├── App.tsx              # 메인 앱 컴포넌트
└── index.css            # Tailwind CSS + 커스텀 스타일
```

## 주요 타입
```typescript
type Category = "한국사" | "과학" | "지리" | "예술과문화";
type Difficulty = "쉬움" | "보통" | "어려움";
type Screen = "start" | "category" | "quiz" | "result" | "leaderboard";

interface Question {
  id: number;
  category: Category;
  difficulty: Difficulty;
  question: string;
  options: [string, string, string, string];
  answer: 0 | 1 | 2 | 3;
  explanation: string;
}
```

## 게임 플로우
1. 시작 화면 → 닉네임 입력
2. 카테고리 선택 (4개 중 택1)
3. 퀴즈 10문제 진행 (문제별 즉시 피드백)
4. 카테고리 완료 → 카테고리 선택으로 복귀
5. 4개 카테고리 모두 완료 → 결과 화면
6. 순위표 등록 (선택)

## 등급 시스템
| 등급 | 점수 범위 | 타이틀 |
|-----|----------|--------|
| S   | 38-40    | 상식왕 |
| A   | 32-37    | 박학다식 |
| B   | 24-31    | 준수함 |
| C   | 16-23    | 노력필요 |
| D   | 0-15     | 기초부터 |

## 카테고리 컬러
- 한국사: `red-500` (#EF4444)
- 과학: `blue-500` (#3B82F6)
- 지리: `green-500` (#22C55E)
- 예술과문화: `purple-500` (#A855F7)

## 개발 명령어
```bash
npm start       # 개발 서버 실행 (localhost:3000)
npm run build   # 프로덕션 빌드
npm test        # 테스트 실행
```

## 코딩 컨벤션

### 컴포넌트
- 함수형 컴포넌트 + TypeScript 사용
- Props 인터페이스는 컴포넌트 파일 내에 정의
- default export 사용

### 스타일링
- Tailwind CSS 클래스 사용
- 커스텀 애니메이션은 `index.css`의 `@layer utilities`에 정의
- 반응형: `sm:` (640px), `md:` (768px), `lg:` (1024px)

### 상태 관리
- `useQuizGame` 훅에서 전체 게임 상태 관리
- 외부 라이브러리 없이 useState/useCallback/useMemo 사용
- localStorage 사용 안 함 (인메모리 상태만)

## 문제 데이터 수정
`src/data/questions.ts` 파일에서 문제를 추가/수정할 수 있습니다.
각 카테고리별 10문제, 난이도 분포는 쉬움 3 / 보통 4 / 어려움 3 권장.

## 주의사항
- 문제의 `answer` 값은 0-3 인덱스 (A=0, B=1, C=2, D=3)
- 모든 문제에 `explanation` 필수
- 카테고리 추가 시 `types/index.ts`의 Category 타입도 수정 필요

## 퀴즈 문제 교차 검증 가이드라인

### 모든 문제 작성 시 확인 사항

#### 1. 정답이 하나뿐인가?
- 다른 해석 가능 시 조건 명시 (예: 면적 기준, 2024년 기준)

#### 2. 최상급 표현에 기준이 있는가?
- '가장 큰', '최초의' 등 표현에 측정 기준 명시

#### 3. 시간과 범위가 명확한가?
- 변할 수 있는 정보는 시점 명시
- 지리적, 분류적 범위 한정

#### 4. 교차 검증했는가?
- 의심스러운 정보는 2개 이상 출처 확인
- 논란 있는 내용은 주류 학설 기준
