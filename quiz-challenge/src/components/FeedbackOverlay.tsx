import React from 'react';

interface FeedbackOverlayProps {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
  onNext: () => void;
  isLastQuestion: boolean;
}

export default function FeedbackOverlay({
  isCorrect,
  correctAnswer,
  explanation,
  onNext,
  isLastQuestion,
}: FeedbackOverlayProps) {
  return (
    <div className="animate-fade-in mt-4 p-4 sm:p-5 rounded-xl border bg-slate-800/80 backdrop-blur-sm
                  border-slate-700">
      {/* 결과 메시지 */}
      <div className="flex items-center gap-2 mb-3">
        {isCorrect ? (
          <>
            <span className="text-2xl">🎉</span>
            <span className="text-lg font-semibold text-green-400">정답입니다!</span>
          </>
        ) : (
          <>
            <span className="text-2xl">😅</span>
            <span className="text-lg font-semibold text-red-400">오답입니다</span>
          </>
        )}
      </div>

      {/* 정답 표시 (오답일 경우) */}
      {!isCorrect && (
        <p className="text-sm text-slate-300 mb-2">
          정답: <span className="text-green-400 font-medium">{correctAnswer}</span>
        </p>
      )}

      {/* 해설 */}
      <p className="text-sm text-slate-400 leading-relaxed mb-4">
        💡 {explanation}
      </p>

      {/* 다음 버튼 */}
      <button
        onClick={onNext}
        className="w-full py-2.5 px-4 rounded-xl font-medium text-white
                 bg-gradient-to-r from-indigo-600 to-purple-600
                 hover:from-indigo-500 hover:to-purple-500
                 transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98]"
        aria-label={isLastQuestion ? '결과 보기' : '다음 문제'}
      >
        {isLastQuestion ? '결과 보기 →' : '다음 문제 →'}
      </button>
    </div>
  );
}
