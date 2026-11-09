# 공통 접근성·랭킹 책임 경계 개선 구현 계획

> **For Hermes:** 기존 task graph와 Oracle 실행 경로를 따르고, 구현 writer는 이 카드 한 명으로 유지한다. 구현 완료 뒤에는 이미 연결된 독립 release/검증 카드가 exact candidate를 검토한다.

**Goal:** 사용자에게 보이는 동작을 바꾸지 않고 공통 포커스 가두기의 소유권을 접근성 모듈로 옮기며, 랭킹 행의 안전한 공통 표시 조각만 최소 추출하고, 워커의 공유 생명주기 경계는 근거 없이 분할하지 않는다.

**Architecture:** src/ui/accessibility.ts가 focusable selector와 trapFocus를 단독 소유하고 모든 대화상자 consumer가 그 모듈을 직접 참조한다. arena.ts와 online-quiz.ts의 불필요한 함수 주입, app.ts의 중계, quiz.ts의 호환 재수출은 제거한다. 랭킹은 서로 다른 로컬/온라인 모델을 합치지 않고 화면에 공통인 텍스트 cell 생성만 공유한다.

**Tech Stack:** TypeScript strict ES modules, Node node:test, fake DOM regression tests, npm/tsc. 모든 저작·실행은 Oracle working tree에서 한다.

---

## 현재 기준과 결정

- Base commit: 02d01b65be3a2ba8c339ccaec2ac1437e2591c09
- Base tree: 1cd6ae674bfbecde641ee81493bb8fba37a4c817
- Working tree: /home/ubuntu/dev/quiz-by-quiz-component-boundaries-20261109
- Branch: task/t_6bdc66d4-component-boundaries
- trapFocus의 실제 consumer는 quiz.ts, home.ts, ranking.ts, rules-dialog.ts, settings-dialog.ts, waiting-room.ts, arena.ts, online-quiz.ts다. app.ts는 현재 quiz.ts에서 가져와 온라인 퀴즈로 중계한다.
- Tab/Shift+Tab wrapping만 공통 helper가 맡고 Escape, 닫기, opener focus 복원은 각 dialog owner가 계속 맡는다.
- CSS와 마크업은 변경하지 않는다.

### 랭킹 결정

로컬과 온라인 행은 공통으로 순위·닉네임·선택적 badge·점수/정답수·날짜를 textContent로 만든다. 온라인 전용 character와 isMine, 서버 rank, 로컬 전용 index rank와 방금 등록은 각 caller가 계속 소유한다. raw 모델을 공통 타입으로 합치지 않고 primitive view 값으로 공통 cell을 만드는 작은 helper만 추출하면 중복과 XSS 안전 경로를 동시에 한 곳에 유지할 수 있다.

### 워커 결정

이번 변경에서는 src/ui/walker.ts를 분할하지 않는다. 모듈 전역 held, 단일 active, createWalkControls instance, focusin/focusout, capture-phase Escape, keyup, window blur/resize/scroll listener가 개별 Walker의 enable/disable·animation frame·selection state와 한 생명주기를 이룬다. 기계적 파일 분리는 owner를 둘로 만들거나 listener teardown/중복 등록을 새로 설계해야 하며 현재 동작 이득 없이 동시 touch·key·focus·screen transition 위험만 늘린다. 후속 분리는 먼저 하나의 global input coordinator를 명시적 생성/teardown API로 설계하고 멀티워커 전환·pointer cancel·동시터치·blur/focus 회귀를 독립 테스트할 수 있을 때만 한다.

## Task 1: 공통 focus trap의 RED 계약 만들기

**Objective:** 새 접근성 모듈의 공개 동작과 owner 경계를 구현 전에 고정한다.

**Files:**
- Create: tests/accessibility.test.mjs
- Modify later: tests/quiz-interface.test.mjs

1. fake container와 focusable nodes로 패널 밖에서 Tab→첫 조작부, Shift+Tab→마지막 조작부, 양 끝 wrapping, 중간 기본 동작, hidden node 제외를 검증한다.
2. 새 모듈 ../js/ui/accessibility.js를 import하게 한다.
3. npm run build && node --test tests/accessibility.test.mjs를 실행해 expected module-missing RED를 기록한다. 기존 behavior baseline은 tests/settings-dialog.test.mjs의 Tab/Escape/focus restore 사례로 별도 확인한다.

## Task 2: 접근성 owner를 최소 구현하고 모든 consumer를 직접 연결하기

**Objective:** quiz 화면의 우연한 소유권과 app/arena dependency plumbing을 제거하면서 동작을 보존한다.

**Files:**
- Create: src/ui/accessibility.ts
- Modify: src/ui/quiz.ts
- Modify: src/ui/arena.ts
- Modify: src/ui/online-quiz.ts
- Modify: src/ui/home.ts
- Modify: src/ui/ranking.ts
- Modify: src/ui/rules-dialog.ts
- Modify: src/ui/settings-dialog.ts
- Modify: src/ui/waiting-room.ts
- Modify: src/app.ts
- Modify: tests/quiz-interface.test.mjs

1. 기존 FOCUSABLE와 trapFocus 구현을 byte-equivalent logic으로 새 모듈에 옮긴다.
2. 각 직접 consumer가 ./accessibility.js에서 import하도록 바꾼다.
3. ArenaDeps.trapFocus, OnlineQuizScreenDeps.trapFocus, createArena/createOnlineQuizScreen destructuring과 call-site forwarding을 제거한다.
4. quiz.ts의 export/alias를 남기지 않고 app.ts는 더 이상 trapFocus를 import하거나 전달하지 않게 한다.
5. focused accessibility test와 settings/quiz interface tests를 GREEN으로 실행한다.

## Task 3: 랭킹의 공통 표시 cell만 추출하기

**Objective:** 서로 다른 데이터 계약과 DOM 차이를 유지하면서 반복된 안전한 텍스트 렌더링을 한 곳에 둔다.

**Files:**
- Modify: src/ui/ranking.ts
- Modify: tests/ranking-online-view.test.mjs only if stronger malicious-text fixture/assertion is needed

1. 현재 local/online row tests를 baseline으로 실행한다.
2. rank, nickname, optional badge, score/hits, formatted date cell을 textContent로 생성하는 작은 local helper를 만든다.
3. 로컬은 방금 등록, caller-generated rank, 기존 DOM order를 유지한다.
4. 온라인은 character figure, server rank, 나, mine class, 기존 DOM order를 유지한다.
5. HTML-like nickname이 markup이 아니라 literal text로 남는 사례와 관련 ranking tests를 재실행한다.

## Task 4: 최종 검증과 전달

1. Focused: accessibility/settings/quiz/home/ranking/online/walker 관련 node --test.
2. npm run check.
3. npm run build.
4. Full frontend: node --test tests/*.test.mjs.
5. Project checks: python3 -m unittest discover -s tests -v와 python3 tools/check_bank.py.
6. git diff --check, explicit changed-file review, generated js와 CSS 변경 없음 확인.
7. Oracle browser runtime에서 로컬 정적 서버를 띄워 설정·게임 방법·닉네임·랭킹/나가기 대화상자의 Tab/Shift+Tab, Escape, opener focus 복원과 console error를 확인한다. viewport/CSS 변화가 없으므로 pixel/CSS snapshot은 요구하지 않는다.
8. 최신 public main이 base와 같은지 다시 확인하고, 달라졌다면 rebase 후 decisive checks를 다시 실행한다.
9. explicit allowlist로 commit하고 authorized transport로 push/PR 생성, exact-head required CI를 확인한다. merge/Pages/live 검증은 연결된 독립 release 카드가 맡는다.

## Risks and preservation contracts

- focus selector, hidden filtering, preventDefault 조건과 Tab 방향을 변경하지 않는다.
- Escape와 opener focus restoration은 helper로 끌어올리지 않는다. 각 dialog의 상태 owner가 유지한다.
- 랭킹은 innerHTML을 쓰지 않고 모든 외부 nickname/숫자를 textContent로 쓴다.
- walker, CSS, backend, DB, dependency, CI policy, production state는 변경하지 않는다.
- 배포 완료는 PR/CI가 아니라 독립 검토자의 merge→Pages→public runtime exact-revision 확인 뒤에만 선언한다.
