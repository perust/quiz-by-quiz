// 화면을 옮긴 뒤 «아무것도 새지 않는가»를 브라우저에서 한 번에 확인한다.
//
// 쓰는 법 — 앱을 띄운 탭의 개발자 도구 콘솔에 이 파일을 통째로 붙여넣는다.
//
//   npm run build && python3 -m http.server 8765
//   → http://localhost:8765 를 열고 콘솔에 붙여넣기
//
// **이 수동 브라우저 점검에는 테스트 러너가 없다(의도적).** 그래서 «한 번 물렸던 것»만
// 골라 검사한다. 새 기능을 덮는 것이 목적이 아니라, 같은 데를 두 번 물리지 않는
// 것이 목적이다. 여기 있는 검사는 모두 실제로 났던 버그에서 왔다.
//
// 이 스크립트는 로컬 브라우저 화면 전환만 직접 만진다. API가 권위를 가진
// `online-quiz`·`online-result`와 재접속 invalidation은 가짜 서버 상태를 만들지 않고
// `tests/online-match-controller.test.mjs`, `tests/online-quiz-view.test.mjs`,
// `tests/online-result-view.test.mjs`, `tests/match-recovery.test.mjs`의 Node 회귀로
// 검사한다. 실제 두 브라우저/HTTPS/WSS 흐름은 API activation 뒤의 별도 stage 점검이다.
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
//      그래서 넷을 한자리에서 함께 본다. 워커가 빈자리의 Space 와 Ctrl+S 같은
//      브라우저 단축키까지 삼켜 키보드로 스크롤·저장을 할 수 없던 것도 여기서 본다
//      (걷기 키 s 가 Ctrl+S 의 s 와 같다).
//   ⑦ 시작 자리를 정하지 않은 결과 화면 워커가 «아직 잴 수 없음»만 되풀이해
//      캐릭터가 좌상단에 박힌 채 움직이지 않았고, 세우려는 프레임만 끝없이 돌았다.
//      한가운데로 세우자 1280×900 에서는 그 자리가 「랭킹 보기」 위였다 — 결과 화면은
//      섹션에 포커스가 있어, 앞 화면에서 누르던 Enter 가 그대로 그 버튼을 누른다
//   ⑧ 온라인·랭킹 워커가 320px 머리말 아래 안내문 위에 주차해 글자를 가렸다. 안내문이
//      줄어들거나 머리말 버튼 폭이 바뀌어도 글 끝과 캐릭터 왼쪽 사이를 직접 확인한다
//   ⑨ 홈에서 온라인이 작은 보조 HUD로 밀려 주요 게임 진입점처럼 보이지 않았다. 온라인과
//      전체 도전의 실제 크기가 같은지, 닉네임 라벨이 값 위에 남는지 직접 확인한다
//   ⑩ 답할 때마다 피드백 패널 끝에 맞춰 스크롤해 질문이 화면 위로 밀려났다. 해설을 읽는 동안
//      무엇에 대한 해설인지 보이지 않았다. 질문 머리와 패널 끝이 한 화면에 들면 둘 다
//      보여야 하고, 들지 않을 때만 패널 끝에 맞춘다
//   ⑪ 결과에서 「등록」을 누르지 않고 「다시 하기」를 누르면 기록이 조용히 사라졌다. 홈에는
//      «퀴즈왕»이 보이는데 결과의 등록 칸은 비어 있었다
//   ⑫ 시스템 「뒤로」가 앱 밖으로 나가 풀던 판이 확인도 없이 사라졌다
//   ⑬ 로비 안내가 «API 설정이 없어…»처럼 개발 용어로 말했다 (U40). 조작법은 방향키만 말해
//      WASD로도 걷는다는 것을 알 길이 없었다 (U52) — 말한 키가 정말 캐릭터 몫인지 본다
//   ⑭ 설정의 문항 시간 «제한 없음»(FR-3.7)은 시간 초과로 가는 길이 아예 없어야 한다. 25초를 앞당겨도
//      판이 깨어나지 않는지, 설정 대화상자가 워커와 화면의 키(로비의 Esc)를 가두는지 함께 본다
//   ⑮ 홈 dock 의 분야 이름을 넓은 화면에서 14px 로 키우면(U53) 「예술과문화」가 폭 421–467px 칸을
//      넘친다(tests/home-interface.test.mjs 의 셈이 먼저 잡았다). 셈은 맑은 고딕의 1em 을 가정하므로
//      실제 글꼴로 글자 크기·다섯 칸 한 줄·이름이 잘리지 않는지를 지금 창 폭에서 본다
//   ⑯ 짧은 가로 홈(U07)의 두 줄 dock이 화면의 절반을 먹어 두 보조 입구와 조작부가 위 가운데로 밀려
//      올라왔다. dock 한 줄·되살린 브랜드·가장자리 조각끼리 겹치지 않음·캐릭터 시작 자리를 본다
//   ⑰ 짧은 가로 touch 퀴즈(U15)에서 바닥이 접힘 아래로 밀리고 조작부가 보기를 덮었다. 두 열 배치에서
//      답하기 전에 스크롤 없이 다 보이는지, 답한 뒤 「다음 문제」가 패널 안에 잘리지 않는지 본다.
//      짧은 가로 검사는 그 화면 크기(touch · 높이 480px 이하 가로 / 높이 420px 이하 · 폭 640px 이상)에서만
//      돈다 — 740×360 · 667×375 · 844×390 · 915×412 를 touch 에뮬레이션으로 열고 붙여넣는다
//
// **localStorage 의 방 목록·랭킹·설정을 건드린다.** 시작할 때 백업하고 끝나면 되돌린다 —
// ⑪을 보려고 랭킹을 잠깐 비우고 자동 저장된 기록을 센다. ⑭은 문항 시간을 잠깐 «제한 없음»으로
// 바꿨다가 화면에서 원래 값으로 되돌린다.

(async () => {
  const 결과 = [];
  const 살펴본곳 = [];

  // ── 도구 ──────────────────────────────────────────────────────

  const 잠깐 = (ms) => new Promise((r) => setTimeout(r, ms));
  const 지금화면 = () =>
    [...document.querySelectorAll('.screen')].find((s) => !s.hidden)?.dataset.screen ?? '(없음)';
  const 화면기다리기 = async (화면, 제한 = 5000) => {
    const 끝 = performance.now() + 제한;
    while (지금화면() !== 화면 && performance.now() < 끝) await 잠깐(100);
  };
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

  function 겹친글자줄(요소, 상자) {
    const 범위 = document.createRange();
    범위.selectNodeContents(요소);
    return [...범위.getClientRects()].filter((줄) =>
      줄.left < 상자.right && 줄.right > 상자.left
      && 줄.top < 상자.bottom && 줄.bottom > 상자.top);
  }

  function 글자너비(요소) {
    const 범위 = document.createRange();
    범위.selectNodeContents(요소);
    return 범위.getBoundingClientRect().width;
  }

  function 글자상자(요소) {
    const 범위 = document.createRange();
    범위.selectNodeContents(요소);
    return 범위.getBoundingClientRect();
  }

  function 겹친넓이(왼쪽, 오른쪽) {
    const 너비 = Math.max(0, Math.min(왼쪽.right, 오른쪽.right) - Math.max(왼쪽.left, 오른쪽.left));
    const 높이 = Math.max(0, Math.min(왼쪽.bottom, 오른쪽.bottom) - Math.max(왼쪽.top, 오른쪽.top));
    return 너비 * 높이;
  }

  /**
   * 이 화면에 있을 때 참이어야 하는 것들.
   *
   * @param 화면 지금 있어야 할 화면 이름
   * @param 걷는가 이 화면에서 캐릭터가 걸어 다니는가.
   *   모든 퀴즈 화면은 캐릭터가 방향키를 받는다.
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

    // ② 스틱·선택을 따로 켜지 않고 공용 컴포넌트 하나가 활성 walker 계약을 가진다
    const 조작부 = document.getElementById('walk-controls');
    const 켜짐 = 조작부?.classList.contains('walk-controls--on');
    본다('손가락 조작부가 화면과 맞는다', Boolean(켜짐) === 걷는가,
      `공용 조작부 ${켜짐 ? '켜짐' : '꺼짐'} (바란 것: ${걷는가 ? '켜짐' : '꺼짐'})`);
    if (걷는가) {
      const 바란배치 = 화면 === 'home' ? 'home-dock' : 'viewport';
      본다('공용 조작부의 배치 계약이 맞는다',
        조작부?.dataset.placement === 바란배치,
        `${조작부?.dataset.placement} (바란 것: ${바란배치})`);
    }

    // 방향키를 지금 화면의 캐릭터가 받는가. 아무도 안 받으면 브라우저 스크롤이 된다
    const 키 = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    document.dispatchEvent(키);
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    본다('방향키의 임자가 맞는다', 키.defaultPrevented === 걷는가,
      키.defaultPrevented ? '캐릭터가 받는다' : '아무도 안 받는다');

    if (화면 === 'quiz') {
      const 무대 = document.getElementById('arena');
      본다('캐릭터 무대가 항상 열려 있다', 무대 && !무대.hidden,
        무대 ? (무대.hidden ? '숨김' : '보임') : '없음');
    }
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
  const 랭킹백업 = localStorage.getItem('quiz.rankings');
  const 설정백업 = localStorage.getItem('quiz.settings');
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
    결과.push({
      자리: '홈', 이름: '모드 토글이 없다',
      통과: !document.getElementById('game-mode-toggle'),
      무엇: document.getElementById('game-mode-toggle') ? '!! 남아 있음' : '없음',
    });
    결과.push({
      자리: '대기실 계약', 이름: '모드 설정 카드가 없다',
      통과: !document.getElementById('setting-mode'),
      무엇: document.getElementById('setting-mode') ? '!! 남아 있음' : '없음',
    });
    const 설정크기 = document.getElementById('open-settings').getBoundingClientRect();
    결과.push({
      자리: '공통', 이름: '상단 설정 버튼의 터치 목표가 44px 이상이다',
      통과: 설정크기.width >= 44 && 설정크기.height >= 44,
      무엇: `${설정크기.width}px × ${설정크기.height}px`,
    });
    const 닉네임라벨 = document.querySelector('#open-nickname .menu-card__label');
    const 닉네임값 = document.getElementById('nickname-value');
    const 닉네임라벨상자 = 닉네임라벨.getBoundingClientRect();
    const 닉네임값상자 = 닉네임값.getBoundingClientRect();
    // ⑪ 처음 띄울 때 기본 이름을 저장해 두므로 홈·결과·온라인이 같은 값을 읽는다
    const 저장된닉네임 = JSON.parse(localStorage.getItem('quiz.nickname') ?? 'null');
    결과.push({
      자리: '홈', 이름: '홈 닉네임이 저장된 이름과 같다',
      통과: typeof 저장된닉네임 === 'string' && 저장된닉네임 === 닉네임값.textContent.trim(),
      무엇: `홈 ${닉네임값.textContent.trim()} · 저장 ${저장된닉네임 ?? '(없음)'}`,
    });
    결과.push({
      자리: '홈', 이름: '작은 닉네임 라벨이 현재 값 위에 있다',
      통과: 닉네임라벨.textContent.trim() === '닉네임'
        && 닉네임라벨상자.bottom <= 닉네임값상자.top + 1,
      무엇: `${닉네임라벨.textContent.trim()} · label bottom ${닉네임라벨상자.bottom}px / value top ${닉네임값상자.top}px`,
    });
    const 온라인크기 = document.getElementById('open-online').getBoundingClientRect();
    const 전체도전크기 = document.getElementById('start-all').getBoundingClientRect();
    결과.push({
      자리: '홈', 이름: '온라인과 전체 도전은 같은 크기의 주요 버튼이다',
      통과: Math.abs(온라인크기.width - 전체도전크기.width) <= 1
        && Math.abs(온라인크기.height - 전체도전크기.height) <= 1
        && 온라인크기.width >= 44 && 온라인크기.height >= 44,
      무엇: `온라인 ${온라인크기.width}px × ${온라인크기.height}px · 전체 ${전체도전크기.width}px × ${전체도전크기.height}px`,
    });
    결과.push({
      자리: '홈', 이름: '온라인은 보조 HUD가 아니라 주요 행동 묶음에 있다',
      통과: document.getElementById('open-online').parentElement?.classList.contains('home-primary-actions')
        && !document.querySelector('.home-menu #open-online'),
      무엇: document.getElementById('open-online').parentElement?.className ?? '(부모 없음)',
    });
    // 기록이 없는 새 브라우저에서도 가장 긴 실제 pill을 잠깐 보여, 중간 폭에서 이름과
    // 겹치는 회귀를 잡는다. 화면 점검 뒤에는 원래 DOM 상태로 되돌린다.
    const 전체도전이름 = document.querySelector('#start-all .challenge-card__name');
    const 전체도전기록 = document.getElementById('start-all-meta');
    const 원래기록숨김 = 전체도전기록.hidden;
    const 원래기록문구 = 전체도전기록.textContent;
    전체도전기록.hidden = false;
    전체도전기록.textContent = '최고 100점';
    const 기록이보이는가 = getComputedStyle(전체도전기록).display !== 'none';
    const 전체도전이름상자 = 글자상자(전체도전이름);
    const 전체도전기록상자 = 전체도전기록.getBoundingClientRect();
    결과.push({
      자리: '홈', 이름: '전체 도전 이름과 최고 기록 pill이 겹치지 않는다',
      통과: !기록이보이는가 || 전체도전이름상자.right <= 전체도전기록상자.left + 1,
      무엇: 기록이보이는가
        ? `이름 right ${전체도전이름상자.right}px / 기록 left ${전체도전기록상자.left}px`
        : '짧은 화면에서 보조 기록을 접음',
    });
    전체도전기록.hidden = 원래기록숨김;
    전체도전기록.textContent = 원래기록문구;

    // ⑮ 분야 이름은 폭 420px 이하에서만 12px 이고 넓으면 14px 다 (U53). 키워도 다섯 칸이 한 줄에 남고
    // 보이는 이름이 칸 안에서 잘리지 않아야 한다 — 「예술과문화」는 14px 에서 70px 라 폭 480px 까지는
    // 짧은 라벨(「예술」)을 보인다. 창 폭을 421·450·481·600px 로 바꿔 가며 돌려 본다
    const 분야칸 = [...document.querySelectorAll('#category-grid .category-card')];
    const 보이는이름 = 분야칸.map((칸) => [...칸.querySelectorAll('.category-card__name')]
      .find((이름) => getComputedStyle(이름).display !== 'none'));
    const 바란크기 = window.innerWidth <= 420 ? 12 : 14;
    const 이름크기 = 보이는이름.map((이름) => (이름 ? Number.parseFloat(getComputedStyle(이름).fontSize) : NaN));
    결과.push({
      자리: '홈', 이름: `분야 이름이 ${바란크기}px 이다 (폭 ${window.innerWidth}px)`,
      통과: 이름크기.length === 5 && 이름크기.every((크기) => 크기 === 바란크기),
      무엇: 이름크기.map((크기) => `${크기}px`).join(' · '),
    });
    const 칸줄 = new Set(분야칸.map((칸) => Math.round(칸.getBoundingClientRect().top)));
    결과.push({
      자리: '홈', 이름: '다섯 분야가 dock 한 줄에 있다',
      통과: 분야칸.length === 5 && 칸줄.size === 1,
      무엇: `${분야칸.length}칸 · ${칸줄.size}줄`,
    });
    const 잘린이름 = 보이는이름.filter((이름) => 이름 && 이름.scrollWidth > 이름.clientWidth)
      .map((이름) => `${이름.textContent} ${이름.scrollWidth}/${이름.clientWidth}px`);
    결과.push({
      자리: '홈', 이름: '보이는 분야 이름이 칸 안에서 잘리지 않는다',
      통과: 보이는이름.every(Boolean) && 잘린이름.length === 0,
      무엇: 잘린이름.join(', ') || 보이는이름.map((이름) => 이름?.textContent ?? '(없음)').join(' · '),
    });
    // ⑯ 짧은 가로 홈(U07). 두 줄 dock이 화면의 절반(740×360에서 171px)을 먹어 두 보조 입구와 조작부가
    // 위 가운데까지 밀려 올라왔고 브랜드는 접혀 있었다. 가장자리 조각끼리 겹치지 않는 것은 어느 화면에서나 본다
    const 홈조각 = {
      dock: document.getElementById('home-quests'),
      캐릭터입구: document.getElementById('open-characters'),
      랭킹입구: document.getElementById('open-ranking'),
      닉네임: document.getElementById('open-nickname'),
      설정: document.getElementById('open-settings'),
      브랜드: document.getElementById('home-title'),
      스틱: document.querySelector('.walk-stick'),
      선택: document.querySelector('.walk-confirm'),
    };
    const 홈상자 = Object.entries(홈조각)
      .map(([이름, 요소]) => [이름, 요소.getBoundingClientRect()])
      // 접은 브랜드(1px)·조작부가 없는 마우스 기기의 빈 상자는 뺀다
      .filter(([, 상자]) => 상자.width > 1 && 상자.height > 1);
    const 겹친홈조각 = [];
    for (let 앞 = 0; 앞 < 홈상자.length; 앞 += 1) {
      for (let 뒤 = 앞 + 1; 뒤 < 홈상자.length; 뒤 += 1) {
        const 넓이 = 겹친넓이(홈상자[앞][1], 홈상자[뒤][1]);
        if (넓이 > 0) 겹친홈조각.push(`${홈상자[앞][0]}×${홈상자[뒤][0]} ${Math.round(넓이)}px²`);
      }
    }
    결과.push({
      자리: '홈', 이름: '가장자리 입구·dock·브랜드·조작부가 서로 겹치지 않는다',
      통과: 겹친홈조각.length === 0,
      무엇: `${innerWidth}×${innerHeight} · ${겹친홈조각.join(', ') || '겹침 없음'}`,
    });
    if (matchMedia('(max-height: 420px) and (min-width: 640px)').matches) {
      const 분야줄 = document.getElementById('category-grid').getBoundingClientRect();
      const 주행동줄 = document.querySelector('.home-primary-actions').getBoundingClientRect();
      const dock상자 = 홈조각.dock.getBoundingClientRect();
      결과.push({
        자리: '홈', 이름: '짧은 가로: 분야와 온라인·전체 도전이 dock 한 줄에 있다',
        통과: Math.abs(분야줄.top - 주행동줄.top) <= 1 && 분야줄.right <= 주행동줄.left + 1
          && dock상자.height <= innerHeight / 4,
        무엇: `분야 top ${Math.round(분야줄.top)}px · 주 행동 top ${Math.round(주행동줄.top)}px · dock ${Math.round(dock상자.height)}px / 화면 ${innerHeight}px`,
      });
      const 브랜드상자 = 홈조각.브랜드.getBoundingClientRect();
      결과.push({
        자리: '홈', 이름: '짧은 가로: 브랜드가 위 가운데에 보인다',
        통과: 브랜드상자.width > 40 && 브랜드상자.top >= 0 && 브랜드상자.bottom <= 홈조각.dock.getBoundingClientRect().top,
        무엇: `브랜드 ${Math.round(브랜드상자.width)}px × ${Math.round(브랜드상자.height)}px · top ${Math.round(브랜드상자.top)}px`,
      });
    }

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
    const 활성랭킹 = document.querySelector('[data-screen="ranking"]:not([hidden])');
    const 랭킹탭크기 = [...(활성랭킹?.querySelectorAll('.ranking-tab') ?? [])]
      .filter((탭) => 탭.getClientRects().length > 0)
      .map((탭) => 탭.getBoundingClientRect().height);
    프레임돌리기();
    결과.push({
      자리: '랭킹', 이름: '랭킹 탭의 터치 목표가 44px 이상이다',
      통과: 랭킹탭크기.length === 6 && 랭킹탭크기.every((높이) => 높이 >= 44),
      무엇: 랭킹탭크기.map((높이) => `${높이}px`).join(', '),
    });
    const 랭킹안내 = document.querySelector('.ranking-scope');
    const 랭킹캐릭터 = document.getElementById('ranking-character');
    const 겹친랭킹글 = 겹친글자줄(랭킹안내, 랭킹캐릭터.getBoundingClientRect());
    결과.push({
      자리: '랭킹', 이름: '주차한 캐릭터가 저장 범위 안내 글을 덮지 않는다',
      통과: 겹친랭킹글.length === 0,
      무엇: `겹친 글자 줄 ${겹친랭킹글.length}개`,
    });
    const 기록지우기상자 = document.getElementById('ranking-clear').getBoundingClientRect();
    const 조작부겹침 = 겹친넓이(기록지우기상자, document.querySelector('.walk-stick').getBoundingClientRect())
      + 겹친넓이(기록지우기상자, document.querySelector('.walk-confirm').getBoundingClientRect());
    결과.push({
      자리: '랭킹', 이름: '위험 행동이 양쪽 고정 조작부와 겹치지 않는다',
      통과: 조작부겹침 === 0,
      // 어느 탭에도 기록이 없으면 지울 것이 없어 버튼째 숨는다
      무엇: document.getElementById('ranking-footer').hidden ? '기록이 없어 숨김' : `겹친 넓이 ${조작부겹침}px²`,
    });
    잠든퀴즈를깨워본다('랭킹');
    await 눌러('ranking-home');
    // ⑯ 홈으로 돌아오면 워커가 시작 자리에 다시 선다. 버튼을 밟지 않고, 되살린 브랜드·입구·조작부를 덮지 않는다
    프레임돌리기(3);
    const 홈캐릭터상자 = document.getElementById('home-character').getBoundingClientRect();
    const 홈발밑 = document.querySelector('[data-screen="home"] .is-standing, .app-bar .is-standing');
    const 캐릭터가덮은것 = ['home-title', 'open-characters', 'open-ranking', 'open-nickname', 'home-quests']
      .map((id) => document.getElementById(id))
      .concat([document.querySelector('.walk-stick'), document.querySelector('.walk-confirm')])
      .filter((요소) => {
        const 상자 = 요소.getBoundingClientRect();
        return 상자.width > 1 && 상자.height > 1 && 겹친넓이(상자, 홈캐릭터상자) > 0;
      })
      .map((요소) => 요소.id || 요소.className);
    결과.push({
      자리: '홈', 이름: '캐릭터가 아무것도 밟거나 덮지 않은 자리에서 시작한다',
      통과: !홈발밑 && 캐릭터가덮은것.length === 0,
      무엇: 홈발밑 ? `!! ${홈발밑.id || 홈발밑.className} 위`
        : (캐릭터가덮은것.length ? `!! 덮음: ${캐릭터가덮은것.join(', ')}` : `빈자리 (${Math.round(홈캐릭터상자.left)}, ${Math.round(홈캐릭터상자.bottom)})`),
    });
    살펴본곳.push('랭킹');

    // 홈 → 내 캐릭터 → 홈
    await 눌러('open-characters', 700);
    살펴본다('내 캐릭터', 'characters', true);
    await 눌러('characters-back');
    살펴본곳.push('내 캐릭터');

    // 퀴즈에 들어갔다가 **답을 낸 채로** 나온다. 시트와 세션이 함께 접혀야 한다
    document.querySelector('.category-card').click();
    await 잠깐(800);
    살펴본다('처음 연 퀴즈', 'quiz', true);
    const 보기크기 = [...document.querySelectorAll('#choices .choice')]
      .map((보기) => 보기.getBoundingClientRect().height);
    결과.push({
      자리: '퀴즈', 이름: '직접 보기의 터치 목표가 44px 이상이다',
      통과: 보기크기.length === 4 && 보기크기.every((높이) => 높이 >= 44),
      무엇: 보기크기.map((높이) => `${높이}px`).join(', '),
    });
    const 도움크기 = document.getElementById('arena-help').getBoundingClientRect();
    결과.push({
      자리: '퀴즈', 이름: '조작법 버튼의 터치 목표가 44px 이상이다',
      통과: 도움크기.width >= 44 && 도움크기.height >= 44,
      무엇: `${도움크기.width}px × ${도움크기.height}px`,
    });
    // ⑰ 짧은 가로 touch 화면(U15). 세로로 쌓으면 740×360에서 문서가 642px이 되어 바닥이 거의 다 접힘 아래였고,
    // 고정 스틱·선택이 3·4번 보기를 덮었다. 두 열(왼쪽 HUD·질문·보기, 오른쪽 바닥)에서는 답하기 전에 스크롤 없이
    // 넷이 다 보이고, 조작부는 양옆 여백에 있다. 은행에서 가장 긴 질문과 긴 보기가 겹치면 넘칠 수 있다
    const 짧은가로퀴즈 = matchMedia('(pointer: coarse) and (max-height: 480px) and (orientation: landscape)').matches;
    if (짧은가로퀴즈) {
      // 워커는 다음 프레임에 십자 한가운데에 선다
      프레임돌리기(3);
      const 화면안 = (상자) => 상자.top >= -1 && 상자.bottom <= innerHeight + 1 && 상자.left >= -1 && 상자.right <= innerWidth + 1;
      const 보기상자 = [...document.querySelectorAll('#choices .choice')].map((보기) => 보기.getBoundingClientRect());
      const 칸상자 = [...document.querySelectorAll('#arena-tiles .arena-tile')].map((칸) => 칸.getBoundingClientRect());
      const 위쪽 = [document.querySelector('[data-screen="quiz"] .quiz-hud'), document.getElementById('question-text')]
        .map((요소) => 요소.getBoundingClientRect());
      const 문서높이 = document.documentElement.scrollHeight;
      결과.push({
        자리: '퀴즈', 이름: '짧은 가로: 답하기 전에 문서가 화면 높이를 넘지 않는다',
        통과: 문서높이 <= innerHeight + 1 && scrollY === 0,
        무엇: `${innerWidth}×${innerHeight} · 문서 ${문서높이}px · scrollY ${scrollY} · 질문 ${document.getElementById('question-text').textContent.length}자`,
      });
      결과.push({
        자리: '퀴즈', 이름: '짧은 가로: HUD·질문·네 보기·네 바닥 칸이 모두 화면 안에 있다',
        통과: 보기상자.length === 4 && 칸상자.length === 4 && [...위쪽, ...보기상자, ...칸상자].every(화면안),
        무엇: `보기 아래 ${Math.round(Math.max(...보기상자.map((상자) => 상자.bottom)))}px · 칸 아래 ${Math.round(Math.max(...칸상자.map((상자) => 상자.bottom)))}px`,
      });
      결과.push({
        자리: '퀴즈', 이름: '짧은 가로: 바닥은 보기 오른쪽 열에 있다',
        통과: 칸상자.length === 4 && Math.min(...칸상자.map((상자) => 상자.left)) >= Math.max(...보기상자.map((상자) => 상자.right)),
        무엇: `보기 오른쪽 ${Math.round(Math.max(...보기상자.map((상자) => 상자.right)))}px · 칸 왼쪽 ${Math.round(Math.min(...칸상자.map((상자) => 상자.left)))}px`,
      });
      const 조작부상자 = [document.querySelector('.walk-stick'), document.querySelector('.walk-confirm')]
        .map((요소) => 요소.getBoundingClientRect());
      const 덮인넓이 = [...보기상자, ...칸상자]
        .reduce((합, 상자) => 합 + 조작부상자.reduce((작은합, 조작부) => 작은합 + 겹친넓이(상자, 조작부), 0), 0);
      결과.push({
        자리: '퀴즈', 이름: '짧은 가로: 고정 스틱·선택이 보기와 바닥 칸을 덮지 않는다',
        통과: 조작부상자.every((상자) => 상자.width >= 44) && 덮인넓이 === 0,
        무엇: `조작부 ${조작부상자.map((상자) => `${Math.round(상자.width)}px`).join(' · ')} · 덮인 넓이 ${Math.round(덮인넓이)}px²`,
      });
      결과.push({
        자리: '퀴즈', 이름: '짧은 가로: 캐릭터가 바닥 십자 한가운데(아무 칸도 아닌 자리)에서 시작한다',
        통과: !document.querySelector('[data-screen="quiz"] .is-standing'),
        무엇: document.querySelector('[data-screen="quiz"] .is-standing')?.className ?? '중립',
      });
    }
    document.querySelector('.choice').click();
    await 잠깐(400);
    결과.push({
      자리: '퀴즈', 이름: '답을 내면 시트가 뜬다',
      통과: !document.getElementById('feedback').hidden, 무엇: '준비된 상태를 만든다',
    });
    if (짧은가로퀴즈) {
      // 결과 패널 높이 한도가 60vh(360px 화면에서 216px)이면 「다음 문제」가 패널 안 스크롤 밑에 잘렸다
      const 화면안 = (요소) => {
        const 상자 = 요소.getBoundingClientRect();
        return 상자.top >= -1 && 상자.bottom <= innerHeight + 1;
      };
      const 정답줄 = document.getElementById('feedback-answer');
      결과.push({
        자리: '퀴즈', 이름: '짧은 가로: 답한 뒤 판정·정답 줄·「다음 문제」가 한 화면에 보인다',
        통과: 화면안(document.getElementById('feedback-verdict'))
          && (정답줄.hidden || 화면안(정답줄))
          && 화면안(document.getElementById('next-button')),
        무엇: `scrollY ${Math.round(scrollY)} · 다음 문제 bottom ${Math.round(document.getElementById('next-button').getBoundingClientRect().bottom)}px / ${innerHeight}px`,
      });
    }
    // ⑩ 질문 머리와 패널 끝 사이의 거리는 스크롤과 무관하다. 그 거리가 화면에 들면
    // 질문 머리도 패널 끝도 화면 안이어야 하고, 들지 않으면 패널 끝(「다음 문제」)에 맞춘다
    const 질문상자 = document.getElementById('question-text').getBoundingClientRect();
    const 패널상자 = document.getElementById('feedback').getBoundingClientRect();
    const 함께담기나 = 패널상자.bottom - 질문상자.top <= innerHeight + 1;
    결과.push({
      자리: '퀴즈', 이름: '피드백을 보는 동안 질문 머리가 화면 안에 남는다',
      통과: 함께담기나
        ? 질문상자.top >= -1 && 패널상자.bottom <= innerHeight + 1
        : Math.abs(패널상자.bottom - innerHeight) <= 1,
      무엇: `${innerWidth}×${innerHeight} · 질문 top ${Math.round(질문상자.top)}px · 패널 bottom ${Math.round(패널상자.bottom)}px`
        + (함께담기나 ? '' : ' · 한 화면에 들지 않아 패널 끝에 맞춤'),
    });
    await 눌러('quiz-exit', 300);
    await 눌러('exit-confirm', 700);
    살펴본다('답을 낸 채 나온 홈', 'home', true);
    잠든퀴즈를깨워본다('답을 낸 채 나온 홈');
    살펴본곳.push('퀴즈에서 나오기');

    // 퀴즈를 끝까지 풀어 결과로 간 뒤, 「다시 하기」로 되돌아온다.
    // 결과 화면의 조작부가 따라오면 여기서 걸린다 (#65)
    // ⑪ 「등록」 없이 떠나도 저장되는지 세려고 랭킹을 비워 둔다 (끝나면 되돌린다)
    localStorage.setItem('quiz.rankings', '[]');
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
    // ⑦ 워커는 다음 프레임에 자리를 잡는다. 프레임을 돌려도 transform 이 비어 있으면
    // 캐릭터가 좌상단(0,0)에 박혀 있는 것이다
    프레임돌리기(3);
    const 결과캐릭터 = document.getElementById('result-character');
    결과.push({
      자리: '결과', 이름: '캐릭터가 화면 안 자리에 선다',
      통과: Boolean(결과캐릭터.style.transform),
      무엇: 결과캐릭터.style.transform || '!! 자리를 잡지 못했다 (좌상단)',
    });
    const 결과발밑 = document.querySelector('[data-screen="result"] .is-standing');
    결과.push({
      자리: '결과', 이름: '버튼을 밟지 않은 자리에서 시작한다',
      통과: !결과발밑,
      무엇: 결과발밑 ? `!! ${결과발밑.id || 결과발밑.className} 위 — Enter 가 그대로 누른다` : '빈자리',
    });
    // ⑥ 발밑이 비면 Space 는 브라우저 것이다. 워커가 삼키면 키보드만 쓰는 사람이 긴 오답
    // 풀이를 내려 읽을 수 없다. 발밑에 무엇이 있으면(앱 바 포함) Space 가 그것을 누르므로 보내지 않는다
    let 빈자리스페이스 = null;
    if (!document.querySelector('.is-standing')) {
      const 스페이스 = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      document.dispatchEvent(스페이스);
      document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      빈자리스페이스 = 스페이스.defaultPrevented;
    }
    결과.push({
      자리: '결과', 이름: '발밑이 비면 Space로 스크롤된다',
      통과: 빈자리스페이스 === false,
      무엇: 빈자리스페이스 === null ? '!! 발밑이 비지 않아 보내지 않았다'
        : (빈자리스페이스 ? '!! 워커가 삼킨다' : '브라우저 것이다'),
    });
    const 결과행동 = document.getElementById('result-retry').closest('.result-actions');
    const 오답풀이 = document.getElementById('result-review-block');
    결과.push({
      자리: '결과', 이름: '핵심 행동이 긴 오답 풀이보다 먼저 온다',
      통과: Boolean(결과행동 && 오답풀이
        && (결과행동.compareDocumentPosition(오답풀이) & Node.DOCUMENT_POSITION_FOLLOWING)),
      무엇: 결과행동 && 오답풀이
        ? `행동 ${결과행동.getBoundingClientRect().top}px · 오답 풀이 ${오답풀이.getBoundingClientRect().top}px`
        : '요소 없음',
    });
    결과.push({
      자리: '결과', 이름: '등록 칸이 홈 닉네임으로 채워져 있다',
      통과: document.getElementById('nickname-input').value === 닉네임값.textContent.trim(),
      무엇: `칸 ${document.getElementById('nickname-input').value || '(비어 있음)'} · 홈 ${닉네임값.textContent.trim()}`,
    });
    await 눌러('result-retry', 800);
    살펴본다('「다시 하기」로 돌아온 퀴즈', 'quiz', true);
    const 자동저장 = JSON.parse(localStorage.getItem('quiz.rankings') ?? '[]');
    결과.push({
      자리: '결과', 이름: '「등록」 없이 「다시 하기」를 눌러도 기록이 남는다',
      통과: Array.isArray(자동저장) && 자동저장.length === 1,
      무엇: `저장된 기록 ${Array.isArray(자동저장) ? 자동저장.length : '(깨짐)'}개`,
    });
    await 눌러('quiz-exit', 300);
    await 눌러('exit-confirm', 700);
    살펴본곳.push('결과 → 다시 하기');

    // ⑫ 시스템 「뒤로」. 앱 밖으로 나가지 않고 그 화면의 뒤로·나가기 버튼과 같이 움직인다
    await 눌러('open-ranking', 700);
    // 방금 자동 저장된 분야 기록 하나뿐이라 전체 도전 탭은 비어 있다
    document.querySelector('[data-screen="ranking"] .ranking-tab').click();
    await 잠깐(300);
    결과.push({
      자리: '랭킹', 이름: '빈 탭의 행동은 그 탭의 판을 연다',
      통과: document.getElementById('ranking-empty-start').textContent.trim() === '전체 도전 시작하기',
      무엇: document.getElementById('ranking-empty-start').textContent.trim(),
    });
    결과.push({
      자리: '랭킹', 이름: '다른 탭에 기록이 있으면 「모든 기록 지우기」가 남는다',
      통과: !document.getElementById('ranking-footer').hidden,
      무엇: document.getElementById('ranking-footer').hidden ? '!! 숨김' : '보임',
    });
    history.back();
    await 화면기다리기('home');
    살펴본다('랭킹에서 「뒤로」', 'home', true);

    document.querySelector('.category-card').click();
    await 잠깐(800);
    history.back();
    await 잠깐(400);
    결과.push({
      자리: '퀴즈', 이름: '「뒤로」는 판을 버리지 않고 나가기 확인을 연다',
      통과: 지금화면() === 'quiz' && !document.getElementById('exit-dialog').hidden,
      무엇: `화면 ${지금화면()} · 확인 ${document.getElementById('exit-dialog').hidden ? '닫힘' : '열림'}`,
    });
    await 눌러('exit-cancel', 300);
    history.back();
    await 잠깐(400);
    결과.push({
      자리: '퀴즈', 이름: '확인을 무른 뒤 다시 「뒤로」를 눌러도 앱 안에 남는다',
      통과: 지금화면() === 'quiz' && !document.getElementById('exit-dialog').hidden,
      무엇: `화면 ${지금화면()} · 확인 ${document.getElementById('exit-dialog').hidden ? '닫힘' : '열림'}`,
    });
    await 눌러('exit-confirm', 700);
    살펴본다('퀴즈에서 「뒤로」로 나온 홈', 'home', true);
    잠든퀴즈를깨워본다('퀴즈에서 「뒤로」로 나온 홈');
    살펴본곳.push('뒤로 가기');

    // ⑭ 설정 대화상자와 «제한 없음». 키는 실제처럼 포커스가 있는 요소에서 보낸다 —
    // 대화상자는 문서의 캡처 단계에서 키를 멈추므로 document 자신에게 보내면 그 길을 타지 않는다
    const 포커스에서키 = (키) => {
      const 이벤트 = new KeyboardEvent('keydown', { key: 키, bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(이벤트);
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 키, bubbles: true }));
      return 이벤트.defaultPrevented;
    };
    const 설정창 = document.getElementById('settings-dialog');
    const 시간칸 = (값) => document.querySelector(`#settings-dialog [data-time-limit="${값}"]`);
    const 원래시간 = document.querySelector('#settings-dialog [data-time-limit][aria-pressed="true"]')?.dataset.timeLimit ?? '20000';
    document.getElementById('open-settings').focus();
    await 눌러('open-settings', 300);
    결과.push({
      자리: '설정', 이름: '「설정」이 인페이지 대화상자를 열고 패널에 포커스를 둔다',
      통과: !설정창.hidden && document.activeElement === 설정창.querySelector('[role="dialog"]'),
      무엇: `${설정창.hidden ? '!! 닫힘' : '열림'} · 포커스 ${document.activeElement?.id || document.activeElement?.className || '(없음)'}`,
    });
    const 대화상자방향키 = 포커스에서키('ArrowDown');
    결과.push({
      자리: '설정', 이름: '열려 있는 동안 캐릭터가 방향키를 받지 않는다',
      통과: !대화상자방향키,
      무엇: 대화상자방향키 ? '!! 뒤에서 캐릭터가 걷는다' : '캐릭터는 그대로다',
    });
    시간칸('none').click();
    await 잠깐(100);
    결과.push({
      자리: '설정', 이름: '«제한 없음» 하나만 눌려 있다',
      통과: 시간칸('none').getAttribute('aria-pressed') === 'true'
        && document.querySelectorAll('#settings-dialog [data-time-limit][aria-pressed="true"]').length === 1,
      무엇: [...document.querySelectorAll('#settings-dialog [data-time-limit]')]
        .map((칸) => `${칸.textContent.trim()} ${칸.getAttribute('aria-pressed')}`).join(' · '),
    });
    포커스에서키('Escape');
    await 잠깐(100);
    결과.push({
      자리: '설정', 이름: 'Esc 로 닫으면 「설정」 버튼으로 포커스가 돌아온다',
      통과: 설정창.hidden && document.activeElement === document.getElementById('open-settings'),
      무엇: `${설정창.hidden ? '닫힘' : '!! 열림'} · 포커스 ${document.activeElement?.id || '(없음)'}`,
    });
    document.querySelector('.category-card').click();
    await 잠깐(800);
    살펴본다('«제한 없음» 퀴즈', 'quiz', true);
    const 막대 = document.querySelector('#timer .timer__track');
    결과.push({
      자리: '설정', 이름: '«제한 없음» 판의 HUD는 «시간 제한 없음»을 말하고 막대를 거둔다',
      통과: document.getElementById('timer-text').textContent.trim() === '시간 제한 없음'
        && getComputedStyle(막대).display === 'none'
        && document.getElementById('question-time-limit').textContent.trim() === '시간 제한 없음',
      무엇: `${document.getElementById('timer-text').textContent.trim()} · 막대 ${getComputedStyle(막대).display}`,
    });
    시간앞당기기(25000);
    const 시간초과났나 = !document.getElementById('feedback').hidden;
    결과.push({
      자리: '설정', 이름: '«제한 없음» 판은 25초를 앞당겨도 시간 초과가 나지 않는다',
      통과: !시간초과났나 && 지금화면() === 'quiz'
        && [...document.querySelectorAll('#choices .choice')].every((보기) => !보기.disabled),
      무엇: 시간초과났나 ? `!! ${document.getElementById('feedback-verdict').textContent}` : '판이 그대로 기다린다',
    });
    시간되돌리기(25000);
    await 눌러('quiz-exit', 300);
    await 눌러('exit-confirm', 700);
    살펴본다('«제한 없음» 퀴즈에서 나온 홈', 'home', true);
    // 화면에서 원래 값으로 되돌린다. 저장소만 되돌리면 앱이 기억한 값과 어긋난다
    await 눌러('open-settings', 300);
    시간칸(원래시간).click();
    await 눌러('settings-close', 300);
    결과.push({
      자리: '설정', 이름: '문항 시간을 원래 값으로 되돌렸다',
      통과: 시간칸(원래시간).getAttribute('aria-pressed') === 'true' && 설정창.hidden,
      무엇: 원래시간,
    });
    살펴본곳.push('설정 «제한 없음»');

    // 로비와 대기실. 방을 하나 만들어 오간다
    await 눌러('open-online', 0);
    await 화면기다리기('online');
    살펴본다('로비', 'online', true);
    // 로비를 불러오는 동안 단 «연결 중…»이 남으면 홈에 돌아왔을 때 입구가 계속 바쁜 척한다 (U34)
    const 온라인입구 = document.getElementById('open-online');
    결과.push({
      자리: '로비', 이름: '홈 온라인 입구의 바쁨 표시를 거뒀다',
      통과: !온라인입구.hasAttribute('aria-busy')
        && document.getElementById('open-online-desc').textContent.trim() === '친구와 함께 · 2명부터',
      무엇: `aria-busy ${온라인입구.getAttribute('aria-busy') ?? '없음'} · ${document.getElementById('open-online-desc').textContent.trim()}`,
    });
    const 로비터치크기 = ['online-home', 'room-filter-toggle', 'room-refresh']
      .map((id) => [id, document.getElementById(id).getBoundingClientRect()]);
    프레임돌리기();
    결과.push({
      자리: '로비', 이름: '반복 조작의 터치 목표가 44px 이상이다',
      통과: 로비터치크기.every(([, 크기]) => 크기.width >= 44 && 크기.height >= 44),
      무엇: 로비터치크기.map(([id, 크기]) => `${id} ${크기.width}px × ${크기.height}px`).join(' · '),
    });
    const 로비동작이름 = [...document.querySelectorAll('.online-action-card__body strong')];
    결과.push({
      자리: '로비', 이름: '세 주요 동작의 이름이 좁은 화면에서도 8px 이상 여유를 둔다',
      통과: 로비동작이름.every((이름) => 이름.clientWidth - 글자너비(이름) >= 8),
      무엇: 로비동작이름.map((이름) =>
        `${이름.textContent.trim()} 여유 ${(이름.clientWidth - 글자너비(이름)).toFixed(1)}px`).join(' · '),
    });
    const 온라인안내 = document.getElementById('online-note');
    const 온라인캐릭터 = document.getElementById('online-character');
    const 겹친온라인글 = 겹친글자줄(온라인안내, 온라인캐릭터.getBoundingClientRect());
    결과.push({
      자리: '로비', 이름: '주차한 캐릭터가 연결 안내 글을 덮지 않는다',
      통과: 겹친온라인글.length === 0,
      무엇: `겹친 글자 줄 ${겹친온라인글.length}개`,
    });
    // ⑬ 이 브라우저 안의 방(로컬)일 때 보이는 안내다. 개발 용어로 말하지 않는다
    결과.push({
      자리: '로비', 이름: '연결 안내 문구에 «서버»·API 같은 개발 용어가 없다',
      통과: !/서버|API|snapshot/i.test(온라인안내.textContent),
      무엇: 온라인안내.textContent.trim(),
    });
    const 설정버튼위치 = getComputedStyle(document.querySelector('.app-bar')).position;
    결과.push({
      자리: '로비', 이름: '짧은 가로에서는 설정 버튼이 스크롤 동작을 덮지 않고 문서와 함께 흐른다',
      통과: innerHeight > 480 || 설정버튼위치 === 'absolute',
      무엇: `높이 ${innerHeight}px · position ${설정버튼위치}`,
    });
    잠든퀴즈를깨워본다('로비');

    // ⑭ 설정은 어느 화면에서나 열린다. 로비의 Esc 는 «홈으로»라, 대화상자를 닫는 Esc 가 새면 홈으로 튕긴다
    await 눌러('open-settings', 300);
    포커스에서키('Escape');
    await 잠깐(300);
    결과.push({
      자리: '로비', 이름: '설정 대화상자의 Esc 는 대화상자만 닫고 화면은 그대로다',
      통과: document.getElementById('settings-dialog').hidden && 지금화면() === 'online',
      무엇: `화면 ${지금화면()} · 설정 ${document.getElementById('settings-dialog').hidden ? '닫힘' : '!! 열림'}`,
    });

    // ⑥ 키의 임자. 넷이 함께 서야 한다 — 하나를 고치면 다른 셋이 깨지곤 했다
    const 키를보낸다 = (키, 옵션 = {}) => {
      const 이벤트 = new KeyboardEvent('keydown', { key: 키, bubbles: true, cancelable: true, ...옵션 });
      document.dispatchEvent(이벤트);
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 키, bubbles: true }));
      return 이벤트.defaultPrevented;
    };

    // 걷기 키(s·←)와 겹치는 브라우저 단축키를 워커가 먹으면 저장·뒤로 가기가 죽는다.
    // 짝인 «발밑이 비면 Space로 스크롤된다»는 빈자리에서 시작함이 보장된 결과 화면에서 본다
    const 단축키를가로챘나 = 키를보낸다('s', { ctrlKey: true });
    결과.push({
      자리: '로비', 이름: 'Ctrl+S를 워커가 가로채지 않는다',
      통과: !단축키를가로챘나,
      무엇: 단축키를가로챘나 ? '!! 워커가 가로챈다' : '브라우저 것이다',
    });
    // ⑬ 조작법과 무대 안내가 «방향키·WASD»라고 말한다. 맨 d 는 캐릭터 몫이어야 한다
    const 걷기키를받았나 = 키를보낸다('d');
    결과.push({
      자리: '로비', 이름: '조작법이 말하는 WASD도 캐릭터가 받는다',
      통과: 걷기키를받았나,
      무엇: 걷기키를받았나 ? '캐릭터가 받는다' : '!! 아무도 안 받는다',
    });

    // 체크박스에서 Space 는 체크박스 것이다. 워커가 가로채면 preventDefault 가
    // 기본 동작까지 죽여 키보드만 쓰는 사람은 「비공개로 만들기」를 켤 수 없다
    // 주요 동작은 탭처럼 본문 하나만 열므로, 검사할 입력이 있는 본문부터 연다.
    await 눌러('open-create-room', 250);
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
    await 눌러('open-private-join', 250);
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

    await 눌러('open-create-room', 250);
    const 이름칸 = document.getElementById('create-name');
    // 값처럼 보이는 placeholder만 두면 비운 채 만들다 거절당했다 (U41)
    결과.push({
      자리: '로비', 이름: '방 이름이 «닉네임의 방»으로 채워져 있다',
      통과: 이름칸.value.trim().endsWith('의 방'),
      무엇: 이름칸.value || '(비어 있음)',
    });
    이름칸.value = '점검용 방';
    document.getElementById('create-form').requestSubmit();
    await 화면기다리기('waiting');
    살펴본다('대기실', 'waiting', true);

    // **「게임 시작」 직후에 나간다.** 판을 여는 것은 되돌아온 이벤트를 보고
    // 하는 일이라 비동기다. 그 사이에 나가면 세션만 남을 수 있다 (#64)
    document.getElementById('waiting-start').click();
    document.getElementById('waiting-leave').click();
    await 화면기다리기('online');
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
    if (랭킹백업 === null) localStorage.removeItem('quiz.rankings');
    else localStorage.setItem('quiz.rankings', 랭킹백업);
    if (설정백업 === null) localStorage.removeItem('quiz.settings');
    else localStorage.setItem('quiz.settings', 설정백업);
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
  console.log('방 목록·랭킹·설정은 되돌려 놓았습니다.');
  return { 검사: 결과.length, 실패: 실패.length };
})();
