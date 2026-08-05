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
//   getRoom(code)          방 하나
//   updateRoom(spec)       방 설정 (방장만)
//   sendChat(spec)         한마디
//   startGame(spec)        판 열기 (방장만)
//   subscribe(code, fn)    방에서 일어나는 일. 그만 들으려면 되돌려 준 함수를 부른다
//
// 구독으로 오는 이벤트
//   {type: 'room',  room}                     방 설정이 바뀌었다
//   {type: 'chat',  playerId, nickname, text} 누가 한마디 했다
//   {type: 'match', phase: 'started', setup}  판이 열렸다
//
// **여는 사람이 판을 직접 시작하지 않는다.** `startGame`은 «시작됐다»는 이벤트를
// 보낼 뿐이고 화면은 그 이벤트를 보고 움직인다. 서버 구현에서는 같은 이벤트가 방에
// 있는 모두에게 가므로, 부르는 쪽을 고치지 않고 여럿이 함께 시작하는 판이 된다.
//
// **아직 없는 자리 — 여럿이 같은 문제를 푸는 판.**
// 여기에 `submitAnswer(spec)`와 `{type: 'match', phase: 'question' | 'reveal' | 'over'}`
// 가 들어간다. 진행 규칙(언제 다음 문항으로 넘길지, 점수를 어떻게 합칠지)은 그때
// `core/`에 순수 함수로 둔다 — 서버와 화면이 같은 규칙을 써야 하기 때문이다.
// **지금 미리 짓지 않는다.** 쓸 화면이 없으면 맞는지 확인할 길도 없다.
//
// **로컬 구현이 동기여도 모든 메서드는 Promise를 반환한다.** 서버 구현으로
// 바뀔 때 부르는 쪽을 고치지 않기 위해서다.
//
// **비밀번호는 구현체 안에서만 견준다.** 목록에는 잠김 여부만 나가고, 화면은
// 비밀번호가 맞는지 모른 채 넘기기만 한다.

import { localRooms } from './local-rooms.js';

export const roomStore = localRooms;
