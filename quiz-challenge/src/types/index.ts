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

// 학생 퀴즈 결과 타입
export interface StudentResult {
  date: string;                    // "2026.02.08 14:30"
  totalScore: number;              // 0-40
  categoryScores: CategoryScores;  // { 한국사: N, 과학: N, 지리: N, 예술과문화: N }
  grade: Grade;                    // 등급 정보
}

// 학생 프로필 타입
export interface StudentProfile {
  id: string;                      // 학생 식별자 (예: "홍길동")
  name: string;                    // 표시 이름
  registeredAt: string;            // 최초 등록일
  results: StudentResult[];        // 퀴즈 결과 (복수 응시 지원)
}
