// ★ 이 프로젝트에서 window.localStorage를 직접 만지는 유일한 파일이다.
//
// 랭킹(`storage/local-store.js`)과 온라인 방(`online/local-rooms.js`)이 둘 다
// 여기를 거친다. 한때 저마다 `localStorage`를 불렀는데, **대비가 한쪽에만 있었다** —
// 랭킹은 못 쓰는 환경에서 메모리로 넘어갔지만 방은 조용히 실패해서, 저장이 막힌
// 브라우저에서는 「만들기」를 눌러도 아무 일이 없었다(안내조차 없었다).
//
// core/ 나 ui/ 에서 부르면 설계 위반이다. 저장이 필요하면 어댑터를 통한다.

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

/**
 * 실제 저장소이거나, 못 쓰면 메모리 대체품.
 *
 * **모듈이 처음 불릴 때 한 번만 정한다.** 조회할 때마다 확인하면 사파리에서
 * 매번 예외를 던지게 되고, 경고도 그만큼 쌓인다.
 */
export const safeStorage = resolveStorage();

/**
 * 이 저장소가 새로고침 뒤에도 남는가.
 *
 * 화면이 «저장되지 않는다»고 알려야 할 때 쓴다. 되지 않는 것을 되는 척하지 않는다 —
 * 방을 만들었는데 다음 새로고침에 사라지는 편이, 미리 알려 주는 것보다 나쁘다.
 */
export const isPersistent = safeStorage === window.localStorage;
