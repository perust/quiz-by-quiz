import React, { useEffect, useState } from 'react';
import { Grade, CategoryScores, Category } from '../types';
import { getCategoryIcon, allCategories } from '../utils/helpers';

interface ResultScreenProps {
  nickname: string;
  totalScore: number;
  totalQuestions: number;
  grade: Grade;
  categoryScores: CategoryScores;
  onAddToLeaderboard: () => void;
  onRestart: () => void;
}

const gradeTable = [
  { label: 'S', range: '38-40', title: '상식왕', emoji: '👑' },
  { label: 'A', range: '32-37', title: '박학다식', emoji: '🌟' },
  { label: 'B', range: '24-31', title: '준수함', emoji: '📚' },
  { label: 'C', range: '16-23', title: '노력필요', emoji: '📖' },
  { label: 'D', range: '0-15', title: '기초부터', emoji: '📝' },
];

export default function ResultScreen({
  nickname,
  totalScore,
  totalQuestions,
  grade,
  categoryScores,
  onAddToLeaderboard,
  onRestart,
}: ResultScreenProps) {
  const [displayScore, setDisplayScore] = useState(0);
  const [showContent, setShowContent] = useState(false);

  // 점수 카운트업 애니메이션
  useEffect(() => {
    setShowContent(true);
    const duration = 1500;
    const steps = 30;
    const increment = totalScore / steps;
    let current = 0;
    const timer = setInterval(() => {
      current += increment;
      if (current >= totalScore) {
        setDisplayScore(totalScore);
        clearInterval(timer);
      } else {
        setDisplayScore(Math.floor(current));
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [totalScore]);

  const getCategoryColorClass = (category: Category): string => {
    const colors: Record<Category, string> = {
      "한국사": "bg-red-500",
      "과학": "bg-blue-500",
      "지리": "bg-green-500",
      "예술과문화": "bg-purple-500",
    };
    return colors[category];
  };

  return (
    <div className={`min-h-screen flex flex-col items-center p-4 sm:p-6 py-8 transition-opacity duration-500 ${showContent ? 'opacity-100' : 'opacity-0'}`}>
      {/* 타이틀 */}
      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-6 animate-bounce-in">
        🎊 퀴즈 완료!
      </h1>

      {/* 등급 배지 */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 sm:p-8 mb-6 text-center border border-slate-700/50 w-full max-w-md">
        <div className="text-6xl sm:text-7xl mb-3 animate-bounce-slow">
          {grade.emoji}
        </div>
        <div className="text-3xl sm:text-4xl font-bold text-white mb-1">
          {grade.label}등급
        </div>
        <div className="text-lg text-slate-400">
          {grade.title}
        </div>

        {/* 총점 */}
        <div className="mt-6 pt-6 border-t border-slate-700/50">
          <div className="text-5xl sm:text-6xl font-bold bg-gradient-to-r from-yellow-400 to-orange-500 bg-clip-text text-transparent">
            {displayScore}<span className="text-2xl text-slate-400">/{totalQuestions}</span>
          </div>
          <p className="text-slate-500 text-sm mt-2">
            {nickname}님의 점수
          </p>
        </div>
      </div>

      {/* 카테고리별 점수 분석 */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 mb-6 w-full max-w-md border border-slate-700/50">
        <h2 className="text-lg font-semibold text-white mb-4">카테고리별 점수</h2>
        <div className="space-y-4">
          {allCategories.map((category) => {
            const score = categoryScores[category];
            const percentage = (score / 10) * 100;

            return (
              <div key={category}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-slate-300 flex items-center gap-1">
                    <span>{getCategoryIcon(category)}</span>
                    <span>{category}</span>
                  </span>
                  <span className="text-sm font-medium text-white">
                    {score}/10
                  </span>
                </div>
                <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${getCategoryColorClass(category)} transition-all duration-1000 ease-out rounded-full`}
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 등급 테이블 */}
      <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-5 sm:p-6 mb-6 w-full max-w-md border border-slate-700/50">
        <h2 className="text-lg font-semibold text-white mb-4">등급표</h2>
        <div className="space-y-2">
          {gradeTable.map((g) => (
            <div
              key={g.label}
              className={`flex items-center justify-between p-2 rounded-lg transition-colors
                        ${g.label === grade.label
                          ? 'bg-yellow-500/20 border border-yellow-500/50'
                          : 'bg-slate-700/30'
                        }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{g.emoji}</span>
                <span className={`font-semibold ${g.label === grade.label ? 'text-yellow-400' : 'text-slate-300'}`}>
                  {g.label}등급
                </span>
                <span className="text-xs text-slate-500">
                  {g.title}
                </span>
              </div>
              <span className="text-sm text-slate-400">
                {g.range}점
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 버튼들 */}
      <div className="w-full max-w-md space-y-3">
        <button
          onClick={onAddToLeaderboard}
          className="w-full py-3 px-6 rounded-xl font-semibold text-white
                   bg-gradient-to-r from-yellow-500 to-orange-500
                   hover:from-yellow-400 hover:to-orange-400
                   hover:scale-[1.02] hover:shadow-lg hover:shadow-yellow-500/25
                   transition-all duration-200 transform active:scale-[0.98]"
          aria-label="순위표에 기록하기"
        >
          🏆 순위표에 기록하기
        </button>
        <button
          onClick={onRestart}
          className="w-full py-3 px-6 rounded-xl font-semibold text-white
                   bg-slate-700 hover:bg-slate-600
                   transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98]"
          aria-label="다시 도전하기"
        >
          🔄 다시 도전
        </button>
      </div>
    </div>
  );
}
