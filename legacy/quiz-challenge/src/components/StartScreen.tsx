import React, { useState } from 'react';

interface StartScreenProps {
  nickname: string;
  setNickname: (name: string) => void;
  onStart: () => void;
  onShowLeaderboard: () => void;
}

export default function StartScreen({
  nickname,
  setNickname,
  onStart,
  onShowLeaderboard,
}: StartScreenProps) {
  const [inputValue, setInputValue] = useState(nickname);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.slice(0, 10);
    setInputValue(value);
    setNickname(value);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      onStart();
    }
  };

  const isValidNickname = inputValue.trim().length > 0;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 sm:p-6">
      {/* 메인 카드 */}
      <div className="w-full max-w-md bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 sm:p-8 shadow-xl border border-slate-700/50">
        {/* 타이틀 */}
        <div className="text-center mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold mb-3 bg-gradient-to-r from-yellow-400 via-pink-500 to-purple-500 bg-clip-text text-transparent">
            🧠 상식왕 퀴즈 챌린지
          </h1>
          <p className="text-slate-400 text-sm sm:text-base">
            당신의 상식을 테스트해 보세요!
          </p>
        </div>

        {/* 닉네임 입력 */}
        <div className="mb-6">
          <label htmlFor="nickname" className="block text-sm font-medium text-slate-300 mb-2">
            닉네임
          </label>
          <input
            type="text"
            id="nickname"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyPress}
            placeholder="닉네임을 입력하세요"
            maxLength={10}
            className="w-full px-4 py-3 bg-slate-900/50 border border-slate-600 rounded-xl
                     text-white placeholder-slate-500
                     focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent
                     transition-all duration-200"
            aria-label="닉네임 입력"
          />
          <p className="mt-1 text-xs text-slate-500 text-right">
            {inputValue.length}/10
          </p>
        </div>

        {/* 게임 시작 버튼 */}
        <button
          onClick={onStart}
          disabled={!isValidNickname}
          className={`w-full py-3 px-6 rounded-xl font-semibold text-white text-lg
                    transition-all duration-200 transform
                    ${isValidNickname
                      ? 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 hover:scale-[1.02] hover:shadow-lg hover:shadow-purple-500/25 active:scale-[0.98]'
                      : 'bg-slate-600 cursor-not-allowed opacity-50'
                    }`}
          aria-label="게임 시작"
        >
          게임 시작
        </button>

        {/* 순위표 보기 */}
        <button
          onClick={onShowLeaderboard}
          className="w-full mt-4 py-2 text-slate-400 hover:text-yellow-400
                   transition-colors duration-200 flex items-center justify-center gap-2"
          aria-label="순위표 보기"
        >
          <span>🏆</span>
          <span>순위표 보기</span>
        </button>
      </div>

      {/* 게임 설명 */}
      <div className="mt-6 text-center max-w-md">
        <div className="flex flex-wrap justify-center gap-2 text-xs sm:text-sm text-slate-500">
          <span className="px-3 py-1 bg-slate-800/50 rounded-full">📚 4개 카테고리</span>
          <span className="px-3 py-1 bg-slate-800/50 rounded-full">❓ 총 40문제</span>
          <span className="px-3 py-1 bg-slate-800/50 rounded-full">✏️ 4지선다</span>
        </div>
        <p className="mt-3 text-xs text-slate-600">
          한국사, 과학, 지리, 예술과문화 분야의 상식을 테스트합니다
        </p>
      </div>
    </div>
  );
}
