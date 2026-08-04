// 랭킹 규칙 (FR-6.2 ~ FR-6.4)
// 순수 함수만 둔다. 기록이 어디에 저장되는지는 이 파일이 알지 못한다.
// 저장소 구현체가 바뀌어도(v2 서버) 이 규칙은 그대로 쓴다.

import { RANKING_TOP_N } from '../constants.js';

/**
 * 랭킹을 가르는 기준. 모드와 카테고리 조합 하나가 랭킹 하나다 (FR-6.2).
 * mode가 'all'이면 category는 null이다.
 *
 * @typedef {{ mode: 'category'|'all', category: string|null }} RankingTarget
 */

/** 두 값을 같은 랭킹으로 볼 것인가 */
export function isSameRanking(record, target) {
  return record.mode === target.mode && (record.category ?? null) === (target.category ?? null);
}

/**
 * 기록 시각을 비교용 숫자로 바꾼다.
 * 시각이 깨진 기록은 맨 뒤로 밀어 정렬이 흔들리지 않게 한다.
 */
function playedAtValue(record) {
  const time = Date.parse(record.playedAt);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

/**
 * 점수 내림차순, 동점이면 먼저 달성한 순 (FR-6.3).
 * 소요 시간은 순위에 반영하지 않는다 (PRD 2.1 설계 원칙).
 *
 * @param {object[]} records
 * @returns {object[]} 새 배열
 */
export function sortRecords(records) {
  return [...records].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return playedAtValue(a) - playedAtValue(b);
  });
}

/**
 * 전체 기록에서 한 랭킹만 골라 정렬하고 상위 N개를 자른다.
 *
 * @param {object[]} records 모든 모드·카테고리가 섞인 기록
 * @param {RankingTarget} target
 * @param {number} size
 */
export function selectRanking(records, target, size = RANKING_TOP_N) {
  return sortRecords(records.filter((record) => isSameRanking(record, target))).slice(0, size);
}

/**
 * 해당 랭킹의 최고 점수. 기록이 없으면 null (FR-5.7의 "첫 기록" 판정에 쓴다).
 *
 * @param {object[]} records
 * @param {RankingTarget} target
 * @returns {number|null}
 */
export function bestScore(records, target) {
  const ranking = selectRanking(records, target, 1);
  return ranking.length > 0 ? ranking[0].score : null;
}

/**
 * 새 기록을 해당 랭킹에 끼워 넣고 결과를 계산한다.
 * 상위 N개만 남기므로 밀려난 기록은 사라진다 (FR-6.4).
 *
 * @param {object[]} records 모든 기록
 * @param {object} record 새 기록. id가 있어야 순위를 찾을 수 있다
 * @param {number} size
 * @returns {{ ranking: object[], rank: number, kept: boolean }}
 *   rank는 1부터 센 순위, kept는 상위 N개 안에 남았는지 여부다.
 */
export function placeRecord(records, record, size = RANKING_TOP_N) {
  const sameRanking = records.filter((item) => isSameRanking(item, record));
  const ordered = sortRecords([...sameRanking, record]);
  const index = ordered.findIndex((item) => item.id === record.id);

  return {
    ranking: ordered.slice(0, size),
    rank: index + 1,
    kept: index < size,
  };
}
