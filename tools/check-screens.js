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
  const 시간앞당기기 = (ms) => { 시간밀기 += ms; 프레임돌리기(); };

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
  function 잠든퀴즈를깨워본다(자리) {
    시간앞당기기(25000);
    const 깨어났나 = !document.getElementById('feedback').hidden;
    결과.push({
      자리, 이름: '25초가 흘러도 퀴즈가 깨어나지 않는다', 통과: !깨어났나,
      무엇: 깨어났나 ? `!! ${document.getElementById('feedback-verdict').textContent}` : '조용하다',
    });
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
    시간앞당기기(25000); // 다음 문항으로 넘어가 또 뜨지는 않는가
    결과.push({
      자리: '시작하자마자 나간 뒤', 이름: '50초가 흘러도 조용하다',
      통과: document.getElementById('feedback').hidden,
      무엇: document.getElementById('feedback').hidden ? '조용하다' : '!! 또 떴다',
    });
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
