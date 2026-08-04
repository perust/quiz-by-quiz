// localStorage 구현체 (FR-6.7, PRD 6.3)
//
// ★ 이 프로젝트에서 window.localStorage를 직접 만지는 유일한 파일이다.
//   core/ 나 ui/ 에서 localStorage를 부르면 설계 위반이다. 저장이 필요하면
//   storage/adapter.js가 내보내는 객체를 통해서만 접근한다.
//
// 저장 데이터가 깨져도 앱을 죽이지 않고 빈 값으로 되돌린다 (PRD 8).

import { RANKING_TOP_N } from '../constants.js';
import { bestScore, placeRecord, selectRanking, isSameRanking } from '../core/ranking.js';

/** 저장소 키 (PRD 6.3). 키 이름은 저장 방식의 세부사항이라 이 파일 밖으로 새지 않는다 */
const KEYS = {
  rankings: 'quiz.rankings',
  settings: 'quiz.settings',
  nickname: 'quiz.nickname',
  recentQuestionIds: 'quiz.recentQuestionIds',
  schemaVersion: 'quiz.schemaVersion',
};

/** 사용자 설정 기본값. 저장된 값이 없거나 깨졌을 때 이걸로 되돌린다 */
const DEFAULT_SETTINGS = { soundEnabled: true };

/** 저장 데이터 스키마 버전. 구조가 바뀌면 올린다 (v2 마이그레이션 판단 기준) */
const SCHEMA_VERSION = 1;

// ── 저장소 확보 ──────────────────────────────────────────────────

/**
 * localStorage를 못 쓰는 환경(사생활 보호 모드, 저장소 차단)을 위한 대체품.
 * 이번 세션 동안만 살아 있고 탭을 닫으면 사라진다. 기록이 남지 않을 뿐
 * 게임은 정상 동작한다.
 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  };
}

/**
 * 쓰기까지 실제로 되는지 확인한다.
 * 사파리 사생활 보호 모드처럼 객체는 있는데 setItem에서 던지는 경우가 있다.
 */
function resolveStorage() {
  try {
    const probeKey = '__quiz_probe__';
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch (error) {
    console.warn(`[저장소] localStorage를 쓸 수 없어 이번 세션에만 기록을 유지합니다: ${error.message}`);
    return createMemoryStorage();
  }
}

const storage = resolveStorage();

// ── 안전한 읽기·쓰기 ─────────────────────────────────────────────

/**
 * 손상 경고는 사연마다 한 번만 남긴다.
 * 저장된 값은 조회할 때마다 다시 읽으므로(홈 화면만 해도 최고 점수를 다섯 번 묻는다)
 * 억제하지 않으면 같은 경고가 콘솔을 뒤덮는다.
 */
const warnedReasons = new Set();

function warnOnce(reason, message) {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  console.warn(message);
}

/** 값이 없거나 깨졌으면 fallback을 돌려준다. 예외를 밖으로 던지지 않는다 */
function readJson(key, fallback) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    console.warn(`[저장소] ${key} 읽기 실패: ${error.message}`);
    return fallback;
  }

  if (raw === null) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    warnOnce(`${key}:parse`, `[저장소] ${key} 값이 손상되어 무시합니다`);
    return fallback;
  }
}

/** 저장에 실패해도(용량 초과 등) 게임은 계속된다. 성공 여부만 알린다 */
function writeJson(key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.warn(`[저장소] ${key} 저장 실패: ${error.message}`);
    return false;
  }
}

// ── 스키마 버전 ──────────────────────────────────────────────────

/**
 * 모듈을 처음 불러올 때 한 번 확인한다.
 * v1에는 이전 버전이 없으므로 버전이 어긋나면 해석할 방법이 없다.
 * 이때는 랭킹만 비우고 다시 시작한다. 닉네임 같은 다른 키는 건드리지 않는다.
 */
function ensureSchemaVersion() {
  const stored = readJson(KEYS.schemaVersion, null);
  if (stored === SCHEMA_VERSION) return;

  if (stored !== null) {
    console.warn(`[저장소] 알 수 없는 스키마 버전(${stored})이라 랭킹을 비우고 시작합니다`);
    writeJson(KEYS.rankings, []);
  }
  writeJson(KEYS.schemaVersion, SCHEMA_VERSION);
}

ensureSchemaVersion();

// ── 기록 검증 ────────────────────────────────────────────────────

/**
 * ScoreRecord 형태인지 본다 (PRD 6.2).
 * 손상된 기록 하나 때문에 나머지 기록까지 잃지 않도록 낱개로 판정한다.
 */
function isValidRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    typeof value.nickname === 'string' &&
    (value.mode === 'category' || value.mode === 'all') &&
    Number.isFinite(value.score) &&
    Number.isFinite(value.correctCount) &&
    Number.isFinite(value.totalCount) &&
    typeof value.playedAt === 'string'
  );
}

/**
 * 문항별 정오 (선택 필드).
 *
 * 이 필드가 없는 예전 기록도 그대로 살린다. 그래서 스키마 버전을 올리지 않았다 —
 * 올리면 ensureSchemaVersion이 기존 랭킹을 통째로 비운다. 더하기만 하는 변경이라
 * 예전 기록은 이 값 없이, 새 기록은 이 값을 갖고 공존한다.
 */
function normalizeQuestionResults(value) {
  if (!Array.isArray(value)) return null;

  const cleaned = value
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => ({
      id: item.id,
      correct: Boolean(item.correct),
      timedOut: Boolean(item.timedOut),
    }));

  return cleaned.length > 0 ? cleaned : null;
}

/** 전체 모드 기록의 category는 항상 null로 맞춘다 (PRD 6.2) */
function normalizeRecord(record) {
  const questionResults = normalizeQuestionResults(record.questionResults);

  const normalized = {
    ...record,
    category: record.mode === 'all' ? null : (record.category ?? null),
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : 0,
  };

  // 값이 없거나 깨졌으면 키 자체를 남기지 않는다. 빈 배열이 "다 틀렸다"로 읽히면 안 된다
  if (questionResults) normalized.questionResults = questionResults;
  else delete normalized.questionResults;

  return normalized;
}

/** 저장된 기록 전체. 어떤 상황에서도 배열을 돌려준다 */
function readRecords() {
  const parsed = readJson(KEYS.rankings, []);

  if (!Array.isArray(parsed)) {
    warnOnce(`${KEYS.rankings}:shape`, '[저장소] 랭킹이 배열이 아니어서 빈 랭킹으로 시작합니다');
    return [];
  }

  const valid = parsed.filter(isValidRecord);
  if (valid.length !== parsed.length) {
    warnOnce(
      `${KEYS.rankings}:records:${parsed.length - valid.length}`,
      `[저장소] 형식이 깨진 기록 ${parsed.length - valid.length}건을 제외했습니다`
    );
  }

  return valid.map(normalizeRecord);
}

/** 기록 ID. randomUUID는 보안 컨텍스트에서만 제공돼 대비책을 함께 둔다 */
function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── 랭킹 저장소 ──────────────────────────────────────────────────

/**
 * 랭킹 어댑터의 localStorage 구현체 (FR-6.8).
 * 로컬 저장은 동기지만 모든 메서드가 Promise를 반환한다. 그래야 v2에서
 * 서버 구현체로 갈아끼울 때 호출부를 고치지 않는다 (FR-6.9).
 */
export function createLocalRankingStore() {
  return {
    /**
     * 기록을 저장하고 순위를 알려준다. id는 저장소가 붙인다
     * (v2 서버 구현체에서도 서버가 발급하게 되는 값이다).
     *
     * @param {object} input nickname·mode·category·score·correctCount·totalCount·durationMs·playedAt
     * @returns {Promise<{record: object, rank: number, kept: boolean, stored: boolean}>}
     *   kept가 false면 상위 10위 밖이라 목록에 남지 않은 것이다 (FR-6.4).
     */
    async saveRecord(input) {
      const record = normalizeRecord({ ...input, id: input.id ?? createId() });
      const all = readRecords();
      const { ranking, rank, kept } = placeRecord(all, record, RANKING_TOP_N);

      // 이번 랭킹만 상위 10개로 자르고 다른 랭킹의 기록은 그대로 둔다
      const others = all.filter((item) => !isSameRanking(item, record));
      const stored = writeJson(KEYS.rankings, [...others, ...ranking]);

      return { record, rank, kept: kept && stored, stored };
    },

    /**
     * 한 랭킹의 상위 10개를 정렬된 순서로 돌려준다 (FR-6.3, FR-6.4).
     * @param {{mode: 'category'|'all', category: string|null}} target
     * @returns {Promise<object[]>}
     */
    async getRankings(target) {
      return selectRanking(readRecords(), target, RANKING_TOP_N);
    },

    /**
     * 해당 랭킹의 최고 점수. 기록이 없으면 null (FR-5.7).
     * @returns {Promise<number|null>}
     */
    async getBestScore(target) {
      return bestScore(readRecords(), target);
    },

    /** 모든 랭킹 기록을 지운다 (FR-6.6). 닉네임 설정은 남긴다 */
    async clearAll() {
      writeJson(KEYS.rankings, []);
    },
  };
}

// ── 로컬 설정 ────────────────────────────────────────────────────

/**
 * 랭킹과 달리 v2에서도 브라우저에 남을 값들이다.
 * 서버로 옮겨갈 랭킹 어댑터와 섞지 않는다.
 */
export function createLocalPreferences() {
  return {
    /** 마지막으로 입력한 닉네임 (FR-6.11) */
    async getNickname() {
      const value = readJson(KEYS.nickname, '');
      return typeof value === 'string' ? value : '';
    },

    async setNickname(nickname) {
      writeJson(KEYS.nickname, nickname);
    },

    /** 음소거 등 사용자 설정 (PRD 6.3). 깨져 있으면 기본값으로 돌린다 */
    async getSettings() {
      const stored = readJson(KEYS.settings, null);
      if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
        return { ...DEFAULT_SETTINGS };
      }
      return {
        ...DEFAULT_SETTINGS,
        // 값 하나가 깨져도 나머지 설정은 살린다
        ...(typeof stored.soundEnabled === 'boolean' ? { soundEnabled: stored.soundEnabled } : {}),
      };
    },

    async setSettings(patch) {
      const current = readJson(KEYS.settings, null);
      const base = typeof current === 'object' && current !== null && !Array.isArray(current)
        ? current
        : {};
      writeJson(KEYS.settings, { ...base, ...patch });
    },

    /** 직전 판에 출제된 문제 ID (FR-1.4) */
    async getRecentQuestionIds() {
      const value = readJson(KEYS.recentQuestionIds, []);
      if (!Array.isArray(value)) return [];
      return value.filter((id) => typeof id === 'string');
    },

    async setRecentQuestionIds(ids) {
      writeJson(KEYS.recentQuestionIds, ids);
    },
  };
}
