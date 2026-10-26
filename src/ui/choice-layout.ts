// 보기 목록의 배치 (로컬 퀴즈·온라인 매치가 함께 쓴다)
//
// 넓은 화면은 보기를 늘 바닥 칸과 같은 2×2로 놓는다. 좁은 화면은 긴 보기를 먼저 다 읽도록
// 한 줄에 하나였는데, 그러면 네 줄이 휴대폰 세로를 먹어 답한 뒤 결과 패널과 질문 머리가 한
// 화면에 들지 않았다(375×812에서 질문 첫 줄이 위로 잘렸다). 그래서 넷이 모두 짧을 때만
// `#choices` 에 `data-layout="grid"` 를 달아 좁은 화면도 2×2로 놓는다 — 배치는 CSS 가 정한다.

import { SHORT_CHOICE_MAX_LENGTH } from '../constants.js';

/** `grid` 면 좁은 화면에서도 2×2, `list` 면 좁은 화면에서 한 줄에 하나 */
export type ChoiceLayout = 'grid' | 'list';

/**
 * 보기 글이 모두 `SHORT_CHOICE_MAX_LENGTH` 자 이하이면 `grid` 다.
 * 글자 수는 앞뒤 공백을 걷은 코드 포인트 수로 센다(한글 한 자 = 한 자).
 */
export function choiceLayout(choices: readonly string[]): ChoiceLayout {
  const short = choices.every((text) => Array.from(text.trim()).length <= SHORT_CHOICE_MAX_LENGTH);
  return short ? 'grid' : 'list';
}
