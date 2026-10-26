// 온라인 로비의 목록 정책. DOM도 저장소도 모르는 순수 함수만 둔다.
//
// 방 목록은 로컬 저장소와 서버 저장소가 같은 순서·필터로 보여야 한다. 화면 안에서
// 즉석으로 정렬하면 구현체를 바꿀 때 규칙이 갈라지므로 이 파일 한 곳에서 결정한다.

import type { PublicRoom } from './adapter.js';
import type { CategoryId } from '../types.js';

export type RoomVisibilityFilter = 'all' | 'public' | 'private';
export type RoomAvailabilityFilter = 'all' | 'joinable' | 'full';
/** `any`는 모든 형식, `all`은 카테고리를 섞는 「전체 도전」이다 */
export type RoomCategoryFilter = 'any' | 'all' | CategoryId;

export interface RoomListFilters {
  query: string;
  visibility: RoomVisibilityFilter;
  availability: RoomAvailabilityFilter;
  categoryId: RoomCategoryFilter;
}

export const DEFAULT_ROOM_FILTERS: RoomListFilters = {
  query: '',
  visibility: 'all',
  availability: 'all',
  categoryId: 'any',
};

/** 빈자리가 있는가. 「가득 참」 필터는 판이 도는지와 상관없이 이것만 본다 */
export function hasOpenSeat(room: PublicRoom): boolean {
  return room.players.length < room.capacity;
}

/** 판이 도는 방인가. 서버는 진행 중인 판에 새 참가를 받지 않는다 (U33) */
export function isRoomPlaying(room: PublicRoom): boolean {
  return room.status === 'playing';
}

/** 지금 새로 들어갈 수 있는가. 빈자리가 있어도 판이 도는 동안은 아니다 */
export function isRoomJoinable(room: PublicRoom): boolean {
  return hasOpenSeat(room) && !isRoomPlaying(room);
}

export type RoomListAction = 'enter' | 'join' | 'password' | 'playing' | 'full';

/**
 * 목록의 참가 버튼이 해야 할 일. 이미 참가한 방은 정원이 차도, 판이 돌아도 다시 들어갈
 * 수 있다 — 들어가면 대기실이 진행 중인 판으로 이어 준다.
 */
export function roomListAction(room: PublicRoom): RoomListAction {
  if (room.joined) return 'enter';
  if (isRoomPlaying(room)) return 'playing';
  if (!hasOpenSeat(room)) return 'full';
  return room.isPublic ? 'join' : 'password';
}

function matches(room: PublicRoom, filters: RoomListFilters): boolean {
  const query = filters.query.trim().toLocaleLowerCase('ko-KR');
  if (query) {
    const target = `${room.name}\n${room.code}`.toLocaleLowerCase('ko-KR');
    if (!target.includes(query)) return false;
  }

  if (filters.visibility === 'public' && !room.isPublic) return false;
  if (filters.visibility === 'private' && room.isPublic) return false;

  if (filters.availability === 'joinable' && !isRoomJoinable(room)) return false;
  if (filters.availability === 'full' && hasOpenSeat(room)) return false;

  if (filters.categoryId === 'all' && room.categoryId !== null) return false;
  if (filters.categoryId !== 'any' && filters.categoryId !== 'all'
      && room.categoryId !== filters.categoryId) return false;
  return true;
}

/**
 * 기본 순서:
 *   1. 내가 들어가 있는 방 — 돌아갈 길이 맨 위에 있어야 한다 (U35)
 *   2. 기다리는 방, 그 다음 게임 중인 방 (U33)
 *   3. 빈자리가 있는 방
 *   4. 같은 정원 상태에서는 공개방, 그 다음 잠긴 방
 *   5. 같은 우선순위에서는 최신 생성순
 *   6. 생성 시각까지 같으면 코드 오름차순(항상 같은 결과를 위한 마지막 기준)
 *
 * 원본 배열은 바꾸지 않는다. 저장소가 캐시한 배열을 화면 정렬 때문에 변형하지 않게
 * `filter`가 만든 새 배열만 정렬한다.
 */
export function filterAndSortRooms(
  rooms: readonly PublicRoom[],
  filters: RoomListFilters,
): PublicRoom[] {
  return rooms.filter((room) => matches(room, filters)).sort((left, right) => {
    const mine = Number(!left.joined) - Number(!right.joined);
    if (mine !== 0) return mine;

    const playing = Number(isRoomPlaying(left)) - Number(isRoomPlaying(right));
    if (playing !== 0) return playing;

    const availability = Number(!hasOpenSeat(left)) - Number(!hasOpenSeat(right));
    if (availability !== 0) return availability;

    const visibility = Number(!left.isPublic) - Number(!right.isPublic);
    if (visibility !== 0) return visibility;

    const newest = right.createdAt.localeCompare(left.createdAt);
    if (newest !== 0) return newest;
    return left.code.localeCompare(right.code);
  });
}