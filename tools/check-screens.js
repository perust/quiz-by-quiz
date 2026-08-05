// 화면을 옮긴 뒤 «아무것도 새지 않는가»를 브라우저에서 한 번에 확인한다.
//
// 쓰는 법 — 앱을 띄운 탭의 개발자 도구 콘솔에 이 파일을 통째로 붙여넣는다.
//
//   npm run build && python3 -m http.server 8765
//   → http://localhost:8765 를 열고 콘솔에 붙여넣기
//
// **이 프로젝트에는 테스트 러너가 없다(의도적).** 그래서 «한 번 물렸던 것»만
// 골라 검사한다. 새 기능을 덮는 것이 목적이 아니라, 같은 데를 두 번 물리지 않는
// 것이 목적이다. 여기 있는 검사는 모두 실제로 났던 버그에서 왔다.
//
//   ① 화면을 옮겼는데 퀴즈 세션이 살아남아, 로비에서 방 이름을 적는 중에
//      「시간 초과입니다」가 떴다 (#64)
//   ② 결과 화면의 손가락 조작부(스틱·확정 버튼)가 다음 화면까지 따라와
//      「다음 문제」를 가렸다 (#65)
//   ③ 조작법 대화상자를 열어 둔 채 나가면 홈 화면 위에 남았다
//   ④ 피드백 시트는 <main> 밖에 있어 어느 화면에서든 보인다
//   ⑤ 다이얼로그를 닫으면 포커스가 그 버튼으로 돌아오는데, 그대로 두면 캐릭터를
//      옮겨 Enter 를 눌러도 포커스에 남은 버튼이 눌렸다 (#67)
//   ⑥ **키의 임자 다툼.** 워커·버튼·입력칸이 같은 키를 노린다. 한쪽을 고치면
//      다른 쪽이 깨지는 일이 되풀이됐다 — 입력칸을 밟게 하자 체크박스 Space 가
//      죽었고(#58), 포커스를 비켜 주게 하자 걸어가서 고르는 것이 막혔다(#67).
//      그래서 넷을 한자리에서 함께 본다.
//
// **localStorage 의 방 목록을 건드린다.** 시작할 때 백업하고 끝나면 되돌린다.
// 랭킹·설정·닉네임은 만지지 않는다.

(async () => {
  const 결과 = [];
  const 살펴본곳 = [];

  // ── 도구 ──────────────────────────────────────────────────────

  const 잠깐 = (ms) => new Promise((r) => setTimeout(r, ms));
  const 지금화면 = () =>
    [...document.querySelectorAll('.screen')].find((s) => !s.hidden)?.dataset.screen ?? '(없음)';
  const 눌러 = async (id, ms = 600) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`버튼이 없다: #${id}`);
    el.click();
    await 잠깐(ms);
  };

  /**
   * 숨은 탭에서는 rAF 가 멈춘다. 검사 중에 프레임을 직접 돌려야 타이머가 흐른다.
   * 그리고 `performance.now` 를 앞당겨 **20초를 기다리지 않고** 시간 초과를 일으킨다.
   */
  const 진짜now = performance.now.bind(performance);
  const 진짜raf = window.requestAnimationFrame.bind(window);
  const 진짜caf = window.cancelAnimationFrame.bind(window);
  let 시간밀기 = 0;
  const 대기열 = new Map();
  let 번호 = 0;

  performance.now = () => 진짜now() + 시간밀기;
  window.requestAnimationFrame = (cb) => { 대기열.set(++번호, cb); return 번호; };
  window.cancelAnimationFrame = (i) => { 대기열.delete(i); };
  const 프레임돌리기 = (n = 12) => {
    for (let i = 0; i < n; i += 1) {
      const 이번 = [...대기열];
      대기열.clear();
      for (const [, cb] of 이번) cb(performance.now());
    }
  };
  /**
   * 시간을 앞당겨 프레임을 돌린다. **되돌리는 것을 잊지 말 것** —
   * 앞당긴 채로 두면 그다음에 여는 판이 매 문항 즉시 시간 초과된다.
   * 그래서 `잠든퀴즈를깨워본다` 는 언제나 짝을 맞춰 되돌린다.
   */
  const 시간앞당기기 = (ms) => { 시간밀기 += ms; 프레임돌리기(); };
  const 시간되돌리기 = (ms) => { 시간밀기 -= ms; };

  const 되돌리기 = () => {
    performance.now = 진짜now;
    window.requestAnimationFrame = 진짜raf;
    window.cancelAnimationFrame = 진짜caf;
  };

  // ── 불변식 ────────────────────────────────────────────────────

  /**
   * 이 화면에 있을 때 참이어야 하는 것들.
   *
   * @param 화면 지금 있어야 할 화면 이름
   * @param 걷는가 이 화면에서 캐릭터가 걸어 다니는가.
   *   보통 모드 퀴즈에는 캐릭터가 없어 방향키를 아무도 받지 않는 것이 맞다.
   */
  function 살펴본다(자리, 화면, 걷는가) {
    const 본다 = (이름, 참인가, 무엇) => {
      결과.push({ 자리, 이름, 통과: Boolean(참인가), 무엇 });
    };

    본다('화면', 지금화면() === 화면, `${지금화면()} (바란 것: ${화면})`);

    // ④ 피드백 시트는 <main> 밖이라 어느 화면에서든 보인다
    본다('피드백 시트가 닫혀 있다', document.getElementById('feedback').hidden,
      document.getElementById('feedback-verdict').textContent || '(비어 있음)');

    // ③ 대화상자는 DOM 순서로 위에 와서 다음 화면을 덮는다
    const 열린것 = [...document.querySelectorAll('.dialog-backdrop')]
      .filter((d) => !d.hidden).map((d) => d.id);
    본다('열린 대화상자가 없다', 열린것.length === 0, 열린것.join(', ') || '없음');

    // ② 손가락 조작부는 걸어 다니는 화면의 것이어야 한다
    const 스틱 = document.getElementById('walk-stick')?.classList.contains('walk-stick--on');
    const 확정 = document.getElementById('walk-confirm')?.classList.contains('walk-confirm--on');
    본다('손가락 조작부가 화면과 맞는다', Boolean(스틱) === 걷는가 && Boolean(확정) === 걷는가,
      `스틱 ${스틱 ? '켜짐' : '꺼짐'} · 확정 ${확정 ? '켜짐' : '꺼짐'} (바란 것: ${걷는가 ? '켜짐' : '꺼짐'})`);

    // 방향키를 지금 화면의 캐릭터가 받는가. 아무도 안 받으면 브라우저 스크롤이 된다
    const 키 = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.dispatchEvent(키);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    본다('방향키의 임자가 맞는다', 키.defaultPrevented === 걷는가,
      키.defaultPrevented ? '캐릭터가 받는다' : '아무도 안 받는다');
  }

  /**
   * ① 여기서 시간이 흘러도 퀴즈가 깨어나지 않아야 한다.
   *
   * 화면을 옮길 때 세션과 타이머를 접지 않으면, 다른 화면에 있는 동안 시간 초과가
   * 나서 시트가 뜬다. 「다음 문제」를 눌러도 화면이 바뀌지 않고, 다음 문항의 타이머가
   * 또 돌아 같은 일이 되풀이된다.
   */
  function 잠든퀴즈를깨워본다(자리, 밀기 = 25000) {
    시간앞당기기(밀기);
    const 깨어났나 = !document.getElementById('feedback').hidden;
    결과.push({
      자리, 이름: `${밀기 / 1000}초가 흘러도 퀴즈가 깨어나지 않는다`, 통과: !깨어났나,
      무엇: 깨어났나 ? `!! ${document.getElementById('feedback-verdict').textContent}` : '조용하다',
    });
    // **밀어 둔 시간을 되돌린다.** 그대로 두면 다음에 여는 판이 시작하자마자
    // 시간 초과가 되어, 뒤에 오는 검사가 전부 엉뚱한 것을 보게 된다
    시간되돌리기(밀기);
  }

  // ── 검사 ──────────────────────────────────────────────────────

  const 방백업 = localStorage.getItem('quiz.rooms');
  console.log('%c화면 점검을 시작합니다', 'font-weight:bold');

  try {
    // 홈에서 시작한다. 어디에 있든 홈으로 갈 수 있어야 한다
    if (지금화면() === 'quiz') { await 눌러('quiz-exit', 300); await 눌러('exit-confirm'); }
    if (지금화면() === 'result') await 눌러('result-home');
    if (지금화면() === 'ranking') await 눌러('ranking-home');
    if (지금화면() === 'characters') await 눌러('characters-back');
    if (지금화면() === 'waiting') await 눌러('waiting-leave');
    if (지금화면() === 'online') await 눌러('online-home');
    살펴본다('홈', 'home', true);

    // ⑤ 다이얼로그를 닫으면 포커스가 열었던 버튼으로 돌아온다 — 키보드만 쓰는
    // 사람을 위한 규칙이다. 그 뒤 **캐릭터를 움직이면 포커스를 놓아야** 한다.
    // 놓지 않으면 걸어간 자리가 아니라 포커스에 남은 버튼이 눌린다.
    await 눌러('open-nickname', 400);
    document.getElementById('nickname-cancel').click();
    await 잠깐(400);
    const 되돌아온자리 = document.activeElement instanceof HTMLElement
      ? (document.activeElement.id || document.activeElement.tagName) : '(없음)';
    결과.push({
      자리: '홈', 이름: '다이얼로그를 닫으면 포커스가 돌아온다',
      통과: document.activeElement === document.getElementById('open-nickname'),
      무엇: 되돌아온자리,
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    결과.push({
      자리: '홈', 이름: '걷기 시작하면 포커스를 놓는다',
      통과: document.activeElement === document.body,
      무엇: document.activeElement === document.body ? '놓았다'
        : `!! ${document.activeElement.id || document.activeElement.tagName} 에 붙어 있다`,
    });
    프레임돌리기(2);

    살펴본곳.push('홈');

    // 홈 → 랭킹 → 홈
    await 눌러('open-ranking', 700);
    살펴본다('랭킹', 'ranking', true);
    잠든퀴즈를깨워본다('랭킹');
    await 눌러('ranking-home');
    살펴본곳.push('랭킹');

    // 홈 → 내 캐릭터 → 홈
    await 눌러('open-characters', 700);
    살펴본다('내 캐릭터', 'characters', true);
    await 눌러('characters-back');
    살펴본곳.push('내 캐릭터');

    // 퀴즈에 들어갔다가 **답을 낸 채로** 나온다. 시트와 세션이 함께 접혀야 한다
    document.querySelector('.category-card').click();
    await 잠깐(800);
    document.querySelector('.choice').click();
    await 잠깐(400);
    결과.push({
      자리: '퀴즈', 이름: '답을 내면 시트가 뜬다',
      통과: !document.getElementById('feedback').hidden, 무엇: '준비된 상태를 만든다',
    });
    await 눌러('quiz-exit', 300);
    await 눌러('exit-confirm', 700);
    살펴본다('답을 낸 채 나온 홈', 'home', true);
    잠든퀴즈를깨워본다('답을 낸 채 나온 홈');
    살펴본곳.push('퀴즈에서 나오기');

    // 퀴즈를 끝까지 풀어 결과로 간 뒤, 「다시 하기」로 되돌아온다.
    // 결과 화면의 조작부가 따라오면 여기서 걸린다 (#65)
    document.querySelector('.category-card').click();
    await 잠깐(800);
    for (let i = 0; i < 40 && 지금화면() === 'quiz'; i += 1) {
      const 보기 = [...document.querySelectorAll('.choice')].find((b) => !b.disabled);
      if (보기) 보기.click();
      await 잠깐(120);
      const 다음 = document.getElementById('next-button');
      if (다음 && !다음.hidden) 다음.click();
      await 잠깐(150);
    }
    살펴본다('결과', 'result', true);
    await 눌러('result-retry', 800);
    // 앱 바가 보통 모드이면 퀴즈에는 캐릭터가 없다
    const 게임모드 = document.getElementById('game-mode-label').textContent === '게임 모드';
    살펴본다('「다시 하기」로 돌아온 퀴즈', 'quiz', 게임모드);
    await 눌러('quiz-exit', 300);
    await 눌러('exit-confirm', 700);
    살펴본곳.push('결과 → 다시 하기');

    // 로비와 대기실. 방을 하나 만들어 오간다
    await 눌러('open-online', 700);
    살펴본다('로비', 'online', true);
    잠든퀴즈를깨워본다('로비');

    // ⑥ 키의 임자. 넷이 함께 서야 한다 — 하나를 고치면 다른 셋이 깨지곤 했다
    const 키를보낸다 = (키, 옵션 = {}) => {
      const 이벤트 = new KeyboardEvent('keydown', { key: 키, bubbles: true, cancelable: true, ...옵션 });
      document.dispatchEvent(이벤트);
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 키, bubbles: true }));
      return 이벤트.defaultPrevented;
    };

    // 체크박스에서 Space 는 체크박스 것이다. 워커가 가로채면 preventDefault 가
    // 기본 동작까지 죽여 키보드만 쓰는 사람은 「비공개로 만들기」를 켤 수 없다
    const 체크박스 = document.getElementById('create-private');
    체크박스.focus();
    const 스페이스를가로챘나 = 키를보낸다(' ');
    결과.push({
      자리: '로비', 이름: '체크박스의 Space 를 워커가 가로채지 않는다',
      통과: !스페이스를가로챘나,
      무엇: 스페이스를가로챘나 ? '!! 워커가 가로챈다' : '체크박스 것이다',
    });

    // Tab 으로 버튼에 간 사람의 Enter 는 그 버튼 것이다
    document.getElementById('online-home').focus();
    결과.push({
      자리: '로비', 이름: 'Tab 으로 간 버튼의 Enter 를 워커가 가로채지 않는다',
      통과: !키를보낸다('Enter'), 무엇: document.activeElement.id,
    });

    // 글자를 적는 중이면 방향키는 커서 것이다. 캐릭터가 같이 걸어가면 안 된다
    const 코드칸 = document.getElementById('join-code');
    코드칸.focus();
    코드칸.value = 'ABCD';
    키를보낸다('ArrowDown');
    결과.push({
      자리: '로비', 이름: '입력칸에서는 방향키가 커서 것이다',
      통과: document.activeElement === 코드칸 && 코드칸.value === 'ABCD',
      무엇: `커서 ${document.activeElement.id || '(잃음)'} · 적은 값 ${코드칸.value || '(지워짐)'}`,
    });

    // 들어갔으면 나올 길이 있어야 한다. Esc 는 화면 쪽으로 새지 않는다 —
    // 로비의 Esc 는 «홈으로»라, 새면 적던 것이 통째로 날아간다
    키를보낸다('Escape');
    결과.push({
      자리: '로비', 이름: 'Esc 로 입력칸에서 나오고 화면은 그대로다',
      통과: document.activeElement !== 코드칸 && 지금화면() === 'online' && 코드칸.value === 'ABCD',
      무엇: `화면 ${지금화면()} · 적은 값 ${코드칸.value || '(지워짐)'}`,
    });
    코드칸.value = '';

    const 이름칸 = document.getElementById('create-name');
    이름칸.value = '점검용 방';
    document.getElementById('create-form').requestSubmit();
    await 잠깐(800);
    살펴본다('대기실', 'waiting', true);

    // **「게임 시작」 직후에 나간다.** 판을 여는 것은 되돌아온 이벤트를 보고
    // 하는 일이라 비동기다. 그 사이에 나가면 세션만 남을 수 있다 (#64)
    document.getElementById('waiting-start').click();
    document.getElementById('waiting-leave').click();
    await 잠깐(1000);
    살펴본다('시작하자마자 나간 뒤', 'online', true);
    잠든퀴즈를깨워본다('시작하자마자 나간 뒤');
    // 한 번 더. 세션이 살아 있으면 다음 문항으로 넘어가 또 뜬다
    잠든퀴즈를깨워본다('시작하자마자 나간 뒤 (한 번 더)', 50000);
    살펴본곳.push('게임 시작 직후 나가기');

    await 눌러('online-home', 700);
    살펴본다('돌아온 홈', 'home', true);
  } catch (error) {
    결과.push({ 자리: '(검사 중단)', 이름: String(error && error.message), 통과: false, 무엇: '' });
  } finally {
    되돌리기();
    if (방백업 === null) localStorage.removeItem('quiz.rooms');
    else localStorage.setItem('quiz.rooms', 방백업);
  }

  // ── 보고 ──────────────────────────────────────────────────────

  const 실패 = 결과.filter((r) => !r.통과);
  console.table(결과.map((r) => ({
    자리: r.자리, 검사: r.이름, 결과: r.통과 ? '통과' : '실패', 본것: r.무엇,
  })));
  console.log(
    `%c${실패.length === 0 ? '전부 통과' : `${실패.length}건 실패`}`,
    `font-weight:bold;color:${실패.length === 0 ? '#268037' : '#db2121'}`,
    `— ${결과.length}개 검사 · 살펴본 곳: ${살펴본곳.join(' → ')}`,
  );
  if (실패.length > 0) {
    console.log('%c실패한 것', 'font-weight:bold');
    for (const r of 실패) console.log(`  [${r.자리}] ${r.이름} — ${r.무엇}`);
  }
  console.log('방 목록은 되돌려 놓았습니다. 랭킹·설정·닉네임은 건드리지 않았습니다.');
  return { 검사: 결과.length, 실패: 실패.length };
})();
