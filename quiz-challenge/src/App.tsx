import React from 'react';
import { useQuizGame } from './hooks/useQuizGame';
import ErrorBoundary from './components/ErrorBoundary';
import StartScreen from './components/StartScreen';
import CategorySelect from './components/CategorySelect';
import QuizScreen from './components/QuizScreen';
import ResultScreen from './components/ResultScreen';
import Leaderboard from './components/Leaderboard';
import ProgressBar from './components/ProgressBar';

function QuizApp() {
  const {
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
    currentQuestion,
    totalScore,
    totalQuestions,
    progress,
    grade,
    setNickname,
    startGame,
    selectCategory,
    submitAnswer,
    nextQuestion,
    showResult,
    showLeaderboard,
    resetGame,
    addToLeaderboard,
    goToCategory,
  } = useQuizGame();

  return (
    <div className="min-h-screen bg-slate-900">
      {/* 전체 진행률 바 (시작/리더보드 화면 제외) */}
      {screen !== 'start' && screen !== 'leaderboard' && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-slate-900/80 backdrop-blur-sm p-2">
          <div className="max-w-2xl mx-auto">
            <ProgressBar
              progress={progress}
              label={`전체 진행률`}
              showPercentage
            />
          </div>
        </div>
      )}

      {/* 화면 컨테이너 */}
      <div className={`transition-opacity duration-300 ${screen !== 'start' && screen !== 'leaderboard' ? 'pt-16' : ''}`}>
        {/* 시작 화면 */}
        {screen === 'start' && (
          <div className="animate-fade-in">
            <StartScreen
              nickname={nickname}
              setNickname={setNickname}
              onStart={startGame}
              onShowLeaderboard={showLeaderboard}
            />
          </div>
        )}

        {/* 카테고리 선택 */}
        {screen === 'category' && (
          <div className="animate-fade-in">
            <CategorySelect
              nickname={nickname}
              completedCategories={completedCategories}
              categoryScores={categoryScores}
              onSelectCategory={selectCategory}
              onShowResult={showResult}
            />
          </div>
        )}

        {/* 퀴즈 화면 */}
        {screen === 'quiz' && selectedCategory && currentQuestion && (
          <div className="animate-fade-in">
            <QuizScreen
              category={selectedCategory}
              question={currentQuestion}
              questionIndex={currentQuestionIndex}
              totalQuestions={currentQuestions.length}
              selectedAnswer={answers.get(currentQuestion.id)}
              feedback={feedback}
              onSubmitAnswer={submitAnswer}
              onNextQuestion={nextQuestion}
              onGoBack={goToCategory}
            />
          </div>
        )}

        {/* 결과 화면 */}
        {screen === 'result' && (
          <div className="animate-fade-in">
            <ResultScreen
              nickname={nickname}
              totalScore={totalScore}
              totalQuestions={totalQuestions}
              grade={grade}
              categoryScores={categoryScores}
              onAddToLeaderboard={addToLeaderboard}
              onRestart={resetGame}
            />
          </div>
        )}

        {/* 리더보드 */}
        {screen === 'leaderboard' && (
          <div className="animate-fade-in">
            <Leaderboard
              entries={leaderboard}
              currentNickname={nickname}
              onRestart={resetGame}
              onGoHome={resetGame}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QuizApp />
    </ErrorBoundary>
  );
}

export default App;
