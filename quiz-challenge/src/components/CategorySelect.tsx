import React from 'react';
import { Category } from '../types';
import { getCategoryIcon, allCategories } from '../utils/helpers';

interface CategorySelectProps {
  nickname: string;
  completedCategories: Set<Category>;
  categoryScores: Record<Category, number>;
  onSelectCategory: (category: Category) => void;
  onShowResult: () => void;
}

export default function CategorySelect({
  nickname,
  completedCategories,
  categoryScores,
  onSelectCategory,
  onShowResult,
}: CategorySelectProps) {
  const allCompleted = completedCategories.size === allCategories.length;
  const completedCount = completedCategories.size;

  const getCategoryBorderClass = (category: Category): string => {
    const borders: Record<Category, string> = {
      "한국사": "border-red-500/50 hover:border-red-400",
      "과학": "border-blue-500/50 hover:border-blue-400",
      "지리": "border-green-500/50 hover:border-green-400",
      "예술과문화": "border-purple-500/50 hover:border-purple-400",
    };
    return borders[category];
  };

  const getCategoryGlowClass = (category: Category): string => {
    const glows: Record<Category, string> = {
      "한국사": "hover:shadow-red-500/20",
      "과학": "hover:shadow-blue-500/20",
      "지리": "hover:shadow-green-500/20",
      "예술과문화": "hover:shadow-purple-500/20",
    };
    return glows[category];
  };

  const getCategoryBgClass = (category: Category): string => {
    const bgs: Record<Category, string> = {
      "한국사": "bg-red-500",
      "과학": "bg-blue-500",
      "지리": "bg-green-500",
      "예술과문화": "bg-purple-500",
    };
    return bgs[category];
  };

  return (
    <div className="min-h-screen flex flex-col p-4 sm:p-6 pt-8">
      {/* 상단 헤더 */}
      <div className="text-center mb-6 sm:mb-8">
        <p className="text-slate-400 text-sm mb-1">
          안녕하세요, <span className="text-white font-medium">{nickname}</span>님!
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold text-white">
          카테고리 선택
        </h1>
      </div>

      {/* 카테고리 그리드 */}
      <div className="flex-1 flex items-center justify-center">
        <div className="grid grid-cols-2 gap-3 sm:gap-4 w-full max-w-lg">
          {allCategories.map((category, index) => {
            const isCompleted = completedCategories.has(category);
            const score = categoryScores[category];

            return (
              <button
                key={category}
                onClick={() => !isCompleted && onSelectCategory(category)}
                disabled={isCompleted}
                className={`animate-stagger-fade-in relative p-4 sm:p-6 rounded-2xl border-2 transition-all duration-300 transform
                          ${isCompleted
                            ? 'bg-slate-800/30 border-slate-600/30 cursor-default opacity-70'
                            : `bg-slate-800/50 ${getCategoryBorderClass(category)} ${getCategoryGlowClass(category)}
                               hover:scale-105 hover:shadow-xl cursor-pointer active:scale-100`
                          }`}
                style={{ '--stagger-delay': `${index * 100}ms` } as React.CSSProperties}
                aria-label={`${category} 카테고리 ${isCompleted ? '완료됨' : '선택'}`}
              >
                {/* 완료 체크마크 */}
                {isCompleted && (
                  <div className="absolute top-2 right-2 w-6 h-6 bg-green-500 rounded-full flex items-center justify-center animate-stamp">
                    <span className="text-white text-sm">✓</span>
                  </div>
                )}

                {/* 카테고리 아이콘 */}
                <div className="text-3xl sm:text-4xl mb-2">
                  {getCategoryIcon(category)}
                </div>

                {/* 카테고리 이름 */}
                <h3 className="text-base sm:text-lg font-semibold text-white mb-1">
                  {category}
                </h3>

                {/* 문제 수 또는 점수 */}
                {isCompleted ? (
                  <p className="text-sm text-green-400 font-medium">
                    {score}/10 점
                  </p>
                ) : (
                  <p className="text-xs sm:text-sm text-slate-400">
                    10문제
                  </p>
                )}

                {/* 카테고리 컬러 인디케이터 */}
                <div className={`absolute bottom-0 left-0 right-0 h-1 ${getCategoryBgClass(category)} rounded-b-2xl opacity-50`} />
              </button>
            );
          })}
        </div>
      </div>

      {/* 하단 진행 상황 */}
      <div className="mt-6 sm:mt-8 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800/50 rounded-full mb-4">
          <div className="flex gap-1">
            {allCategories.map((category) => (
              <div
                key={category}
                className={`w-2 h-2 rounded-full transition-colors duration-300
                          ${completedCategories.has(category) ? getCategoryBgClass(category) : 'bg-slate-600'}`}
              />
            ))}
          </div>
          <span className="text-sm text-slate-400">
            {completedCount}/{allCategories.length} 카테고리 완료
          </span>
        </div>

        {/* 결과 보기 버튼 */}
        {allCompleted && (
          <div className="animate-fade-in">
            <button
              onClick={onShowResult}
              className="w-full max-w-xs py-3 px-6 rounded-xl font-semibold text-white text-lg
                       bg-gradient-to-r from-yellow-500 to-orange-500
                       hover:from-yellow-400 hover:to-orange-400
                       hover:scale-105 hover:shadow-lg hover:shadow-yellow-500/25
                       transition-all duration-200 transform active:scale-100"
              aria-label="결과 보기"
            >
              🎉 결과 보기
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
