import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8');
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}

test('a newer waiting-room fetch owns room/subscription commit when an older fetch resolves last', async () => {
  const { createLatestRequestGuard } = await import('../js/ui/latest-request.js');
  const guard = createLatestRequestGuard();
  const first = deferred();
  const second = deferred();
  const pending = new Map([['AAA111', first], ['BBB222', second]]);
  const subscriptions = [];
  const leaves = [];
  let room = null;
  let unsubscribe = null;

  async function show(code) {
    const request = guard.begin();
    unsubscribe?.();
    unsubscribe = null;
    room = null;
    const loadedRoom = await pending.get(code).promise;
    if (!guard.isCurrent(request)) return;
    room = loadedRoom;
    if (!room) {
      leaves.push(code);
      return;
    }
    subscriptions.push(code);
    unsubscribe = () => subscriptions.push(`unsub:${code}`);
  }

  const older = show('AAA111');
  const newer = show('BBB222');
  second.resolve({ code: 'BBB222' });
  await newer;
  first.resolve(null);
  await older;

  assert.deepEqual(room, { code: 'BBB222' });
  assert.deepEqual(subscriptions, ['BBB222']);
  assert.deepEqual(leaves, []);
});

test('invalidating a pending waiting-room fetch suppresses its later commit', async () => {
  const { createLatestRequestGuard } = await import('../js/ui/latest-request.js');
  const guard = createLatestRequestGuard();
  const request = guard.begin();
  guard.invalidate();
  assert.equal(guard.isCurrent(request), false);
});

test('WaitingRoom.show clears prior ownership before fetch and checks it before every side effect', async () => {
  const waiting = await source('../src/ui/waiting-room.ts');
  const show = between(waiting, '    async show(code, characterId, entryGeneration) {', '    hide() {');
  const hide = between(waiting, '    hide() {', '    },\n  };');
  const uncommentedShow = show.replace(/\/\/.*$/gm, '');

  assert.match(waiting, /import \{ createLatestRequestGuard \} from '\.\/latest-request\.js';/);
  assert.match(waiting, /const showGuard = createLatestRequestGuard\(\);/);
  const begin = show.indexOf('const request = showGuard.begin();');
  const clearEntry = show.indexOf('visibleEntry = null;');
  const unsubscribe = show.indexOf('unsubscribe?.();');
  const clearRoom = show.indexOf('room = null;');
  const fetchRoom = show.indexOf('await roomStore.getRoom(code)');
  assert.ok(begin < clearEntry && clearEntry < unsubscribe && unsubscribe < clearRoom);
  assert.ok(clearRoom < fetchRoom, 'previous room ownership must be cleared before fetch');
  assert.ok(
    show.indexOf('remoteBubbles.reset();') < show.indexOf('await roomStore.getRoom(code)'),
    'previous-room bubbles must be reset before the new room fetch',
  );
  assert.match(
    uncommentedShow,
    /const loadedRoom = await roomStore\.getRoom\(code\);\s*if \(!showGuard\.isCurrent\(request\)\) return;\s*room = loadedRoom;/,
  );
  assert.match(
    show,
    /if \(!room\) \{[\s\S]*?onLeave\(code, entryGeneration, '그 방은 이미 사라졌어요\. 마지막 사람이 나가면 방이 지워집니다\.'\);[\s\S]*?return;\s*\}[\s\S]*?visibleEntry = nextEntry;[\s\S]*?unsubscribe = roomStore\.subscribe\(code, \(event\) => \{\s*if \(showGuard\.isCurrent\(request\)\) onEvent\(event, \{ code, entryGeneration \}\);\s*\}\);/,
  );
  assert.match(hide, /hide\(\) \{\s*showGuard\.invalidate\(\);\s*visibleRequest = null;\s*visibleEntry = null;\s*unsubscribe\?\.\(\);/);
});
