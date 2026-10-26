// 결과 패널이 «무엇을 말하고 어디까지 보일지»를 정하는 순수 함수.
//
// DOM을 만지지 않는다 — 글과 숫자만 받아 글과 숫자를 돌려준다. 그래서 브라우저 없이
// 실제 문제 은행 전부를 돌려 «틀리면 정답이 글로 나온다»를 확인할 수 있다
// (tests/feedback-sheet.test.mjs). 그리는 일은 quiz.ts가 한다.

/**
 * 보기 하나를 «2번 · 1446년»처럼 쓴다.
 *
 * 번호는 **화면에 보이는(섞인 뒤의) 자리**다 — 보기 버튼과 무대 칸에 적힌 번호와 같아야
 * 위를 다시 보지 않고도 어느 것인지 안다. ②처럼 원문자를 쓰지 않는 것은 번들 픽셀 글꼴에
 * 없는 글리프라서다 (docs/design-system.md §4).
 */
export function choiceLine(choices: readonly string[], index: number): string {
  return `${index + 1}번 · ${choices[index]}`;
}

/** «정답»·«내 답» 두 줄의 글 (FR-4.2) */
export interface AnswerLines {
  correct: string;
  mine: string;
}

/**
 * 틀렸거나 시간이 끝났을 때 판정 바로 뒤에 둘 두 줄.
 *
 * 해설은 대부분 정답 보기를 글로 다시 말하지 않는다. 그래서 오답·시간 초과에는 무엇이
 * 정답이고 나는 무엇을 골랐는지를 라이브 리전 안에서 직접 말한다 — 스크린리더는 보기
 * 목록으로 돌아가 «정답» 표식을 찾지 않아도 되고, 눈으로 보는 사람도 위로 스크롤하지 않는다.
 *
 * @param chosenIndex 고른 보기. `null`이면 시간 초과이고 아무것도 고르지 않은 것이다 (FR-3.10)
 */
export function answerLines(
  question: { choices: readonly string[]; answerIndex: number },
  chosenIndex: number | null,
): AnswerLines {
  return {
    correct: choiceLine(question.choices, question.answerIndex),
    mine: chosenIndex === null ? '고르지 않음' : choiceLine(question.choices, chosenIndex),
  };
}

/** 패널을 드러낼 때 재 둔 값. 모두 화면(viewport) 기준이고 `scrollY`만 문서 기준이다 */
export interface FeedbackScrollInput {
  /** 지금 문서 스크롤 위치 */
  scrollY: number;
  /** 화면 높이 */
  viewportHeight: number;
  /** 결과 패널 아래 끝. 「다음 문제」가 여기 있다 */
  panelBottom: number;
  /** 질문 머리 */
  questionTop: number;
}

/**
 * 결과 패널을 드러낼 문서 스크롤 위치. 그대로 두면 되면 지금 값을 돌려준다.
 * 질문과 패널 끝을 한 화면에 함께 담을 수 없으면 `null` — 그때만 패널 끝에 맞춘다.
 *
 * 패널 끝(「다음 문제」)은 반드시 보여야 한다. 포커스가 거기 간다. 그런데 늘 끝에 맞추면
 * 해설을 읽는 동안 질문이 화면 위로 사라져, 무엇에 대한 해설인지 보려면 되돌아가야 했다.
 * 그래서 «패널 끝이 보이는 가장 위» 와 «질문 머리가 보이는 가장 아래» 사이에서 지금 자리와
 * 가장 가까운 곳을 고른다 — 필요한 만큼만 움직인다.
 */
export function feedbackScrollTarget({
  scrollY, viewportHeight, panelBottom, questionTop,
}: FeedbackScrollInput): number | null {
  // 이보다 위에 있으면 패널 끝이 화면 아래로 잘린다
  const lowest = scrollY + panelBottom - viewportHeight;
  // 이보다 아래로 가면 질문 머리가 화면 위로 넘어간다
  const highest = scrollY + questionTop;
  if (lowest > highest) return null;
  return Math.min(Math.max(scrollY, lowest), highest);
}
