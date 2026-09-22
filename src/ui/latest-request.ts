// 가장 늦게 시작한 비동기 화면 요청만 상태를 바꾸게 하는 작은 소유권 장치.
//
// 취소할 수 없는 fetch라도, 응답이 돌아왔을 때 아직 이 화면 요청의 것인지
// 확인하면 오래된 응답이 새 화면·구독·오류 메시지를 덮지 못한다.

export interface LatestRequestGuard {
  begin(): number;
  invalidate(): void;
  isCurrent(request: number): boolean;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let current = 0;

  return {
    begin() {
      current += 1;
      return current;
    },

    invalidate() {
      current += 1;
    },

    isCurrent(request) {
      return request === current;
    },
  };
}
