import React from 'react';
import { LeaderboardEntry } from '../types';

interface LeaderboardProps {
  entries: LeaderboardEntry[];
  currentNickname: string;
  onRestart: () => void;
  onGoHome: () => void;
}

export default function Leaderboard({
  entries,
  currentNickname,
  onRestart,
  onGoHome,
}: LeaderboardProps) {
  const getRankIcon = (rank: number): string => {
    switch (rank) {
      case 1:
        return '🥇';
      case 2:
        return '🥈';
      case 3:
        return '🥉';
      default:
        return '';
    }
  };

  const getRankClass = (rank: number): string => {
    switch (rank) {
      case 1:
        return 'bg-yellow-500/20 border-yellow-500/50';
      case 2:
        return 'bg-slate-400/20 border-slate-400/50';
      case 3:
        return 'bg-orange-600/20 border-orange-600/50';
      default:
        return 'bg-slate-800/50 border-slate-700/50';
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 sm:p-6 py-8">
      {/* 타이틀 */}
      <h1 className="text-2xl sm:text-3xl font-bold text-white mb-6 flex items-center gap-2">
        <span>🏆</span>
        <span>순위표</span>
      </h1>

      {/* 리더보드 테이블 */}
      <div className="w-full max-w-lg mb-6">
        {entries.length === 0 ? (
          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-8 text-center border border-slate-700/50">
            <div className="text-4xl mb-4">🎮</div>
            <p className="text-slate-400 mb-2">아직 기록이 없습니다.</p>
            <p className="text-slate-500 text-sm">첫 번째 도전자가 되어 보세요!</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* 헤더 */}
            <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs text-slate-500 uppercase tracking-wider">
              <div className="col-span-1">#</div>
              <div className="col-span-4">닉네임</div>
              <div className="col-span-2 text-center">점수</div>
              <div className="col-span-2 text-center">등급</div>
              <div className="col-span-3 text-right">날짜</div>
            </div>

            {/* 엔트리 */}
            {entries.map((entry, index) => {
              const rank = index + 1;
              const isCurrentUser = entry.nickname === currentNickname;

              return (
                <div
                  key={`${entry.nickname}-${entry.date}-${index}`}
                  className={`grid grid-cols-12 gap-2 px-4 py-3 rounded-xl border transition-all
                            ${getRankClass(rank)}
                            ${isCurrentUser ? 'ring-2 ring-purple-500/50' : ''}`}
                >
                  {/* 순위 */}
                  <div className="col-span-1 flex items-center">
                    {rank <= 3 ? (
                      <span className="text-lg">{getRankIcon(rank)}</span>
                    ) : (
                      <span className="text-slate-400 font-medium">{rank}</span>
                    )}
                  </div>

                  {/* 닉네임 */}
                  <div className="col-span-4 flex items-center">
                    <span className={`font-medium truncate ${isCurrentUser ? 'text-purple-400' : 'text-white'}`}>
                      {entry.nickname}
                      {isCurrentUser && <span className="ml-1 text-xs">(나)</span>}
                    </span>
                  </div>

                  {/* 점수 */}
                  <div className="col-span-2 flex items-center justify-center">
                    <span className="font-bold text-white">{entry.score}</span>
                    <span className="text-slate-500 text-xs">/40</span>
                  </div>

                  {/* 등급 */}
                  <div className="col-span-2 flex items-center justify-center gap-1">
                    <span>{entry.grade.emoji}</span>
                    <span className="text-slate-300 text-sm font-medium">{entry.grade.label}</span>
                  </div>

                  {/* 날짜 */}
                  <div className="col-span-3 flex items-center justify-end">
                    <span className="text-slate-500 text-xs">{entry.date}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 버튼들 */}
      <div className="w-full max-w-lg space-y-3">
        <button
          onClick={onRestart}
          className="w-full py-3 px-6 rounded-xl font-semibold text-white
                   bg-gradient-to-r from-purple-600 to-pink-600
                   hover:from-purple-500 hover:to-pink-500
                   hover:scale-[1.02] hover:shadow-lg hover:shadow-purple-500/25
                   transition-all duration-200 transform active:scale-[0.98]"
          aria-label="다시 도전하기"
        >
          🔄 다시 도전
        </button>
        <button
          onClick={onGoHome}
          className="w-full py-3 px-6 rounded-xl font-semibold text-white
                   bg-slate-700 hover:bg-slate-600
                   transition-all duration-200 transform hover:scale-[1.02] active:scale-[0.98]"
          aria-label="홈으로"
        >
          🏠 홈으로
        </button>
      </div>
    </div>
  );
}
