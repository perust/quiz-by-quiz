import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('stale waiting recovery cannot replace a newer match or navigation intent', async () => {
  const { isCurrentWaitingRoomEntry } = await import('../js/online/match-recovery.js');
  const stable = {
    code: 'ABC234',
    activeRoomCode: 'ABC234',
    onlineMatchRoomCode: null,
    entryGeneration: 7,
    currentGeneration: 7,
  };

  assert.equal(isCurrentWaitingRoomEntry(stable), true);
  assert.equal(isCurrentWaitingRoomEntry({ ...stable, onlineMatchRoomCode: 'ABC234' }), false);
  assert.equal(isCurrentWaitingRoomEntry({ ...stable, currentGeneration: 8 }), false);
  assert.equal(isCurrentWaitingRoomEntry({ ...stable, activeRoomCode: 'XYZ789' }), false);
});

test('openWaitingRoom rechecks entry ownership after each await before it routes to waiting', async () => {
  const app = await source('../src/app.ts');
  const entry = between(app, '  async function openWaitingRoom(code: string)', '  // ── 내 캐릭터');
  const home = between(app, '  async function goHome(): Promise<void>', '  // ── 퀴즈');

  assert.match(entry, /const entryGeneration = invalidateWaitingRoomEntry\(\);/);
  assert.match(
    entry,
    /await waitingRoom\.show\(code, characterId, entryGeneration\);[\s\S]*?if \(!isCurrentWaitingRoomEntry\(\{[\s\S]*?entryGeneration,[\s\S]*?currentGeneration: waitingRoomEntryGeneration,[\s\S]*?\}\)\) return;/,
  );
  assert.match(
    entry,
    /const recovered = await resumeActiveNetworkMatch\(code, entryGeneration\);[\s\S]*?if \(recovered \|\| !isCurrentWaitingRoomEntry\(\{[\s\S]*?entryGeneration,[\s\S]*?currentGeneration: waitingRoomEntryGeneration,[\s\S]*?\}\)\) return;[\s\S]*?goTo\('waiting'\);/,
  );
  assert.match(
    home,
    /const navigationGeneration = invalidateWaitingRoomEntry\(\);[\s\S]*?if \(!isCurrentNavigation\(navigationGeneration\)\) return;[\s\S]*?goTo\('home'\);/,
  );
});

test('awaited screen openings commit only while their navigation request is newest', async () => {
  const app = await source('../src/app.ts');
  const navigation = between(app, '  function invalidateWaitingRoomEntry', '  /** start event');
  const startRound = between(app, '  async function startRound(', '  function labelFor(');
  const showResult = between(app, '  async function showResult(', '  /**\n   * 랭킹 등록');
  const ranking = between(app, '  async function openRanking(', '  // ── 온라인');
  const online = between(app, '  async function openOnline(', '  async function openWaitingRoom');

  assert.match(navigation, /function invalidateWaitingRoomEntry\(\): number/);
  assert.match(navigation, /function isCurrentNavigation\(generation: number\): boolean/);
  for (const block of [startRound, showResult, ranking, online]) {
    assert.match(block, /const navigationGeneration = invalidateWaitingRoomEntry\(\);/);
    assert.match(block, /if \(!isCurrentNavigation\(navigationGeneration\)\) return;/);
  }

  // Old-first may commit before a newer request exists. Once the newer request starts,
  // the old continuation must fail; the later request remains the sole owner.
  let currentGeneration = 0;
  const oldRequest = ++currentGeneration;
  const newerRequest = ++currentGeneration;
  assert.notEqual(oldRequest, currentGeneration);
  assert.equal(newerRequest, currentGeneration);
});

test('waiting-room events keep the immutable entry generation captured by their show request', async () => {
  const app = await source('../src/app.ts');
  const waitingRoom = await source('../src/ui/waiting-room.ts');
  const recovery = between(
    app,
    '  async function resumeActiveNetworkMatch',
    '  /**\n   * 화면을 옮긴다.',
  );
  const entry = between(app, '  async function openWaitingRoom(code: string)', '  // ── 내 캐릭터');
  const callbacks = between(
    app,
    '  const waitingRoom = createWaitingRoom({',
    '  const charactersScreen = createCharactersScreen({',
  );

  assert.match(
    recovery,
    /resumeActiveNetworkMatch\(code: string, entryGeneration: number\)/,
  );
  assert.match(
    recovery,
    /isStillCurrent: \(\) => isCurrentWaitingRoomEntry\(\{\s*code,\s*activeRoomCode,\s*onlineMatchRoomCode,\s*entryGeneration,\s*currentGeneration: waitingRoomEntryGeneration,\s*\}\)/,
  );
  assert.match(
    waitingRoom,
    /show\(code: string, characterId: string, entryGeneration: number\): Promise<void>/,
  );
  assert.match(
    waitingRoom,
    /roomStore\.subscribe\(code, \(event\) => \{\s*if \(showGuard\.isCurrent\(request\)\) onEvent\(event, \{ code, entryGeneration \}\);\s*\}\)/,
  );
  assert.match(
    callbacks,
    /onStart: \(code, \{ categoryId \}, entryGeneration\) => \{[\s\S]*?isCurrentWaitingRoomEntry\(\{[\s\S]*?entryGeneration,[\s\S]*?currentGeneration: waitingRoomEntryGeneration/,
  );
  assert.match(
    callbacks,
    /onMatchInvalidated: \(code, entryGeneration\) => \{\s*void resumeActiveNetworkMatch\(code, entryGeneration\);\s*\}/,
  );
  assert.match(
    callbacks,
    /onLeave: \(code, entryGeneration, reason\) => \{[\s\S]*?isCurrentWaitingRoomEntry\(\{[\s\S]*?entryGeneration,[\s\S]*?currentGeneration: waitingRoomEntryGeneration/,
  );
  assert.doesNotMatch(
    callbacks,
    /resumeActiveNetworkMatch\(code, waitingRoomEntryGeneration\)/,
  );
  assert.match(entry, /await waitingRoom\.show\(code, characterId, entryGeneration\);/);
  assert.match(entry, /resumeActiveNetworkMatch\(code, entryGeneration\)/);
});

test('a delayed local started event rechecks its immutable entry before opening the quiz', async () => {
  const { isCurrentWaitingRoomEntry } = await import('../js/online/match-recovery.js');
  const app = await source('../src/app.ts');
  const startHandler = between(app, '    onStart:', '    onMatchInvalidated:');
  const startRound = between(app, '  async function startRound(', '  function labelFor(');

  assert.match(startHandler, /const ownsStartedEntry = \(\) => isCurrentWaitingRoomEntry\(/);
  assert.match(startHandler, /void startRound\([\s\S]*?,\s*ownsStartedEntry,?\s*\);/);
  assert.match(startRound, /ownsEntry\?: \(\) => boolean/);
  assert.match(startRound, /if \(ownsEntry && !ownsEntry\(\)\) return;/);
  assert.match(startRound, /const navigationGeneration = invalidateWaitingRoomEntry\(\);/);
  assert.match(startRound, /if \(ownsEntry\) waitingRoom\.hide\(\);/);
  assert.ok(
    startRound.indexOf('waitingRoom.hide();')
      < startRound.indexOf('await preferences.setRecentQuestionIds'),
  );
  assert.ok(
    startRound.indexOf('await preferences.setRecentQuestionIds(nextRecentQuestionIds);')
      < startRound.indexOf('if (!isCurrentNavigation(navigationGeneration)) return;'),
  );

  let currentGeneration = 7;
  const ownsStartedEntry = () => isCurrentWaitingRoomEntry({
    code: 'ABC234',
    activeRoomCode: 'ABC234',
    onlineMatchRoomCode: null,
    entryGeneration: 7,
    currentGeneration,
  });
  assert.equal(ownsStartedEntry(), true);
  currentGeneration += 1;
  assert.equal(ownsStartedEntry(), false);
});

test('an empty local room round restores an actionable home screen before returning', async () => {
  const app = await source('../src/app.ts');
  const startRound = between(app, '  async function startRound(', '  function labelFor(');
  const emptyRound = between(
    startRound,
    '    if (questions.length === 0) {',
    '    // 이번 판에 낸 문제는',
  );

  assert.doesNotMatch(emptyRound, /gameMode|restoreMyGameMode/);
  assert.match(emptyRound, /homeScreen\.setNote\('이 카테고리에는 출제할 문제가 없습니다\.'\);/);
  assert.match(emptyRound, /goTo\('home'\);/);
  assert.ok(emptyRound.indexOf("goTo('home');") < emptyRound.indexOf('return;'));
});

test('recent-question persistence failure is best effort after waiting-room ownership transfer', async () => {
  const app = await source('../src/app.ts');
  const startRound = between(app, '  async function startRound(', '  function labelFor(');

  assert.match(
    startRound,
    /try \{\s*await preferences\.setRecentQuestionIds\(nextRecentQuestionIds\);\s*\} catch \{[\s\S]*?\}\s*if \(!isCurrentNavigation\(navigationGeneration\)\) return;/,
  );
});

test('online match callbacks retain navigation ownership and waiting-room transfer closes them', async () => {
  const app = await source('../src/app.ts');
  const callbacks = between(
    app,
    '  onlineMatchController = createOnlineMatchController({',
    '  /** finished ranking',
  );
  const lifecycle = between(app, '  function stopOnlineMatch()', '  /**\n   * 대기실 socket');
  const waiting = between(app, '  async function openWaitingRoom(code: string)', '  // ── 내 캐릭터');

  assert.match(callbacks, /onSnapshot: \(snapshot\) => \{\s*if \(!ownsOnlineMatchNavigation\(\)\) return;/);
  assert.doesNotMatch(callbacks, /goTo\('online-quiz'\)/);
  assert.doesNotMatch(callbacks, /onlineMatchNavigationGeneration = waitingRoomEntryGeneration/);
  assert.match(callbacks, /onMissing: \(\) => \{\s*if \(!ownsOnlineMatchNavigation\(\)\) return;/);
  assert.match(callbacks, /onError: \(message\) => \{\s*if \(ownsOnlineMatchNavigation\(\)\)/);
  assert.match(lifecycle, /onlineMatchNavigationGeneration = null;/);
  assert.match(
    lifecycle,
    /goTo\('online-quiz'\);\s*onlineMatchNavigationGeneration = waitingRoomEntryGeneration;\s*await onlineMatchController\?\.open\(code\);/,
  );
  assert.match(waiting, /if \(onlineMatchRoomCode\) stopOnlineMatch\(\);/);
  assert.doesNotMatch(waiting, /onlineMatchRoomCode !== code/);
});
