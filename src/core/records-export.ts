// 이 브라우저의 기록을 파일 하나로 묶는다 (N02, 선생님 모드).
//
// 앱은 서버가 없어 기록이 각 학생 브라우저에만 남는다(PRD 9.1). 예전에는 학생이 개발자 도구
// 콘솔(F12)에 스니펫을 붙여 넣어야 했는데, 휴대폰·태블릿·관리형 크롬북에서는 콘솔을 열 수 없다.
// 그래서 랭킹 화면의 「기록 내보내기」가 이 모양의 JSON 을 내려받게 한다.
//
// **선생님 모드 로더(`.claude/commands/quiz-teacher-collect.md` 등)와 맞물리는 모양이다.** 로더는
// 감싼 객체의 `records` 를 읽고, `student` 가 없으면 파일 이름을 학생 이름으로 쓴다 — 그래서 여기에
// `student` 를 두지 않는다(`types.ts` 의 `RecordsExport`). 모양을 바꾸면 `RECORDS_EXPORT_VERSION` 을
// 올리고 그 로더와 `tests/fixtures/records-export.json` 을 함께 고친다.
//
// DOM 도 저장소도 모른다. 기록은 `app.ts` 가 랭킹 어댑터로 읽어 넘긴다.

import { RANKING_TOP_N, TIME_LIMIT_MS } from '../constants.js';
import type { OnlineExportRecord, RecordsExport, ScoreRecord } from '../types.js';

/** 내보낸 파일 모양의 판 */
export const RECORDS_EXPORT_VERSION = 1;

/** 파일이 담은 범위. 랭킹 저장소는 탭마다 상위 N개만 남기고 밀려난 판은 지운다 (FR-6.4) */
export const RECORDS_EXPORT_SCOPE =
  `이 브라우저에 남은 기록이에요. 랭킹 탭마다 상위 ${RANKING_TOP_N}개까지만 남아 있어 그보다 아래로 밀린 판은 없어요.`;

export interface RecordsExportInput {
  /** 모든 랭킹 탭의 기록. 탭마다 따로 읽어 이어 붙인 것이라 겹쳐도 된다 */
  records: readonly ScoreRecord[];
  nickname: string;
  now: Date;
}

export function buildRecordsExport({ records, nickname, now }: RecordsExportInput): RecordsExport {
  const seen = new Set<string>();
  const unique = records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
  // 오래된 판부터. 선생님 쪽은 시각순으로 읽는다 (같은 시각이면 id 순으로 고정한다)
  unique.sort((left, right) => left.playedAt.localeCompare(right.playedAt)
    || left.id.localeCompare(right.id));

  return {
    app: 'quiz-by-quiz',
    kind: 'records',
    schemaVersion: RECORDS_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    nickname,
    scope: RECORDS_EXPORT_SCOPE,
    // 문항별 정오(questionResults)·문항 시간(timeLimitMs) 같은 선택 필드도 그대로 싣는다
    records: unique.map((record) => ({ ...record })),
  };
}

/** 파일 이름에 쓸 수 없는 글자와 공백 */
const UNSAFE_FILE_CHARACTERS = /[\\/:*?"<>|\s.]+/g;

/**
 * 내려받을 파일 이름: `quiz-by-quiz-기록-<닉네임>-<YYYY-MM-DD>.json`. 날짜는 그 기기의 날이다.
 * 닉네임은 선생님이 누구 파일인지 알아보는 실마리일 뿐이고, 받은 뒤 `<학생 이름>.json` 으로 바꿔 넣는다.
 */
export function recordsExportFileName(nickname: string, now: Date): string {
  const name = nickname.replace(UNSAFE_FILE_CHARACTERS, '_').replace(/^_+|_+$/g, '') || '나';
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `quiz-by-quiz-기록-${name}-${day}.json`;
}

/**
 * 온라인 기록 파일이 담은 범위 (FR-7.13 3단계). 서버는 최근 8주와 판마다 전체 상위 100을 남기고, 내보내기는 그
 * 가운데 최근 기록부터 한도까지 싣는다. 한도에 닿았으면 그렇다고 덧붙인다
 */
export function onlineRecordsExportScope(limit: number, truncated: boolean): string {
  const base = '온라인에서 끝까지 푼 판의 기록이에요. 최근 8주의 기록과 판마다 상위 100개가 남아 있어요.';
  return truncated ? `${base} 그 가운데 최근 ${limit}개만 담았어요.` : base;
}

/** 내보낼 온라인 기록 한 줄의 입력. 서버의 내 기록 응답을 화면 쪽 모양으로 옮긴 것이다 */
export interface OnlineRecordInput {
  mode: ScoreRecord['mode'];
  category: ScoreRecord['category'];
  score: number;
  correctCount: number;
  totalCount: number;
  /** null은 «제한 없음»으로 푼 혼자 판이다 (PRD 10.1 #9) */
  questionTimeMs: number | null;
  nickname: string;
  recordedAt: string;
}

/**
 * 내 온라인 기록을 이 브라우저의 기록과 **같은 모양의 파일**로 묶는다 (N02의 서버 기록 이전). 선생님 모드 로더가 읽는
 * 칸은 그대로이고, 기록마다 `source: 'online'`이 붙으며 소요 시간·문항별 정오는 없다 — 서버 기록에 없는 값을 지어내지
 * 않는다. 브라우저 신분은 서버가 보내지 않으므로 실을 수도 없다. `id`는 이 파일 안에서만 쓰는 번호다.
 */
export function buildOnlineRecordsExport({
  records, nickname, now, limit, truncated,
}: {
  records: readonly OnlineRecordInput[];
  nickname: string;
  now: Date;
  limit: number;
  truncated: boolean;
}): RecordsExport {
  // 오래된 판부터 (이 브라우저의 기록 파일과 같다)
  const ordered = [...records].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  return {
    app: 'quiz-by-quiz',
    kind: 'records',
    schemaVersion: RECORDS_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    nickname,
    scope: onlineRecordsExportScope(limit, truncated),
    records: ordered.map((record, index): OnlineExportRecord => ({
      id: `online-${index + 1}`,
      source: 'online',
      nickname: record.nickname,
      mode: record.mode,
      category: record.category,
      score: record.score,
      correctCount: record.correctCount,
      totalCount: record.totalCount,
      playedAt: record.recordedAt,
      ...(record.questionTimeMs === TIME_LIMIT_MS ? {} : { timeLimitMs: record.questionTimeMs }),
    })),
  };
}
