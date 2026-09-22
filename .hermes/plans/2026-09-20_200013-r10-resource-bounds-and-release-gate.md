# R10 Resource Bounds and Release Gate Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Repair the two valid R9 server/deploy audit blockers with explicit, test-proven resource bounds, then produce a wholly new R10 validation/freeze/proof/audit/browser-gate evidence chain without any release action.

**Architecture:** Put Argon2 work behind a bounded admission executor whose parameters are tied to the 384 MiB/one-worker runtime contract. Replace independently keyed abuse limits with an atomic hierarchical limiter, bound player lifetime and periodic cleanup, and select a bounded set of rooms before joining member rows. Preserve the browser-generated identity protocol and current REST payloads; no production activation or public-client migration is required.

**Tech Stack:** Python 3.13, FastAPI/Starlette, argon2-cffi 25.1, asyncio/threadpool, PostgreSQL/psycopg, pytest, TypeScript/Vite, Docker/Compose, Caddy, Oracle ARM disposable containers.

---

## 1. Scope and frozen decisions

### Current evidence

- R9 local validation, canonical freeze, and exact Oracle R4 proof passed.
- Fresh R9 server/deploy audit raw first line was `VERDICT: FAIL`.
- Client/Pages and private-bank successor audits passed.
- R9 artifacts remain historical evidence only. Any source change starts R10 and invalidates all R9 release binding.

### R10 resource policy

These values are part of the candidate contract and must be visible in code, tests, and deployment documentation:

| Resource | Bound |
| --- | --- |
| Argon2 parameters | Explicitly pin current profile: `memory_cost=65_536 KiB`, `time_cost=3`, `parallelism=4`, `hash_len=32`, `salt_len=16` |
| Argon2 active work | 2 jobs, therefore at most 128 MiB of Argon2 memory allocation |
| Argon2 admitted work | 6 total: 2 running + at most 4 waiting; excess fails immediately with HTTP 429 and `Retry-After: 1` |
| Session registration | 60/client/minute and 300/process/minute, atomically admitted |
| Room creation | 10/actor/hour, 30/client/hour, and 100/process/hour, atomically admitted |
| Password join attempts | retain 10/client+room/minute and add 120/process/minute before Argon2 admission |
| Player expiry | 2 hours, refreshed by valid session activity |
| Resource cleanup sweep | every 60 seconds, independent of lobby reads |
| Lobby response | at most 100 rooms; actor-joined rooms rank before other newest rooms; all members of every selected room remain complete |

The process-global limit is valid only because the deploy contract fixes exactly one Uvicorn worker. A worker-count change requires re-review.

### Non-goals

- Do not redesign the browser identity/token protocol.
- Do not add Redis, a second service, CAPTCHA, account login, or a new public API.
- Do not change question-bank contents.
- Do not increase the 384 MiB API limit merely to hide the blocker.
- Do not commit, push, create a PR, merge, publish Pages, or activate production without separate explicit approval.

## 2. Pre-change R10 preregistration

**Files:**
- Update during execution: `/opt/data/checkpoints/quiz-by-quiz-online-2026-09-18-production-deployment-gate.md`
- Preserve: `/opt/data/.private/quiz-by-quiz-r9-successor-audit-20260920.cP5zsu/`
- Preserve: `/opt/data/.private/qbbv-r9-proof-S7k7BK-r4.log`

**Steps:**

1. Record the policy table above, exact intended files, RED test names, stopping conditions, and `release authority: NONE` in the checkpoint.
2. Re-run the R9 independent freeze verifier before the first source write so the R9 evidence closes cleanly.
3. Capture branch, HEAD, and pre-change `git status --short` without staging or committing.
4. Create R10 todos for remediation, local validation, freeze/proof, successor audit, browser gate, and final reconciliation.

**Stop if:** R9 custody no longer matches, unexpected worktree changes appear, or the requested scope differs from the two raw audit findings.

## 3. Bounded Argon2 execution — strict TDD

**Objective:** Prove both memory-concurrency and waiter-count bounds before routing any endpoint through them.

**Files:**
- Create: `server/app/password_work.py`
- Create: `server/tests/test_password_work.py`
- Modify after RED: `server/app/main.py:301-306,422-425,454-479`
- Extend: `server/tests/test_api.py:165-272`

### RED 3.1 — active jobs never exceed two

1. Define a blocking fake hasher that records active and maximum concurrent calls under a `threading.Lock`.
2. Start six async hash/verify calls against the wished-for `BoundedPasswordWork` API.
3. Hold the worker threads with an event and assert exactly two enter the hasher while no third enters.
4. Run:

```bash
cd server
./.venv/bin/python -m pytest tests/test_password_work.py::test_password_work_runs_at_most_two_argon_jobs -q
```

**Expected RED:** import/API missing, not a setup error.

### GREEN 3.1

Implement `BoundedPasswordWork` with:

- explicit `PasswordHasher(time_cost=3, memory_cost=65_536, parallelism=4, hash_len=32, salt_len=16)` when no hasher is injected;
- `max_active=2`, `max_inflight=6` defaults;
- a short async lock protecting the in-flight counter;
- immediate `PasswordWorkBusy` before queueing when six calls are already admitted;
- an `asyncio.Semaphore(2)` around `run_in_threadpool`;
- `finally`-based release of both the active slot and in-flight admission on success, mismatch, cancellation, or exception.

Run the targeted test until GREEN.

### RED/GREEN 3.2 — admission overflow and cancellation

Add separate tests proving:

- calls 1–2 execute, calls 3–6 may wait, call 7 fails immediately with `PasswordWorkBusy`;
- cancellation of a waiter returns its admission slot;
- a hasher exception returns all slots;
- successful hash and verify results are passed through unchanged.

Run all `test_password_work.py` tests after each cycle.

### RED/GREEN 3.3 — endpoint mapping

Add API tests proving:

- private-room creation and private-room join use the bounded executor;
- saturation maps to HTTP 429, detail code `rate-limited`, and `Retry-After: 1`;
- no repository create/join occurs when password work is rejected;
- `VerifyMismatchError`, `VerificationError`, and `InvalidHashError` still map only to `wrong-password`.

Then replace direct `run_in_threadpool(hasher.hash/verify, ...)` calls in `main.py` with the bounded executor. Do not alter public room creation or already-member re-entry behavior.

## 4. Atomic hierarchical rate limits — strict TDD

**Objective:** Bound identity and room-creation rates without actor rotation bypass or partial consumption between dimensions.

**Files:**
- Modify after RED: `server/app/rate_limit.py`
- Modify after RED: `server/app/main.py:304-309,372-425,442-479`
- Modify: `server/tests/test_rate_limit.py`
- Modify: `server/tests/test_api.py`

### RED 4.1 — atomic multi-window admission

Add tests for a wished-for `HierarchicalWindowLimiter`/`WindowRule` interface:

- one request appends to all named dimensions atomically;
- if any dimension is full, none of the other dimensions consumes quota;
- windows with different limits/durations expire independently;
- stale key cleanup does not remove live queues;
- rejected floods do not create per-actor/per-client entries after the global bucket is saturated.

Run:

```bash
cd server
./.venv/bin/python -m pytest tests/test_rate_limit.py -q
```

Confirm the new tests fail for the missing behavior.

### GREEN 4.1

Implement the minimal thread-safe limiter using one lock and queues keyed by `(dimension, key)`. Clean all requested queues, reject without mutation if any is full, otherwise append the same timestamp to every queue. Keep `SlidingWindowLimiter` for unaffected endpoints unless replacing it is demonstrably simpler.

### RED/GREEN 4.2 — identity rotation cannot bypass create limits

Enhance `FakeRepository` in `server/tests/test_api.py` to store arbitrary registered identity hashes while retaining the existing `authenticated=False` behavior.

Add API tests proving:

- 31 different actors behind one client identity can create only 30 rooms/hour;
- one actor remains capped at 10/hour;
- different client keys collectively stop at 100 room creations/hour;
- session registration stops at 60/client/minute and 300/process/minute;
- private password attempts stop at both 10/client+room/minute and 120/process/minute before Argon2 admission.

Use public rooms for room-rate tests so Argon2 is not part of those assertions. Generate valid UUID/token headers and fixed `X-Forwarded-For` values; do not weaken `_client_key` or its Caddy boundary.

### GREEN 4.2

Wire exact rules:

- session: client + global;
- create: actor + client + global;
- private password check: client+room + global;

Use stable dimension names and constant global keys. Keep the one-worker deployment requirement explicit.

## 5. Player TTL and periodic cleanup — strict TDD

**Objective:** Make stored identity cardinality a rate × TTL bound and remove reliance on `GET /v1/rooms` to trigger cleanup.

**Files:**
- Create: `server/migrations/009_bound_online_resource_lifetimes.sql`
- Create: `server/tests/test_resource_bounds_schema_contract.py`
- Modify after RED: `server/app/postgres.py:39-43,118-177,1197-1258`
- Modify after RED: `server/app/repository.py:150-212`
- Modify after RED: `server/app/main.py:311-338`
- Modify: `server/tests/test_api.py`
- Modify: `server/tests/test_match_api.py`
- Extend: `server/tests/test_postgres_integration.py`

### RED 5.1 — migration contract

Add schema-contract tests requiring migration 009 to:

- run inside `BEGIN`/`COMMIT`;
- change the players `expires_at` default to two hours;
- clamp existing longer expiries with `LEAST(expires_at, now() + interval '2 hours')`;
- insert schema migration version 9 idempotently;
- avoid new grants, roles, extensions, tables, or credential material.

Run the targeted file and confirm RED.

### GREEN 5.1

Write only the required migration. Do not edit historical migration 001.

### RED/GREEN 5.2 — repository lifetime and cleanup

Add tests requiring:

- both `upsert_player` and successful `authenticate` refresh expiry by exactly `_PLAYER_LIFETIME = "2 hours"`;
- `cleanup_expired_resources()` is part of `RoomsRepository`;
- unreferenced expired players are deleted;
- players referenced by a live room/member or unexpired match remain;
- expired rooms/members/matches are cleaned by the existing safe ordering.

Implement `PostgresRoomsRepository.cleanup_expired_resources()` as the public entry to the existing transaction-safe cleanup path. Preserve foreign-key-safe ordering.

### RED/GREEN 5.3 — periodic sweep

Add a test-injectable sweep interval to `create_app` (production default 60 seconds) and prove:

- cleanup runs without a lobby request;
- a transient cleanup failure is logged and does not terminate the API lifespan;
- cancellation completes before `repo.close()`;
- match-expiry and resource-cleanup tasks remain independent.

Add no always-on local QA process; this task exists only inside the API lifespan.

## 6. Bound lobby materialization without truncating members — strict TDD

**Objective:** Return at most 100 rooms while keeping every selected room's player list complete.

**Files:**
- Modify after RED: `server/app/postgres.py:47-83,179-190,850-867`
- Modify: `server/tests/test_postgres_sql_contract.py`
- Extend: `server/tests/test_postgres_integration.py`

### RED 6.1 — SQL shape

Require `_ROOM_ROWS_SQL` to select room IDs in a CTE/subquery before the member join:

- filter unexpired rooms and optional exact code/member requirement inside the selection;
- order actor-joined rooms first, then `created_at DESC`, then a stable room-ID tie-breaker;
- apply `LIMIT %(room_limit)s` to rooms, not joined rows;
- join members only after selection;
- preserve deterministic member order.

Pass `room_limit=100` from `list_rooms` and `room_limit=1` from exact `_fetch_room`.

### RED/GREEN 6.2 — real PostgreSQL behavior

In the disposable integration database, seed more than 100 rooms and at least one 12-member selected room. Prove:

- `list_rooms` returns exactly 100 room objects;
- an actor's joined older room is included ahead of unjoined rooms;
- the 12-member room contains all 12 players (no joined-row truncation);
- exact `get_room` still returns the requested room independent of lobby ranking.

Implement the CTE and run the targeted integration test under `TEST_DATABASE_URL` in the later disposable PostgreSQL stage.

## 7. Deployment and documentation contract

**Files:**
- Modify: `server/tests/test_deploy_contract.py`
- Modify: `deploy/oracle/README.md`
- Modify if needed: `README.md`
- Do not raise: `deploy/oracle/compose.quiz-by-quiz.yaml:65` (`mem_limit: 384m`)
- Do not change: `server/Dockerfile` one-worker/no-access-log contract unless a test reveals a necessary documentation-only mismatch.

**RED first:** Add deploy-contract assertions for one worker, `384m`, explicit two-job/128-MiB Argon2 policy, bounded in-flight work, hierarchical limits, 2-hour identity TTL, 60-second cleanup, and 100-room lobby cap.

**GREEN:** Document:

- why 2 × 64 MiB is selected under 384 MiB;
- why excess password work returns 429 rather than queueing without bound;
- rate × TTL steady-state formulas (players ≤ 300/min × 120 min = 36,000 unreferenced live rows; newly created rooms ≤ 100/hour × 24 hours = 2,400 before activity extensions, under periodic cleanup);
- that active referenced rows may outlive the base TTL only while protected by room/match lifecycle;
- that process-global limits rely on exactly one worker;
- that raising workers, memory costs, limits, TTLs, or lobby caps is a new review boundary.

## 8. R10 local validation

Run targeted tests after each GREEN, then this exact full gate:

```bash
cd server
./.venv/bin/ruff check app tests
./.venv/bin/python -m pytest -q
cd ..
npm run check
npm run build
node --test tests/*.test.mjs
python3 tools/validate-question-bank.py
python3 -m unittest discover -s tests -p 'test_*.py'
git diff --check
```

Also run the migration 1–9 historical-upgrade controller in task-owned disposable PostgreSQL with fixtures for:

- R9 finished/deadline and position-zero legacy rows;
- pre-009 player expiry far beyond two hours;
- migration 009 clamp/default;
- cleanup preserving referenced active players and deleting unreferenced expired players.

**Acceptance:** every command rc `0`; no warning is silently promoted to PASS; failed fixture/controller runs remain failed evidence and are cleaned independently.

## 9. Canonical R10 freeze

1. Stop source writes.
2. Use the deterministic canonical-freeze helper to create a new private R10 input root; never overwrite R9.
3. Freeze all source files plus the unchanged private bank.
4. Independently recompute live manifests, archive members/content, regular-file-only status, uid/gid/timestamps, gzip timestamp, modes, and counts.
5. Reproduce the freeze in a second temporary root and require four byte-identical artifacts.
6. Record full SHA-256 values and file counts in the checkpoint.

Any subsequent source/private-bank change invalidates R10 freeze and all downstream evidence.

## 10. Exact-bound disposable Oracle proof

Clone the accepted R4 verifier into a new immutable R10 verifier; do not edit R4.

Required additions:

- migration 009 historical expiry clamp/default checks;
- real PostgreSQL lobby cap/full-member integration test;
- exact one-worker/384-MiB deploy contract;
- real Argon2 burst test demonstrating at most six admitted requests, capacity rejections as 429, no container OOM/restart, and `/readyz` healthy afterward;
- rotating-identity/client/global rate-limit controller;
- periodic cleanup independent of lobby reads;
- all prior migration, runtime-role, private-bank mount, no-host-port, no-access-log, REST/WSS, and cleanup checks.

Use `docker run -i` for every stdin-fed controller. Require a complete mode-0600 durable log, wrapper/verifier rc `0`, strict marker ordering, exact frozen hashes, and task-owned cleanup with remote containers/networks/images/roots all zero. Do not touch shared Caddy/PostgreSQL/n8n/BTC/platform services.

## 11. Fresh R10 successor audits

Only after proof PASS:

1. Create a new mode-0700 audit root and immutable mode-0600 cards.
2. Run transport preflights before semantic lanes.
3. Run server/deploy, client/Pages, and private-bank lanes with first-party Claude Opus 5/max, `Read` only, restricted safe mode, empty MCP, no credentials/network/shell/write tools, no session persistence.
4. Use `/opt/data` cwd only for the private-bank lane so both source and bank are readable; use the worktree cwd for source-only lanes.
5. Require for every semantic lane:
   - process rc `0`;
   - complete JSONL framing/tool-result pairing;
   - no permission denials or subagents;
   - exact declared paths and frozen manifest binding;
   - raw first physical line exactly `VERDICT: PASS`;
   - `FINDINGS:` beginning with `- NONE`;
   - exact `REVIEWED_PATHS`, `BINDING`, and `SCOPE: READ_ONLY` closure.
6. A raw FAIL is final for that stream. Do not reinterpret it into PASS; repair under R11 if needed.

## 12. Complete browser screen gate on an exact frozen disposable runtime

The previous browser attempt is not reusable because the configured API was unavailable. Produce a causal runtime-backed result:

1. Start an R10 exact-frozen, task-owned Oracle PostgreSQL/API stack with no remote host port and no shared-service mutation.
2. Obtain the task container's private network address.
3. Create a local SSH `-L` tunnel from a task-owned loopback port to that private API address; do not publish a remote Docker host port.
4. Copy the built Pages artifact to a temporary local root outside the frozen source and change only that copy's `quiz-api-base` meta value to the local tunnel URL.
5. Serve that temporary copy on a task-owned local port.
6. Open it in the browser and run the complete `tools/check-screens.js` content.
7. Preserve full console output and a screenshot. Require the terminal console summary `전부 통과`, zero failed rows, and all listed screen transitions.
8. Verify API `/readyz`, room creation, leave behavior, and no uncaught browser console errors.
9. Stop local static server/tunnel and remove only task-owned Oracle resources/temp artifacts.
10. Re-run exact frozen source/private-bank verification afterward.

This gate does not authorize production activation; it only verifies the exact candidate in a disposable runtime.

## 13. Final no-mutation and release reconciliation

Re-run:

- independent R10 freeze verifier;
- all four artifact hashes;
- `git diff --check`;
- audit card/stream SHA and mode checks;
- Oracle proof-log strict parser;
- browser evidence completeness parser/checklist;
- local and Oracle task-process/resource cleanup checks.

Final gate can be `GO CANDIDATE / release authority NONE` only if all are PASS:

1. full local validation;
2. canonical freeze + exact replay;
3. exact-bound Oracle proof;
4. three fresh successor raw PASS verdicts;
5. complete browser green gate;
6. post-audit/browser no-mutation;
7. no unexplained residue or evidence gap.

Even then, stop before commit, push, PR, production migration/start/reload, main merge, or Pages publication. Those require separate explicit authorization.

## Files likely to change

- `server/app/password_work.py` (new)
- `server/app/rate_limit.py`
- `server/app/main.py`
- `server/app/repository.py`
- `server/app/postgres.py`
- `server/migrations/009_bound_online_resource_lifetimes.sql` (new)
- `server/tests/test_password_work.py` (new)
- `server/tests/test_rate_limit.py`
- `server/tests/test_api.py`
- `server/tests/test_match_api.py`
- `server/tests/test_postgres_sql_contract.py`
- `server/tests/test_postgres_integration.py`
- `server/tests/test_resource_bounds_schema_contract.py` (new)
- `server/tests/test_deploy_contract.py`
- `deploy/oracle/README.md`
- `README.md` only if the public architecture description needs the bounded-resource contract

No `src/` change is expected unless a RED client contract test proves the existing 429 handling is inadequate.

## Principal risks and controls

- **Overly strict classroom NAT limits:** retain 60 sessions/minute/client and allow 30 room creations/hour/client; validate realistic classroom flows before changing values.
- **Limiter partial-consumption DoS:** one atomic hierarchical admission operation; no chained independent `.allow()` calls.
- **Semaphore still permits unbounded waiters:** separate max-inflight count, immediate overflow rejection, cancellation tests.
- **Lobby SQL truncates members:** limit room IDs before the member join and prove a 12-member boundary in real PostgreSQL.
- **Cleanup breaks active games:** preserve referenced players and test room/match references in real PostgreSQL.
- **Historical migration drift:** migration 009 only; migration 001 remains immutable; run 1–9 upgrade fixtures.
- **Evidence reuse after mutation:** every source change after R10 freeze starts a new generation.
- **False browser PASS:** use the real frozen API through an SSH tunnel and preserve complete console/screenshot evidence.
- **Accidental release:** release authority stays `NONE`; no Git or production side effects are included in this plan.
