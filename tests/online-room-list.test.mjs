import test from 'node:test';
import assert from 'node:assert/strict';

import { ROOM_CAPACITY_CHOICES } from '../js/constants.js';
import {
  DEFAULT_ROOM_FILTERS,
  filterAndSortRooms,
  roomListAction,
} from '../js/online/room-list.js';

function room({
  code,
  name = code,
  categoryId = 'history',
  capacity = 4,
  playerCount = 1,
  isPublic = true,
  gameMode = true,
  createdAt = '2026-09-17T00:00:00.000Z',
}) {
  return {
    code,
    name,
    categoryId,
    capacity,
    gameMode,
    players: Array.from({ length: playerCount }, (_, index) => ({
      id: `${code}-${index}`,
      nickname: `참가자${index + 1}`,
    })),
    isPublic,
    hasPassword: !isPublic,
    isMine: false,
    joined: false,
    createdAt,
  };
}

test('방 최대 인원 선택지는 12명까지 제공한다', () => {
  assert.deepEqual(ROOM_CAPACITY_CHOICES, [2, 4, 6, 8, 10, 12]);
});

test('입장 가능한 방을 먼저 두고 같은 상태에서는 공개방을 비공개방보다 앞에 둔다', () => {
  const rooms = [
    room({ code: 'PVFULL', isPublic: false, capacity: 2, playerCount: 2 }),
    room({ code: 'PUBFUL', isPublic: true, capacity: 2, playerCount: 2 }),
    room({ code: 'PRIVATE', isPublic: false }),
    room({ code: 'PUBLIC', isPublic: true }),
  ];

  const result = filterAndSortRooms(rooms, DEFAULT_ROOM_FILTERS);

  assert.deepEqual(result.map(({ code }) => code), [
    'PUBLIC',
    'PRIVATE',
    'PUBFUL',
    'PVFULL',
  ]);
  assert.deepEqual(rooms.map(({ code }) => code), [
    'PVFULL',
    'PUBFUL',
    'PRIVATE',
    'PUBLIC',
  ], '원본 목록은 바꾸지 않는다');
});

test('같은 우선순위에서는 최신 방을 먼저 두고 생성 시각까지 같으면 코드순으로 고정한다', () => {
  const rooms = [
    room({ code: 'BBBBBB', createdAt: '2026-09-17T09:00:00.000Z' }),
    room({ code: 'CCCCCC', createdAt: '2026-09-17T10:00:00.000Z' }),
    room({ code: 'AAAAAA', createdAt: '2026-09-17T10:00:00.000Z' }),
  ];

  assert.deepEqual(
    filterAndSortRooms(rooms, DEFAULT_ROOM_FILTERS).map(({ code }) => code),
    ['AAAAAA', 'CCCCCC', 'BBBBBB'],
  );
});

test('공개 여부, 입장 가능 여부, 게임 형식, 제목이나 코드 검색을 함께 적용한다', () => {
  const rooms = [
    room({ code: 'HIST12', name: '한국사 같이 풀기', categoryId: 'history', isPublic: false }),
    room({ code: 'HIST99', name: '한국사 만원', categoryId: 'history', isPublic: false, capacity: 2, playerCount: 2 }),
    room({ code: 'SCIEN1', name: '과학 실험실', categoryId: 'science', isPublic: false }),
    room({ code: 'PUB123', name: '한국사 공개방', categoryId: 'history', isPublic: true }),
  ];

  const result = filterAndSortRooms(rooms, {
    query: 'hist',
    visibility: 'private',
    availability: 'joinable',
    categoryId: 'history',
  });

  assert.deepEqual(result.map(({ code }) => code), ['HIST12']);
});

test('게임 형식 필터는 모든 형식과 전체 도전을 구분한다', () => {
  const rooms = [
    room({ code: 'ALL123', categoryId: null }),
    room({ code: 'HIS123', categoryId: 'history' }),
  ];

  assert.deepEqual(
    filterAndSortRooms(rooms, { ...DEFAULT_ROOM_FILTERS, categoryId: 'all' }).map(({ code }) => code),
    ['ALL123'],
  );
});

test('목록 참가 동작은 공개방만 즉시 참가하고 비공개방은 비밀번호 입력을 요구한다', () => {
  assert.equal(roomListAction(room({ code: 'PUBLIC', isPublic: true })), 'join');
  assert.equal(roomListAction(room({ code: 'LOCKED', isPublic: false })), 'password');
  assert.equal(roomListAction(room({ code: 'FULLUP', capacity: 2, playerCount: 2 })), 'full');

  const joinedFull = room({ code: 'MYROOM', capacity: 2, playerCount: 2 });
  joinedFull.joined = true;
  assert.equal(roomListAction(joinedFull), 'enter');
});

test('검색은 대소문자와 앞뒤 공백을 무시하고 한글 방 제목도 찾는다', () => {
  const rooms = [
    room({ code: 'ABC123', name: '저녁 퀴즈' }),
    room({ code: 'DEF456', name: '점심 퀴즈' }),
  ];

  assert.deepEqual(
    filterAndSortRooms(rooms, { ...DEFAULT_ROOM_FILTERS, query: '  abc  ' }).map(({ code }) => code),
    ['ABC123'],
  );
  assert.deepEqual(
    filterAndSortRooms(rooms, { ...DEFAULT_ROOM_FILTERS, query: '저녁' }).map(({ code }) => code),
    ['ABC123'],
  );
});
