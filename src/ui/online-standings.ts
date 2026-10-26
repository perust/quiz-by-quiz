// 온라인 순위 표시 (U30·U38). 공개 단계의 미니 점수판과 최종 순위가 **같은 규칙**을 쓴다.
//
// 배열 순서는 서버가 정한 그대로 둔다. 점수(맞힌 개수 × 10)만 순위를 나눈다 — 빨리 낸 사람이나
// 이름이 앞선 사람에게 더 높은 순위를 주지 않는다 (PRD 2.1). 서버 정렬은 동점을 닉네임 순으로
// 늘어놓을 뿐이라, 앞 사람과 점수가 같으면 같은 순위를 받는다(1, 1, 3).

import type { OnlineScore } from '../online/adapter.js';

export interface OnlinePlace {
  place: number;
  /** 같은 점수의 참가자와 순위를 나눠 가졌는가 */
  tied: boolean;
}

export function onlinePlaces(scores: readonly Pick<OnlineScore, 'score'>[]): OnlinePlace[] {
  let previousPlace = 0;
  return scores.map((score, index) => {
    const sharesWithPrevious = index > 0 && scores[index - 1].score === score.score;
    const sharesWithNext = index + 1 < scores.length && scores[index + 1].score === score.score;
    const place = sharesWithPrevious ? previousPlace : index + 1;
    previousPlace = place;
    return { place, tied: sharesWithPrevious || sharesWithNext };
  });
}

/** 순위 표시. 동점이면 «공동»을 글자로 붙인다 — 색이나 줄 순서만으로 알리지 않는다. */
export function onlinePlaceLabel(place: number, tied: boolean): string {
  return tied ? `공동 ${place}위` : `${place}위`;
}
