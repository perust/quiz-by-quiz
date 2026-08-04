// 저장소 어댑터 (FR-6.8, FR-6.9)
//
// 게임 로직과 화면은 저장 방식을 알지 못한다. 여기서 내보내는 객체만 부른다.
// v2에서 서버 랭킹으로 바꿀 때 고칠 곳은 아래 rankingStore 한 줄이고,
// core/ 와 ui/ 의 호출부는 손대지 않는다.
//
//   - import { createServerRankingStore } from './server-store.js';
//   - export const rankingStore = createServerRankingStore({ baseUrl: '...' });
//
// 그래서 로컬 구현이 동기여도 모든 메서드가 Promise를 반환한다. 호출부는
// 처음부터 await로 쓰게 되고, 실제 네트워크 구현으로 바뀌어도 그대로 돈다.

import { createLocalRankingStore, createLocalPreferences } from './local-store.js';

/**
 * 랭킹 기록 (PRD 6.2)
 *
 * @typedef {object} ScoreRecord
 * @property {string} id
 * @property {string} nickname
 * @property {'category'|'all'} mode
 * @property {string|null} category mode가 'all'이면 null
 * @property {number} score
 * @property {number} correctCount
 * @property {number} totalCount
 * @property {number} durationMs 개인 지표. 순위에는 반영하지 않는다 (FR-5.3)
 * @property {string} playedAt ISO 8601 문자열
 */

/**
 * 랭킹을 가르는 기준 (FR-6.2)
 *
 * @typedef {{ mode: 'category'|'all', category: string|null }} RankingTarget
 */

/**
 * 랭킹 저장소가 지켜야 할 계약. 구현체는 이 네 가지를 모두 Promise로 제공한다.
 *
 * @typedef {object} RankingStore
 * @property {(input: Omit<ScoreRecord, 'id'>) => Promise<{record: ScoreRecord, rank: number, kept: boolean, stored: boolean}>} saveRecord
 *   기록을 저장하고 순위를 알려준다. id 발급은 저장소 몫이다.
 * @property {(target: RankingTarget) => Promise<ScoreRecord[]>} getRankings
 *   해당 랭킹의 상위 10개를 정렬된 순서로 돌려준다.
 * @property {(target: RankingTarget) => Promise<number|null>} getBestScore
 *   해당 랭킹의 최고 점수. 기록이 없으면 null.
 * @property {() => Promise<void>} clearAll
 *   모든 랭킹 기록을 지운다.
 */

/** @type {RankingStore} */
export const rankingStore = createLocalRankingStore();

/**
 * 닉네임·음소거 설정·직전 출제 이력. 랭킹과 달리 v2에서도 브라우저에 남을 값이라
 * 어댑터 교체 대상이 아니다. 그래서 rankingStore와 분리해 둔다.
 *
 * getNickname / setNickname / getSettings / setSettings /
 * getRecentQuestionIds / setRecentQuestionIds 를 모두 Promise로 제공한다.
 */
export const preferences = createLocalPreferences();
