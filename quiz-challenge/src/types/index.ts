// 카테고리 타입
export type Category = "한국사" | "과학" | "지리" | "예술과문화";

// 난이도 타입
export type Difficulty = "쉬움" | "보통" | "어려움";

// 문제 타입
export interface Question {
  id: number;
  category: Category;
  difficulty: Difficulty;
  question: string;
  options: [string, string, string, string];
  answer: 0 | 1 | 2 | 3;
  explanation: string;
}

// 퀴즈 상태 타입
export interface QuizState {
  currentCategory: Category | null;
  currentQuestionIndex: number;
  answers: Map<number, number>;
  score: number;
  isFinished: boolean;
}

// 등급 타입
export interface Grade {
  label: string;
  emoji: string;
  title: string;
  minScore: number;
}

// 리더보드 엔트리 타입
export interface LeaderboardEntry {
  nickname: string;
  score: number;
  grade: Grade;
  date: string;
}

// 화면 상태 타입
export type Screen = "start" | "category" | "quiz" | "result" | "leaderboard";

// 카테고리별 점수 타입
export type CategoryScores = Record<Category, number>;

// 피드백 상태 타입
export interface FeedbackState {
  isVisible: boolean;
  isCorrect: boolean;
  correctAnswer: number;
  explanation: string;
}
