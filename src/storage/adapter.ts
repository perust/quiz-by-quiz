// 저장소 어댑터 (FR-6.8, FR-6.9)
//
// 게임 로직과 화면은 저장 방식을 알지 못한다. 여기서 내보내는 객체만 부른다.
// v2에서 서버 랭킹으로 바꿀 때 고칠 곳은 아래 rankingStore 한 줄이고,
// core/ 와 ui/ 의 호출부는 손대지 않는다.
//
//   - import { createServerRankingStore } from './server-store.js';
//   - export const rankingStore: RankingStore = createServerRankingStore({ baseUrl: '...' });
//
// 그래서 로컬 구현이 동기여도 모든 메서드가 Promise를 반환한다. 호출부는
// 처음부터 await로 쓰게 되고, 실제 네트워크 구현으로 바뀌어도 그대로 돈다.
//
// **계약은 아래 RankingStore 인터페이스에 적혀 있다.** 서버 구현체는 이 타입을
// 달기만 하면 «무엇을 만족해야 하는지»를 컴파일러가 대신 따져 준다.

import { createLocalRankingStore, createLocalPreferences } from './local-store.js';
import type { RankingTarget, ScoreRecord, Settings } from '../types.js';

/**
 * 저장할 기록. **id는 저장소가 발급한다** (v2 서버 구현체에서도 서버 몫이다).
 *
 * 이미 id가 붙은 기록을 그대로 넘기는 길도 열어 둔다 — 구현체는 있으면 쓰고
 * 없으면 새로 만든다.
 */
export type SaveRecordInput = Omit<ScoreRecord, 'id'> & { id?: string };

/** 저장 결과. kept가 false면 상위 10위 밖이라 목록에 남지 않은 것이다 (FR-6.4) */
export interface SaveOutcome {
  record: ScoreRecord;
  /** 1부터 센 순위 */
  rank: number;
  kept: boolean;
  /** 저장 자체가 됐는가. 용량이 꽉 차면 false다 */
  stored: boolean;
}

/**
 * 랭킹 저장소가 지켜야 할 계약. 구현체는 이 네 가지를 모두 Promise로 제공한다.
 */
export interface RankingStore {
  /** 기록을 저장하고 순위를 알려준다. id 발급은 저장소 몫이다 */
  saveRecord(input: SaveRecordInput): Promise<SaveOutcome>;
  /** 해당 랭킹의 상위 10개를 정렬된 순서로 돌려준다 */
  getRankings(target: RankingTarget): Promise<ScoreRecord[]>;
  /** 해당 랭킹의 최고 점수. 기록이 없으면 null */
  getBestScore(target: RankingTarget): Promise<number | null>;
  /** 모든 랭킹 기록을 지운다 */
  clearAll(): Promise<void>;
}

/**
 * 닉네임·음소거 설정·직전 출제 이력. 랭킹과 달리 v2에서도 브라우저에 남을 값이라
 * 어댑터 교체 대상이 아니다. 그래서 RankingStore와 분리해 둔다.
 *
 * 여기도 모두 Promise다 — 부르는 쪽이 두 저장소를 다르게 쓰지 않게 하려는 것이다.
 */
export interface Preferences {
  /** 마지막으로 입력한 닉네임 (FR-6.11) */
  getNickname(): Promise<string>;
  setNickname(nickname: string): Promise<void>;
  /** 음소거 등 사용자 설정 (PRD 6.3) */
  getSettings(): Promise<Settings>;
  /** 넘긴 값만 바꾼다. 나머지 설정은 그대로 남는다 */
  setSettings(patch: Partial<Settings>): Promise<void>;
  /** 다음 판에서 후순위로 밀 최근 출제 문제 (FR-1.4) */
  getRecentQuestionIds(): Promise<string[]>;
  setRecentQuestionIds(ids: string[]): Promise<void>;
}

export const rankingStore: RankingStore = createLocalRankingStore();

export const preferences: Preferences = createLocalPreferences();
