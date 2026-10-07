import test from 'node:test';
import assert from 'node:assert/strict';

// 워커 모듈은 불러오는 순간 document·window 에 리스너를 단다. 그 전에 필요한 만큼만
// 흉내 낸다. 각 테스트 파일은 따로 된 프로세스에서 돌아 다른 테스트로 새지 않는다.
function fakeElement(tag = 'div') {
  const classes = new Set();
  return {
    tagName: tag.toUpperCase(),
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    append() {},
    querySelector: () => null,
    addEventListener() {},
    offsetWidth: 40,
    offsetHeight: 48,
  };
}

const frames = [];
globalThis.window = { innerWidth: 390, innerHeight: 844, scrollY: 0, addEventListener() {}, scrollBy() {} };
globalThis.document = {
  body: {},
  activeElement: null,
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  createElement: (tag) => fakeElement(tag),
  elementFromPoint: () => null,
};
globalThis.requestAnimationFrame = (callback) => frames.push(callback);
globalThis.cancelAnimationFrame = () => {};

const { createScreenWalker } = await import('../js/ui/screen-walker.js');
const { resultWalkerStart } = await import('../js/ui/result.js');

/** 쌓인 프레임을 최대 n 번까지 돌린다. 끝없이 다시 예약하는 루프도 여기서 멈춘다 */
function runFrames(limit = 12) {
  for (let i = 0; i < limit && frames.length; i += 1) frames.shift()(performance.now());
}

function placedAt(character) {
  return character.style.transform ?? null;
}

test('화면 워커: 시작 자리를 정하지 않은 화면은 화면 한가운데에 서고 루프를 멈춘다', () => {
  frames.length = 0;
  const character = fakeElement();
  const walker = createScreenWalker({ screen: { hidden: false }, character });

  walker.show('slime-blue');
  runFrames();

  // 시작점이 «아직 잴 수 없음»(null)으로만 답하면 영영 세워지지 않아 캐릭터가 좌상단에
  // 박히고, 세우려는 프레임이 매번 다시 예약되어 서 있는 동안에도 배터리를 쓴다.
  // 결과 화면이 그랬다 — 지금은 결과 화면도 제 시작 자리를 정해 두었다
  // (tools/check-screens.js 가 그 자리가 버튼 위가 아닌지 본다)
  assert.equal(placedAt(character), 'translate(195px, 422px) translate(-50%, -100%)');
  assert.equal(frames.length, 0, '서 있는 캐릭터는 프레임을 계속 돌리지 않는다');
  walker.hide();
});

test('결과 화면 워커는 점수·통계 글자를 가리지 않는 헤더 왼쪽 위 빈 곳에서 시작한다', () => {
  const header = {
    getBoundingClientRect: () => ({ left: 11, top: 52, width: 275 }),
  };
  const character = { offsetWidth: 40, offsetHeight: 48 };

  assert.deepEqual(resultWalkerStart(header, character), { x: 43, y: 112 });

  const hiddenHeader = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0 }),
  };
  assert.equal(resultWalkerStart(hiddenHeader, character), null);
});

test('화면 워커: 시작 버튼이나 자리를 정한 화면은 그대로 그 곁에서 시작한다', () => {
  frames.length = 0;
  const button = { getBoundingClientRect: () => ({ left: 100, width: 80, bottom: 200 }) };
  const ranking = fakeElement();
  const rankingWalker = createScreenWalker({ screen: { hidden: false }, character: ranking, startAt: () => button });
  rankingWalker.show('slime-blue');
  runFrames();
  assert.equal(placedAt(ranking), 'translate(140px, 230px) translate(-50%, -100%)');
  rankingWalker.hide();

  // 아직 잴 수 없다(null)고 답하는 동안은 기다렸다가 잴 수 있게 되면 그 자리에 선다
  frames.length = 0;
  let calls = 0;
  const lounge = fakeElement();
  const loungeWalker = createScreenWalker({
    screen: { hidden: false },
    character: lounge,
    startPoint: () => (++calls < 3 ? null : { x: 60, y: 500 }),
  });
  loungeWalker.show('slime-blue');
  runFrames();
  assert.equal(placedAt(lounge), 'translate(60px, 500px) translate(-50%, -100%)');
  loungeWalker.hide();
});
