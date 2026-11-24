// 오늘의 퀴즈 저장소 (daily). **이 브라우저에만 남는다** — 랭킹(`local-store.ts`)·개인 기록 내보내기·온라인
// 서버 어디에도 가지 않는다. 저장 방식은 `safe-storage.ts` 를 거친다(이 프로젝트에서 localStorage 를 직접
// 만지는 곳은 거기 하나다).
//
// - 날짜마다 열쇠가 따로다(`quiz.daily.v2.<YYYY-MM-DD>`). 한 날짜의 쓰기가 다른 날짜를 덮을 길이 없다
// - 쓰기 직전에 저장소의 것을 다시 읽어 `planDailyWrite` 로 견준다 — 다른 탭이 끝낸 레코드를 덮지 않고,
//   앞서 간 탭의 답을 되돌리지 않는다
// - 쓴 뒤 다시 읽어 같은지 본다. 저장소가 메모리 대체품이거나 쓰기가 던지면 `memory` — 화면은 «저장했어요»라고
//   말하지 않는다
// - 날짜 목록(`quiz.daily.v2.index`)으로 최근 날짜만 남기고 오래된 레코드를 지운다
// - 하루 5문제 시절의 `quiz.daily.v1.*`(레코드·날짜 목록)은 읽지도 쓰지도 지우지도 않는다. 그 답을 20문제 판에
//   얹거나 그 완료를 20문제 완료로 읽지 않는다 — v2 는 열쇠부터 따로다

import { safeStorage, isPersistent, type KeyValueStorage } from './safe-storage.js';
import {
  isDateKey,
  parseDailyRecord,
  planDailyWrite,
  type DailyLoad,
  type DailyStore,
} from '../core/daily.js';

const KEY_PREFIX = 'quiz.daily.v2.';
const INDEX_KEY = 'quiz.daily.v2.index';
/** 남겨 두는 날짜 수. 지난 날의 결과는 화면에서 열지 않으므로 넉넉히 두 주만 둔다 */
const KEEP_DATES = 14;

export function dailyKey(dateKey: string): string {
  return `${KEY_PREFIX}${dateKey}`;
}

function readIndex(storage: KeyValueStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isDateKey) : [];
  } catch {
    return [];
  }
}

/** 날짜 목록에 더하고 오래된 날짜의 레코드를 지운다. 실패해도 저장 자체는 이미 끝났다 */
function rememberDate(storage: KeyValueStorage, dateKey: string): void {
  try {
    const dates = [...new Set([dateKey, ...readIndex(storage)])].sort().reverse();
    for (const old of dates.slice(KEEP_DATES)) storage.removeItem(dailyKey(old));
    storage.setItem(INDEX_KEY, JSON.stringify(dates.slice(0, KEEP_DATES)));
  } catch {
    // 정리는 덤이다. 용량이 꽉 찼어도 오늘의 레코드는 위에서 확인했다
  }
}

export function createDailyStore(
  storage: KeyValueStorage = safeStorage,
  { persistent = isPersistent }: { persistent?: boolean } = {},
): DailyStore {
  function load(dateKey: string): DailyLoad {
    let text: string | null;
    try {
      text = storage.getItem(dailyKey(dateKey));
    } catch {
      return { kind: 'empty' };
    }
    if (text === null) return { kind: 'empty' };
    try {
      const record = parseDailyRecord(JSON.parse(text), dateKey);
      return record ? { kind: 'record', record } : { kind: 'corrupt' };
    } catch {
      return { kind: 'corrupt' };
    }
  }

  return {
    durable: persistent,
    load,

    save(record) {
      const stored = load(record.dateKey);
      const plan = planDailyWrite(stored.kind === 'record' ? stored.record : null, record);
      if (plan.action === 'adopt') return { status: 'adopted', record: plan.record };

      const text = JSON.stringify(record);
      try {
        storage.setItem(dailyKey(record.dateKey), text);
        // 쓴 것이 그대로 읽히는지 본다. 읽히지 않으면 저장했다고 말하지 않는다
        if (storage.getItem(dailyKey(record.dateKey)) !== text) return { status: 'memory', record };
      } catch {
        return { status: 'memory', record };
      }
      rememberDate(storage, record.dateKey);
      return { status: persistent ? 'saved' : 'memory', record };
    },
  };
}
