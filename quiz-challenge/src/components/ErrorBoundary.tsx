import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error caught by boundary:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
          <div className="bg-slate-800 rounded-2xl p-8 max-w-md w-full text-center border border-slate-700">
            <div className="text-5xl mb-4">😵</div>
            <h1 className="text-2xl font-bold text-white mb-2">
              앗, 문제가 발생했습니다!
            </h1>
            <p className="text-slate-400 mb-6">
              예상치 못한 오류가 발생했습니다. 페이지를 새로고침해 주세요.
            </p>
            <button
              onClick={this.handleReset}
              className="w-full py-3 px-6 rounded-xl font-semibold text-white
                       bg-gradient-to-r from-purple-600 to-pink-600
                       hover:from-purple-500 hover:to-pink-500
                       transition-all duration-200"
            >
              🔄 새로고침
            </button>
            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="mt-4 text-left">
                <summary className="text-slate-500 cursor-pointer text-sm">
                  오류 상세 정보
                </summary>
                <pre className="mt-2 p-3 bg-slate-900 rounded-lg text-xs text-red-400 overflow-auto">
                  {this.state.error.toString()}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
