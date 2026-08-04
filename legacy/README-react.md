# Quiz Challenge

React와 TypeScript로 만든 퀴즈 게임 프로젝트입니다. 사용자는 닉네임을 입력하고 카테고리를 선택한 뒤 문제를 풀며 점수와 진행률을 확인할 수 있습니다.

실제 앱 코드는 `quiz-challenge/` 하위 디렉터리에 있습니다.

## 주요 기능

- 시작 화면과 닉네임 입력
- 카테고리 선택
- 퀴즈 진행 화면
- 정답/오답 피드백
- 전체 진행률 표시
- 결과 화면
- 리더보드
- 음소거 토글
- React Error Boundary

## 기술 스택

- React
- TypeScript
- Create React App
- Tailwind CSS

## 프로젝트 구조

```text
.
└── quiz-challenge/
    ├── src/
    │   ├── App.tsx
    │   ├── components/
    │   └── hooks/
    ├── public/
    ├── package.json
    ├── tailwind.config.js
    └── tsconfig.json
```

## 설치 및 실행

```bash
git clone https://github.com/perust/quiz-challenge.git
cd quiz-challenge/quiz-challenge
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

## 참고

하위 디렉터리의 기존 `README.md`에는 Create React App 기본 안내가 포함되어 있습니다. 이 문서는 저장소 루트에서 프로젝트 개요와 실행 위치를 빠르게 파악하기 위한 README입니다.
