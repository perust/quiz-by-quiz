import React, { useState } from 'react';
import { Question, Category, FeedbackState } from '../types';
import { getCategoryIcon } from '../utils/helpers';
import ProgressBar from './ProgressBar';
import FeedbackOverlay from './FeedbackOverlay';

interface QuizScreenProps {
  category: Category;
  question: Question;
  questionIndex: number;
  totalQuestions: number;
  selectedAnswer: number | undefined;
  feedback: FeedbackState;
  onSubmitAnswer: (index: number) => void;
  onNextQuestion: () => void;
  onGoBack: () => void;
}

export default function QuizScreen({
  category,
  question,
  questionIndex,
  totalQuestions,
  selectedAnswer,
  feedback,
  onSubmitAnswer,
  onNextQuestion,
  onGoBack,
}: QuizScreenProps) {
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const optionLabels = ['A', 'B', 'C', 'D'];
  const progress = ((questionIndex + 1) / totalQuestions) * 100;
  const isLastQuestion = questionIndex === totalQuestions - 1;

  const getCategoryAccentClass = (category: Category): string => {
    const accents: Record<Category, string> = {
      "한국사": "from-red-500 to-red-600",
      "과학": "from-blue-500 to-blue-600",
      "지리": "from-green-500 to-green-600",
      "예술과문화": "from-purple-500 to-purple-600",
    };
    return accents[category];
  };

  const getCategoryProgressColor = (category: Category): string => {
    const colors: Record<Category, string> = {
      "한국사": "bg-red-500",
      "과학": "bg-blue-500",
      "지리": "bg-green-500",
      "예술과문화": "bg-purple-500",
    };
    return colors[category];
  };

  const getOptionClass = (index: number): string => {
    if (!feedback.isVisible) {
      return 'bg-slate-800/50 border-slate-600/50 hover:border-slate-500 hover:bg-slate-700/50 cursor-pointer';
    }

    const isSelected = selectedAnswer === index;
    const isCorrect = index === feedback.correctAnswer;

    if (isSelected && feedback.isCorrect) {
      return 'bg-green-500/20 border-green-500 ring-2 ring-green-500/50';
    }
    if (isSelected && !feedback.isCorrect) {
      return 'bg-red-500/20 border-red-500 ring-2 ring-red-500/50';
    }
    if (isCorrect && !feedback.isCorrect) {
      return 'bg-green-500/10 border-green-500/50';
    }
    return 'bg-slate-800/30 border-slate-700/30 opacity-50';
  };

  const handleOptionClick = (index: number) => {
    if (!feedback.isVisible) {
      onSubmitAnswer(index);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOptionClick(index);
    }
  };

  return (
    <div className="min-h-screen flex flex-col p-4 sm:p-6">
      {/* 상단 바 */}
      <div className="mb-4 sm:mb-6">
        {/* 카테고리 및 문제 번호 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`px-3 py-1 rounded-full text-sm font-medium text-white bg-gradient-to-r ${getCategoryAccentClass(category)}`}>
              {getCategoryIcon(category)} {category}
            </span>
          </div>
          <div className="text-slate-400 text-sm font-medium">
            <span className="text-white">{questionIndex + 1}</span>
            <span> / {totalQuestions}</span>
          </div>
        </div>

        {/* 진행률 바 */}
        <ProgressBar
          progress={progress}
          color={getCategoryProgressColor(category)}
        />
      </div>

      {/* 문제 영역 */}
      <div className="flex-1 flex flex-col">
        {/* 난이도 표시 */}
        <div className="mb-3">
          <span className={`text-xs px-2 py-0.5 rounded-full
                         ${question.difficulty === '쉬움' ? 'bg-green-500/20 text-green-400' :
                           question.difficulty === '보통' ? 'bg-yellow-500/20 text-yellow-400' :
                           'bg-red-500/20 text-red-400'}`}>
            {question.difficulty}
          </span>
        </div>

        {/* 질문 카드 */}
        <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 mb-4 sm:mb-6 border border-slate-700/50">
          <h2 className="text-lg sm:text-xl font-medium text-white leading-relaxed">
            {question.question}
          </h2>
        </div>

        {/* 선택지 */}
        <div className="space-y-3 mb-4">
          {question.options.map((option, index) => (
            <button
              key={index}
              onClick={() => handleOptionClick(index)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              disabled={feedback.isVisible}
              className={`w-full p-4 rounded-xl border-2 transition-all duration-200
                        flex items-center gap-3 text-left
                        ${getOptionClass(index)}
                        ${!feedback.isVisible && 'active:scale-[0.98]'}`}
              role="radio"
              aria-checked={selectedAnswer === index}
              aria-label={`선택지 ${optionLabels[index]}: ${option}`}
            >
              {/* 라벨 */}
              <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-semibold
                             ${feedback.isVisible && selectedAnswer === index
                               ? feedback.isCorrect
                                 ? 'bg-green-500 text-white'
                                 : 'bg-red-500 text-white'
                               : feedback.isVisible && index === feedback.correctAnswer
                                 ? 'bg-green-500/50 text-green-200'
                                 : 'bg-slate-700 text-slate-300'
                             }`}>
                {feedback.isVisible && selectedAnswer === index ? (
                  feedback.isCorrect ? '✓' : '✗'
                ) : (
                  optionLabels[index]
                )}
              </span>

              {/* 텍스트 */}
              <span className="flex-1 text-white text-sm sm:text-base">
                {option}
              </span>
            </button>
          ))}
        </div>

        {/* 피드백 표시 */}
        {feedback.isVisible && (
          <FeedbackOverlay
            isCorrect={feedback.isCorrect}
            correctAnswer={question.options[feedback.correctAnswer]}
            explanation={feedback.explanation}
            onNext={onNextQuestion}
            isLastQuestion={isLastQuestion}
          />
        )}
      </div>

      {/* 하단 네비게이션 */}
      <div className="mt-4 pt-4 border-t border-slate-700/50">
        <button
          onClick={() => setShowConfirmModal(true)}
          className="text-slate-400 hover:text-slate-300 text-sm transition-colors"
          aria-label="카테고리로 돌아가기"
        >
          ← 카테고리로 돌아가기
        </button>
      </div>

      {/* 확인 모달 */}
      {showConfirmModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-fade-in">
          <div className="bg-slate-800 rounded-2xl p-6 max-w-sm w-full border border-slate-700 shadow-2xl">
            <h3 className="text-lg font-semibold text-white mb-2">
              정말 나가시겠습니까?
            </h3>
            <p className="text-slate-400 text-sm mb-6">
              현재 카테고리의 진행 상황이 저장되지 않습니다.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 py-2.5 px-4 rounded-xl font-medium
                         bg-slate-700 text-white hover:bg-slate-600
                         transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  onGoBack();
                }}
                className="flex-1 py-2.5 px-4 rounded-xl font-medium
                         bg-red-500 text-white hover:bg-red-400
                         transition-colors"
              >
                나가기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
