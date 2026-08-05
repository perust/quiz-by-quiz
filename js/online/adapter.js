// 방 저장소 어댑터
//
// **교체 지점은 아래 한 줄이다.** 랭킹 저장소(`storage/adapter.js`)와 같은 방식으로,
// 서버가 생기면 `serverRooms`를 만들어 여기만 바꾼다. 화면(`ui/online.js`)은
// 인터페이스만 알고 구현을 모르므로 그대로 돈다.
//
// 인터페이스
//   isNetworked            진짜 네트워크인가 (화면이 안내 문구를 정할 때 쓴다)
//   me()                   지금 나를 가리키는 값
//   listRooms()            공개방 목록
//   myRooms()              내가 들어가 있는 방
//   createRoom(spec)       {ok, room} | {ok:false, message}
//   joinRoom(spec)         {ok, room} | {ok:false, reason}
//   leaveRoom(spec)
//
// **로컬 구현이 동기여도 모든 메서드는 Promise를 반환한다.** 서버 구현으로
// 바뀔 때 부르는 쪽을 고치지 않기 위해서다.
//
// **비밀번호는 구현체 안에서만 견준다.** 목록에는 잠김 여부만 나가고, 화면은
// 비밀번호가 맞는지 모른 채 넘기기만 한다.

import { localRooms } from './local-rooms.js';

export const roomStore = localRooms;
