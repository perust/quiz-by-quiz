import { useState, useCallback, useMemo } from 'react';
import {
  Category,
  Screen,
  Question,
  LeaderboardEntry,
  CategoryScores,
  FeedbackState,
  Grade,
} from '../types';
import { questions, getQuestionsByCategory } from '../data/questions';
import { shuffleArray, getGrade, formatDate, allCategories } from '../utils/helpers';

interface UseQuizGameReturn {
  // 상태
  screen: Screen;
  nickname: string;
  selectedCategory: Category | null;
  currentQuestionIndex: number;
  currentQuestions: Question[];
  answers: Map<number, number>;
  categoryScores: CategoryScores;
  completedCategories: Set<Category>;
  feedback: FeedbackState;
  leaderboard: LeaderboardEntry[];

  // 계산된 값
  currentQuestion: Question | null;
  totalScore: number;
  totalQuestions: number;
  progress: number;
  grade: Grade;

  // 함수
  setNickname: (name: string) => void;
  startGame: () => void;
  selectCategory: (category: Category) => void;
  submitAnswer: (answerIndex: number) => void;
  nextQuestion: () => void;
  finishCategory: () => void;
  showResult: () => void;
  showLeaderboard: () => void;
  resetGame: () => void;
  addToLeaderboard: () => void;
  goToCategory: () => void;
}

export function useQuizGame(): UseQuizGameReturn {
  // 화면 상태
  const [screen, setScreen] = useState<Screen>('start');

  // 유저 정보
  const [nickname, setNickname] = useState<string>('');

  // 카테고리 관련
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
  const [completedCategories, setCompletedCategories] = useState<Set<Category>>(new Set());

  // 문제 관련
  const [currentQuestions, setCurrentQuestions] = useState<Question[]>([]);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState<number>(0);
  const [answers, setAnswers] = useState<Map<number, number>>(new Map());

  // 점수 관련
  const [categoryScores, setCategoryScores] = useState<CategoryScores>({
    "한국사": 0,
    "과학": 0,
    "지리": 0,
    "예술과문화": 0,
  });

  // 피드백 상태
  const [feedback, setFeedback] = useState<FeedbackState>({
    isVisible: false,
    isCorrect: false,
    correctAnswer: 0,
    explanation: '',
  });

  // 리더보드
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  // 현재 문제
  const currentQuestion = useMemo(() => {
    if (currentQuestions.length === 0) return null;
    return currentQuestions[currentQuestionIndex] || null;
  }, [currentQuestions, currentQuestionIndex]);

  // 총점 계산
  const totalScore = useMemo(() => {
    return Object.values(categoryScores).reduce((sum, score) => sum + score, 0);
  }, [categoryScores]);

  // 총 문제 수
  const totalQuestions = questions.length;

  // 전체 진행률 (완료된 카테고리 기준)
  const progress = useMemo(() => {
    const completedCount = completedCategories.size;
    const currentCategoryProgress = selectedCategory && !completedCategories.has(selectedCategory)
      ? (currentQuestionIndex + (feedback.isVisible ? 1 : 0)) / 10
      : 0;
    return ((completedCount + currentCategoryProgress) / allCategories.length) * 100;
  }, [completedCategories, selectedCategory, currentQuestionIndex, feedback.isVisible]);

  // 등급 계산
  const grade = useMemo(() => getGrade(totalScore), [totalScore]);

  // 게임 시작 (닉네임 입력 후)
  const startGame = useCallback(() => {
    if (nickname.trim()) {
      setScreen('category');
    }
  }, [nickname]);

  // 카테고리 선택
  const selectCategory = useCallback((category: Category) => {
    const categoryQuestions = getQuestionsByCategory(category);
    const shuffledQuestions = shuffleArray(categoryQuestions);

    setSelectedCategory(category);
    setCurrentQuestions(shuffledQuestions);
    setCurrentQuestionIndex(0);
    setAnswers(new Map());
    setFeedback({
      isVisible: false,
      isCorrect: false,
      correctAnswer: 0,
      explanation: '',
    });
    setScreen('quiz');
  }, []);

  // 답변 제출
  const submitAnswer = useCallback((answerIndex: number) => {
    if (!currentQuestion || feedback.isVisible) return;

    const isCorrect = answerIndex === currentQuestion.answer;

    // 답변 기록
    setAnswers(prev => new Map(prev).set(currentQuestion.id, answerIndex));

    // 정답이면 점수 추가
    if (isCorrect && selectedCategory) {
      setCategoryScores(prev => ({
        ...prev,
        [selectedCategory]: prev[selectedCategory] + 1,
      }));
    }

    // 피드백 표시
    setFeedback({
      isVisible: true,
      isCorrect,
      correctAnswer: currentQuestion.answer,
      explanation: currentQuestion.explanation,
    });
  }, [currentQuestion, selectedCategory, feedback.isVisible]);

  // 카테고리 완료
  const finishCategory = useCallback(() => {
    if (selectedCategory) {
      setCompletedCategories(prev => new Set(prev).add(selectedCategory));
    }

    // 모든 카테고리 완료 확인
    const newCompletedCount = completedCategories.size + 1;
    if (newCompletedCount >= allCategories.length) {
      setScreen('result');
    } else {
      setScreen('category');
    }
  }, [selectedCategory, completedCategories]);

  // 다음 문제로
  const nextQuestion = useCallback(() => {
    setFeedback({
      isVisible: false,
      isCorrect: false,
      correctAnswer: 0,
      explanation: '',
    });

    if (currentQuestionIndex < currentQuestions.length - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
    } else {
      // 카테고리 완료
      finishCategory();
    }
  }, [currentQuestionIndex, currentQuestions.length, finishCategory]);

  // 결과 화면으로
  const showResult = useCallback(() => {
    setScreen('result');
  }, []);

  // 리더보드 화면으로
  const showLeaderboard = useCallback(() => {
    setScreen('leaderboard');
  }, []);

  // 카테고리 선택 화면으로
  const goToCategory = useCallback(() => {
    setScreen('category');
  }, []);

  // 게임 리셋
  const resetGame = useCallback(() => {
    setScreen('start');
    setNickname('');
    setSelectedCategory(null);
    setCompletedCategories(new Set());
    setCurrentQuestions([]);
    setCurrentQuestionIndex(0);
    setAnswers(new Map());
    setCategoryScores({
      "한국사": 0,
      "과학": 0,
      "지리": 0,
      "예술과문화": 0,
    });
    setFeedback({
      isVisible: false,
      isCorrect: false,
      correctAnswer: 0,
      explanation: '',
    });
  }, []);

  // 리더보드에 추가
  const addToLeaderboard = useCallback(() => {
    const entry: LeaderboardEntry = {
      nickname,
      score: totalScore,
      grade: getGrade(totalScore),
      date: formatDate(new Date()),
    };

    setLeaderboard(prev => {
      const newLeaderboard = [...prev, entry];
      // 점수 내림차순 정렬
      newLeaderboard.sort((a, b) => b.score - a.score);
      // 상위 10명만 유지
      return newLeaderboard.slice(0, 10);
    });

    setScreen('leaderboard');
  }, [nickname, totalScore]);

  return {
    // 상태
    screen,
    nickname,
    selectedCategory,
    currentQuestionIndex,
    currentQuestions,
    answers,
    categoryScores,
    completedCategories,
    feedback,
    leaderboard,

    // 계산된 값
    currentQuestion,
    totalScore,
    totalQuestions,
    progress,
    grade,

    // 함수
    setNickname,
    startGame,
    selectCategory,
    submitAnswer,
    nextQuestion,
    finishCategory,
    showResult,
    showLeaderboard,
    resetGame,
    addToLeaderboard,
    goToCategory,
  };
}
