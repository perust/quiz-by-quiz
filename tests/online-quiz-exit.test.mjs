import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function dialogMarkup(html, id) {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `#${id} 가 있다`);
  return html.slice(start, html.indexOf('<div class="dialog-backdrop"', start + 1));
}

test('매치 중 «나가기»는 바로 떠나지 않고 인페이지 확인을 먼저 연다 (U32)', async () => {
  const [html, quiz] = await Promise.all([source('index.html'), source('src/ui/online-quiz.ts')]);
  const dialog = dialogMarkup(html, 'online-exit-dialog');

  // 로컬 #exit-dialog 와 같은 모양: <main> 밖의 dialog-backdrop, aria-modal, 취소가 먼저
  assert.ok(html.indexOf('id="online-exit-dialog"') > html.indexOf('</main>'));
  assert.match(dialog, /class="dialog" role="dialog" aria-modal="true" aria-labelledby="online-exit-dialog-title"/);
  assert.match(dialog, /id="online-exit-dialog-title">매치를 떠날까요\?</);
  assert.match(dialog, /목록의 「들어가기」로 다시 돌아올 수 있어요\./);
  assert.ok(dialog.indexOf('id="online-exit-cancel"') < dialog.indexOf('id="online-exit-confirm"'));
  assert.match(dialog, /class="button button--danger" id="online-exit-confirm">나가기</);

  assert.doesNotMatch(quiz, /el\.exit\.addEventListener\('click', onExit\)/);
  assert.match(quiz, /el\.exit\.addEventListener\('click', openExitDialog\);/);
  assert.match(quiz, /function confirmExit\(\): void \{[\s\S]*onExit\(\);/);
  const code = quiz.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /window\.confirm|\bconfirm\(/);
});

test('매치 나가기 확인은 포커스를 가두고 Esc로 닫으며 연 자리로 포커스를 돌려준다', async () => {
  const quiz = await source('src/ui/online-quiz.ts');

  assert.match(
    quiz,
    /function openExitDialog\(\): void \{[\s\S]*exitDialogOpener = [\s\S]*el\.exitDialog\.hidden = false;\s*el\.exitCancel\.focus\(\);/,
  );
  assert.match(
    quiz,
    /function closeExitDialog\(\): void \{[\s\S]*el\.exitDialog\.hidden = true;[\s\S]*exitDialogOpener\.focus\(\);/,
  );
  // 열려 있는 동안에는 그 안이 전부다. 숫자키·채팅 `/`·이동이 뒤로 새지 않는다.
  assert.match(
    quiz,
    /if \(!el\.exitDialog\.hidden\) \{\s*if \(event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*closeExitDialog\(\);\s*\} else if \(event\.key === 'Tab'\) \{\s*trapFocus\(el\.exitDialog, event\);\s*\}\s*return;\s*\}\s*if \(arena\.handleDialogKey\(event\)\) return;/,
  );
  // 새 문제가 와도 다이얼로그 밖으로 포커스를 빼지 않는다.
  assert.match(
    quiz,
    /shouldAutoFocusOnlineQuestion\(\s*arena\.isDialogOpen\(\) \|\| !el\.exitDialog\.hidden,/,
  );
  // 매치가 끝나거나 화면을 떠나면 열린 확인을 닫는다 — <main> 밖이라 다음 화면 위에 남는다.
  assert.match(quiz, /function stopPresence\(\)[\s\S]*el\.exitDialog\.hidden = true;/);
});

test('온라인 조작법은 지금의 제출 규칙과 순위 규칙을 말한다 (U13)', async () => {
  const html = await source('index.html');
  const dialog = dialogMarkup(html, 'online-help-dialog');
  const text = dialog.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');

  assert.match(text, /칸 위에 서 있기만 하면 제출되지 않아요\./);
  assert.match(text, /선택 버튼이나 Enter · Space를 눌러야 제출돼요\./);
  assert.match(text, /바닥 칸이나 위의 보기를 직접 눌러도 바로 제출돼요\./);
  assert.match(text, /순위는 맞힌 개수로만 정해요\. 빨리 답해도 점수는 같아요\./);
  assert.doesNotMatch(text, /서버/);
});

test('온라인 매치 문구는 «서버» 대신 플레이어의 말로 안내한다 (U40)', async () => {
  const { onlineQuizView } = await import('../js/ui/online-quiz.js');
  const [html, app] = await Promise.all([source('index.html'), source('src/app.ts')]);
  const base = {
    matchId: '12345678-1234-5678-9234-567812345678', categoryId: 'history', gameMode: true,
    currentPosition: 1, totalQuestions: 10, deadlineAt: '2026-09-18T11:00:20+00:00',
    question: {
      id: 'history-001', categoryId: 'history', question: '문제',
      choices: ['가', '나', '다', '라'], position: 1, total: 10,
    },
  };
  const running = { ...base, state: 'running', ownSubmission: null, reveal: null, scores: [] };
  const submitted = { ...running, ownSubmission: { position: 1, choiceIndex: 0, timedOut: false } };
  const finished = {
    ...base, state: 'finished', deadlineAt: null, question: null, ownSubmission: null, reveal: null, scores: [],
  };

  for (const snapshot of [running, submitted, finished]) {
    assert.doesNotMatch(onlineQuizView(snapshot).status, /서버/);
  }
  assert.equal(onlineQuizView(running).status, '칸 위에서 선택을 누르거나 보기를 눌러야 제출돼요.');
  assert.equal(onlineQuizView(submitted).status, '제출 완료! 다른 친구를 기다리는 중이에요.');

  const onlineQuiz = html.slice(
    html.indexOf('data-screen="online-quiz"'),
    html.indexOf('<!-- ─────────── 내 캐릭터'),
  ).replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(onlineQuiz, /서버/);
  assert.match(onlineQuiz, /id="online-final-ranking" aria-label="최종 순위"/);
  assert.match(app, /void openOnline\('매치는 계속 진행돼요\. 목록의 「들어가기」로 다시 돌아올 수 있어요\.'\);/);
});

test('정답 공개 때 상태 줄은 공개 카드와 같은 말을 겹쳐 낭독하지 않는다 (N09)', async () => {
  const { onlineQuizView } = await import('../js/ui/online-quiz.js');
  const [quiz, css] = await Promise.all([source('src/ui/online-quiz.ts'), source('css/style.css')]);
  const revealing = onlineQuizView({
    matchId: '12345678-1234-5678-9234-567812345678', state: 'revealing', categoryId: 'history',
    gameMode: true, currentPosition: 1, totalQuestions: 10, deadlineAt: '2026-09-18T11:00:20+00:00',
    question: {
      id: 'history-001', categoryId: 'history', question: '문제',
      choices: ['가', '나', '다', '라'], position: 1, total: 10,
    },
    ownSubmission: null,
    reveal: { position: 1, choiceIndex: 0, timedOut: false, correct: true, answerIndex: 0, explanation: '해설' },
    scores: [],
  });

  assert.equal(revealing.status, '');
  assert.doesNotMatch(quiz, /결과를 공개했습니다/);
  // 빈 상태 줄은 자리도 차지하지 않는다
  assert.match(css, /\.online-match-status:empty\s*\{\s*display: none;/);
});
