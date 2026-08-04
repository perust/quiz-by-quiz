# Quiz Challenge App

React와 TypeScript로 만든 퀴즈 게임 앱입니다. 저장소 루트 README는 전체 프로젝트 개요를, 이 문서는 실제 CRA 앱 디렉터리에서 실행하는 방법을 정리합니다.

## 주요 기능

- 닉네임 입력 후 게임 시작
- 카테고리 선택
- 퀴즈 진행 및 정답/오답 피드백
- 전체 진행률 표시
- 카테고리별 점수와 최종 결과
- 리더보드
- 음소거 토글
- Error Boundary

## 기술 스택

- React 19
- TypeScript
- Create React App
- Tailwind CSS
- Testing Library

## 실행 방법

```bash
cd quiz-challenge
npm install
npm start
```

브라우저에서 `http://localhost:3000`에 접속합니다.

## 빌드

```bash
npm run build
```

## 테스트

```bash
npm test
```

## 주요 구조

```text
quiz-challenge/
├── src/
│   ├── App.tsx
│   ├── components/
│   ├── hooks/
│   └── index.tsx
├── public/
├── package.json
├── tailwind.config.js
└── tsconfig.json
```

## 개발 메모

- 게임 상태 관리는 `src/hooks/useQuizGame`에서 담당합니다.
- 화면 컴포넌트는 시작, 카테고리 선택, 퀴즈, 결과, 리더보드로 나뉩니다.
- 스타일은 Tailwind CSS 유틸리티 클래스를 중심으로 구성되어 있습니다.
