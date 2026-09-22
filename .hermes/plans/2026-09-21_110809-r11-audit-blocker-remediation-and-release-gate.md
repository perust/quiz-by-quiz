# R11 Audit-Blocker Remediation and Release-Gate Plan

> **For Hermes:** Execute this plan task-by-task with causal RED→GREEN tests and independent current-byte review. Do not commit or release without explicit authorization.

**Goal:** Fix all six R10 successor-audit blocker leads, regenerate an exact R11 evidence chain, and reach at most `GO CANDIDATE / release authority NONE`.

**Architecture:** Preserve the existing FastAPI/PostgreSQL/REST-authoritative/WSS-invalidation design. Add explicit UI ownership tokens, bounded socket admission and lifecycle revalidation, bounded limiter state, and non-URL WSS ticket transport. Keep the public Pages artifact and private online bank separated. Replace long monolithic semantic audits with exact smaller Read-only shards and deterministic controller reconciliation.

**Tech Stack:** TypeScript, browser WebSocket API, Node test runner, Python 3.13, FastAPI/Starlette/Uvicorn, PostgreSQL, Docker/Compose, Caddy, GitHub Actions, Claude Code first-party Opus5/max Read-only audit streams.

---

## Non-negotiable constraints

- Worktree: `/opt/data/worktrees/quiz-by-quiz-online-rooms`; branch: `feat/online-rooms`.
- Production/shared Caddy, PostgreSQL, n8n, BTC, and platform Compose are out of scope; no restart/reload/migration/activation.
- Oracle work uses only task-labelled disposable roots, containers, networks, volumes, and images; no host ports.
- Private bank remains `/opt/data/.private/quiz-by-quiz-online-bank-2026-09-18`; public `data/` is never authoritative for online answers.
- REST snapshots remain authoritative; WSS carries invalidation/chat only.
- Uvicorn remains factory mode, one worker, and no access log; add warning-level runtime logging so normal WSS handshakes cannot log ticket material.
- No commit, push, PR, merge, Pages publish, or production action without separate explicit authorization.
- Any source or private-bank byte change invalidates R10 release evidence for R11.
- A raw/model/parser/transport failure is `NO_VERDICT`, not PASS or FAIL.

## Task 1: Close R10 fail-closed and bind R11 scope

**Files:**
- Modify: `/opt/data/checkpoints/quiz-by-quiz-online-2026-09-18-production-deployment-gate.md`
- Create: `.hermes/plans/2026-09-21_110809-r11-audit-blocker-remediation-and-release-gate.md`

**Steps:**
1. Preserve R10 stream hashes and classify server R1, client R1, and server R2 as invalid/no-verdict for their exact model/protocol violations.
2. Preserve private-bank as the only formal R10 semantic PASS.
3. Record six independently source-confirmed blockers and skip the R10 browser gate.
4. Verify R10 post-audit source/private-bank byte identity and `git diff --check` before any R11 edit.

**Expected:** `R10 RELEASE BLOCKED`, release authority `NONE`.

## Task 2: Prevent stale match recovery from stealing navigation

**Files:**
- Modify: `src/app.ts`
- Modify: `tests/match-recovery.test.mjs`
- Modify: `tests/waiting-room-recovery-race.test.mjs`

**RED tests:**
1. Use a deferred `getMatch`; change the ownership generation before resolution; assert `openMatch` is never called.
2. Assert `resumeActiveNetworkMatch` accepts/captures an entry generation and its `isStillCurrent` callback checks `isCurrentWaitingRoomEntry`, not only `activeRoomCode`.
3. Assert `openWaitingRoom` passes its `entryGeneration`; socket invalidation captures the current generation at invocation.

**GREEN implementation:**
- Bind every recovery to `{code, entryGeneration, waitingRoomEntryGeneration, activeRoomCode, onlineMatchRoomCode}`.
- A Home/lobby/final/exit/new-room navigation must invalidate the continuation before it calls `openOnlineMatch`.
- Preserve REST-only match-state decisions and duplicate-recovery suppression.

**Commands:**
```bash
npm run build
node --test tests/match-recovery.test.mjs tests/waiting-room-recovery-race.test.mjs
```

## Task 3: Give every waiting-room async action explicit ownership

**Files:**
- Modify: `src/ui/waiting-room.ts`
- Modify: `tests/waiting-room-show-ownership.test.mjs`
- Modify or create: `tests/waiting-room-action-ownership.test.mjs`

**RED tests:**
1. Start a room-A update/ready/start/leave/chat operation, hide or show room B, resolve room A, and assert no room-A render, notice, leave callback, input clear, or blur occurs in room B.
2. Deliver a newer same-room subscription snapshot before an older update/ready response; assert the older response cannot overwrite it.
3. Type additional chat text while send is pending; assert the later text is not cleared or blurred.

**GREEN implementation:**
- Store the current `showGuard` request token as the visible room session.
- Capture `{request, code, roomSnapshot}` before each await.
- Require current request + current code for session side effects; additionally require the same snapshot before committing update/ready/start results or notices.
- On chat success, clear/blur only when the session still owns the screen and the input still equals the submitted text.
- `hide()` invalidates and clears ownership before unsubscribing.

## Task 4: Isolate PR verification from deploy concurrency

**Files:**
- Modify: `.github/workflows/pages.yml`
- Create: `tests/pages-workflow-concurrency.test.mjs`

**RED test:** assert workflow-level `concurrency` is absent and the `deploy` job alone owns `group: pages` with `cancel-in-progress: false`.

**GREEN implementation:** move concurrency under `jobs.deploy`. PR verify jobs can no longer replace a pending main deploy; newer main deploys may supersede older pending deploys while a running deploy remains protected.

**Command:**
```bash
node --test tests/pages-workflow-concurrency.test.mjs
```

## Task 5: Make single-window limiter retention provably bounded

**Files:**
- Modify: `server/app/rate_limit.py`
- Modify: `server/tests/test_rate_limit.py`
- Modify: `server/app/main.py`
- Modify relevant API tests in `server/tests/test_api.py` and `server/tests/test_match_api.py`

**RED tests:**
1. Keep the first 64 keys live, create many later keys, advance past their window, trigger cleanup, and assert all expired later keys are reclaimed.
2. Add a `retained_key_count` contract for `SlidingWindowLimiter`.
3. Rotate actor/room keys and prove process-level admission bounds prevent unbounded live-key creation for chat, answer, and ticket paths.

**GREEN implementation:**
- Prune all expired keys correctly; do not scan a permanently pinned prefix.
- Prefer the existing atomic multi-window limiter for actor-room + process claims so rejected unique keys create no retained state.
- Keep current per-actor behavior unless a documented process ceiling requires only stricter global admission.

## Task 6: Bound EventHub and terminate former-member sockets

**Files:**
- Modify: `server/app/main.py`
- Modify: `server/tests/test_api.py`
- Modify: `server/tests/test_match_api.py`
- Modify: `deploy/oracle/README.md`
- Modify: `server/tests/test_deploy_contract.py`

**RED tests:**
1. Exceed per-actor/room, per-room, and process socket caps; assert close code `4429` and no retained connection.
2. Leave a room while connected; assert immediate close `4403` and no further chat/room/match events.
3. Simulate cleanup removing membership, run cleanup revalidation, and assert former members are closed.
4. Assert broadcast fan-out is bounded/concurrent and failed or blocked sockets are removed without serially stalling all peers.

**GREEN implementation:**
- Track actor ID with each socket and enforce explicit one-worker caps before acceptance.
- Disconnect all actor-room sockets immediately after successful leave.
- After each successful 60-second resource cleanup, revalidate bounded unique actor-room memberships and close false memberships.
- Fan out with a short per-send timeout and concurrent gather; remove failed sockets.
- Document cap arithmetic within `384m` and the one-worker dependency.

## Task 7: Remove WSS ticket material from URLs and normal logs

**Files:**
- Modify: `src/online/network-rooms.ts`
- Modify affected Node network tests
- Modify: `server/app/main.py`
- Modify: `server/app/tickets.py`
- Modify: `server/tests/test_api.py`
- Modify: `server/tests/test_match_api.py`
- Modify: `server/tests/test_tickets.py`
- Modify: `server/Dockerfile`
- Modify: `server/tests/test_runtime_dockerfile_contract.py`
- Modify: `deploy/oracle/Caddyfile.quiz-by-quiz`
- Modify: `deploy/oracle/README.md`
- Modify deploy contract tests as needed

**RED tests:**
1. Client socket URL contains no `ticket` query; ticket is passed in a WebSocket subprotocol token.
2. Server accepts only the expected public protocol plus one syntactically valid ticket protocol and selects only the public protocol.
3. A room-mismatched ticket is consumed and cannot be retried.
4. Runtime command includes `--log-level warning` in addition to `--no-access-log`.
5. Captured normal accepted/rejected handshake logs do not contain ticket bytes or query strings.

**GREEN implementation:**
- Extend `webSocketFactory(url, protocols)` and send `['qbb.v1', 'qbb.ticket.<token>']` with a query-free URL.
- Parse a single ticket protocol, consume it once regardless of room match, and accept only `qbb.v1`.
- Keep Caddy event-route log suppression as defense in depth but update its comment to reflect header transport.
- Run Uvicorn at warning log level.

## Task 8: Full local validation and independent current-byte review

**Commands:**
```bash
cd server
.venv/bin/ruff check app tests
.venv/bin/python -m pytest -q
.venv/bin/python -m compileall -q app tests
cd ..
npm run check
npm run build
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -v
python3 tools/check_bank.py
git diff --check
```

**Review lanes:**
- Client ownership/recovery/workflow.
- Limiter retention/process claims.
- EventHub membership/caps/fan-out.
- Ticket transport/logging/deploy envelope.

No review timeout. A timeout has no verdict. Apply findings with new RED tests before proceeding.

## Task 9: Freeze R11 and run exact disposable Oracle proof

1. Remove task-owned caches only; never alter private-bank bytes.
2. Create deterministic source/private-bank full manifests and archives in a fresh canonical root, modes `0700/0600`.
3. Independently replay and prove byte equality.
4. Transfer exact artifacts to a fresh task-owned Oracle stage.
5. Verify migrations 001–009, runtime-role boundaries, full relevant PostgreSQL tests, exact `384m`/one-worker/no-host-port/read-only-bank envelope, limiter cardinality, WSS cap/lifecycle, query-free ticket transport/log silence, cleanup, and `/readyz` after bursts.
6. Preserve complete private log and verify its expected semantic markers plus SHA. Cleanup task resources to zero.

## Task 10: Run sharded Opus5-only Read-only successor audit

- Use small exact shards (target ≤12–15 paths and below the external progress-status interval), each with unique card/stream/stderr/rc artifacts.
- Example shards: server authority; server resource bounds; schema/PostgreSQL; deploy/logging; client recovery/actions; client network protocol; Pages/workflow; private bank.
- Every shard must have exact preamble, only declared Read calls, no extra text, first final physical line `VERDICT: PASS`, `FINDINGS: - NONE`, exact reviewed-path set/order, current source/bank binding, final scope line, first-party `claude-opus-5`, rc0, empty stderr, and strict replay.
- A deterministic controller—not an LLM summary—requires all shards PASS and complete union coverage. Any fallback, progress text, missing read, or parser failure is `NO_VERDICT` and rerun with a fresh artifact name.

## Task 11: Exact browser gate, no-mutation, and reconciliation

1. Only after every proof/audit shard passes, build the exact frozen Pages artifact in a temporary copy.
2. Change only that copy's API meta value to a localhost SSH tunnel targeting the task-owned exact Oracle API; do not mutate source.
3. Run the complete `tools/check-screens.js` through the configured network adapter; require zero failed checks, successful room create/waiting/WSS transitions, no uncaught browser errors, and preserve full console + screenshot evidence.
4. Remove local/Oracle browser resources; verify exact task labels have zero residue.
5. Re-run source/private-bank freeze replay and `git diff --check`.
6. Reconcile to `GO CANDIDATE / release authority NONE` only if every gate passes; otherwise `RELEASE BLOCKED`.
