// 게임 전반에서 쓰는 상수를 이 파일 한 곳에 모은다.
// 값 조정이 필요하면 다른 파일을 뒤지지 않고 여기만 고친다.

/** 한 판에 출제할 문항 수. 문제 은행 크기와 분리해 관리한다 (FR-1.2) */
export const QUESTIONS_PER_ROUND = 10;

/** 문항당 제한 시간 (밀리초, FR-3.7) */
export const TIME_LIMIT_MS = 20_000;

/** 남은 시간이 이 값 이하로 떨어지면 경고 상태로 전환한다 (FR-3.9) */
export const WARNING_THRESHOLD_MS = 5_000;

/** 정답 1문항당 배점 (FR-5.1). 속도 보너스나 난이도 배점은 두지 않는다 */
export const POINTS_PER_CORRECT = 10;

/**
 * 다음 판에서 후순위로 밀 «최근 출제 문제» 를 몇 개까지 기억할지 (FR-1.4).
 *
 * 직전 한 판(10개)만 기억하면 은행이 커져도 같은 문제가 금방 되돌아온다.
 * 반대로 한 카테고리 은행 전체를 덮을 만큼 크면 모두 «본 문제»가 되어
 * 기억하지 않은 것과 같아진다 — 그래서 가장 작은 카테고리 은행보다 넉넉히
 * 작게 잡는다. 은행을 크게 늘리면 이 값도 함께 키운다.
 */
export const RECENT_QUESTION_MEMORY = 60;

/** 랭킹 하나에 보관하고 표시할 상위 기록 수 (FR-6.4) */
export const RANKING_TOP_N = 10;

/** 닉네임 길이 제한 (FR-6.1) */
export const NICKNAME_MIN_LENGTH = 2;
export const NICKNAME_MAX_LENGTH = 10;

/** 보기 개수. 데이터 검증 기준으로도 쓴다 */
export const CHOICE_COUNT = 4;

/** 문제 JSON이 놓인 디렉터리. 상대 경로라서 하위 경로 배포에서도 동작한다 */
export const DATA_DIR = 'data';

/**
 * 카테고리 정의. id는 PRD 6.1의 카테고리 코드이자 JSON 파일 이름이다.
 * (`data/history.json` 등)
 */
export const CATEGORIES = [
  { id: 'history', name: '한국사', icon: '📜', description: '연표 속 그날의 이야기' },
  { id: 'science', name: '과학', icon: '🔬', description: '자연과 우주의 기본기' },
  { id: 'geography', name: '지리', icon: '🗺️', description: '땅과 도시에 관한 감각' },
  { id: 'general', name: '일반상식', icon: '💡', description: '알아두면 쓸모 있는 것들' },
  { id: 'art', name: '예술과문화', icon: '🎨', description: '그림과 음악, 이야기의 결' },
];
