# Quiz by Quiz Oracle overlay contract

`compose.quiz-by-quiz.yaml` is **not a standalone Compose project**. It is an
Oracle overlay for the owner-maintained platform Compose project. Do not run it
alone, and do not add a second PostgreSQL, Caddy, host port, Docker network, or
TLS listener for this service.

The currently verified platform base supplies these stable integration points:

- the `postgres` service on the private platform network;
- the shared `caddy` service that owns host ports 80/443; and
- the logical `internal` network used by Caddy, PostgreSQL, and the overlay.

The overlay intentionally refers to those names rather than recreating them.
It must be rendered together with the owner’s platform Compose base before any
staging or activation decision. A rendered configuration that lacks `postgres`,
`caddy`, or `internal` is invalid and must not be brought up.

## Required owner-provided inputs

All values are deployment secrets or paths; none belongs in this repository,
Git, GitHub Actions logs, Docker image layers, or the public Pages artifact.

| Input | Required property |
| --- | --- |
| `QUIZ_BY_QUIZ_SOURCE_DIR` | A new task-owned, hash-verified release directory. Never use the stale hand-copied public tree. |
| `QUIZ_ONLINE_BANK_DIR` | The separately hash-verified private bank directory, mode `0700` with bank files `0640`; never `data/` from Pages. |
| `QUIZ_MIGRATOR_DATABASE_URL` | Dedicated migration-owner connection for the Quiz database only. It is used by the one-shot migrator, not the runtime API. |
| `QUIZ_DB_PASSWORD` | Runtime-role password supplied only through the protected platform environment; do not print, commit, or add it to a Compose file. |

The API service mounts `${QUIZ_ONLINE_BANK_DIR}` at
`/run/quiz-by-quiz/online-bank` as read-only. It publishes no host port and
must retain exactly one Uvicorn worker. The API runtime role has only the
minimum database permissions established by migrations.

### Bounded API resource envelope

The `384m` API container is deliberately limited to `0.50` CPU, 128 PIDs, and
one Uvicorn worker. Password hashing keeps the deployed Argon2 profile
(`memory_cost=65536 KiB`, `time_cost=3`, `parallelism=4`, `hash_len=32`,
`salt_len=16`) while allowing at most two concurrent Argon2 jobs: `2 × 64
MiB = 128 MiB` for Argon2 allocations inside the `384m` container. The envelope
permits at most six admitted Argon2 jobs (two running plus four waiting).
Further work is rejected
with HTTP `429` and `Retry-After: 1` instead of growing an unbounded queue.

Ingress limits are atomic across their scopes: sessions are 60/client/minute
and 300/process/minute; room creation is 10/actor/hour, 30/client/hour, and
100/process/hour; private password attempts are 10/client+room/minute and
120/process/minute. Every authenticated REST request is bounded before database
authentication at 120/player-session/minute, 1,500/client/minute and
3,000/process/minute (see "Shared-address players" below). Public/private join is
12/actor+room/minute and 300/process/minute;
room mutations are 30/actor+room/10 seconds and 600/process/minute; chat is
12/actor+room/minute and 600/process/minute; answer submission is
8/actor+room/30 seconds and 600/process/minute; WebSocket ticket issue is
6/actor+room/minute and 300/process/minute. These process-global limits require
exactly one Uvicorn worker.
Do not increase the worker count or horizontally scale this service without a
shared distributed limiter and a fresh memory/rate-envelope review.

Every limiter rejection is HTTP `429` with `Retry-After` set to the whole
seconds until the exhausted sliding window actually frees a slot (at least 1).
CORS exposes `Retry-After` so the cross-origin Pages client can read it.
Rejected attempts consume nothing, so an early retry cannot deepen a limit.

The in-process event hub admits at most two sockets per actor+room, 32 per room,
and 256 total. Movement and heartbeat frames share an actor+room budget of 30 per
second and 1,200 per minute, plus a process-wide budget of 15,000 per minute;
excess closes with 4429. The browser coalesces movement to eight frames per second
and sends standing positions every two seconds for reconnect recovery. Broadcast
sends run concurrently with a two-second per-socket deadline. Leaving a room closes
that actor's sockets immediately, and the
60-second cleanup sweep revalidates all admitted memberships. The hub also keeps
in-memory presence: a member whose last socket closed more than 60 seconds ago is
reported as disconnected, skipped by game start, and loses the host seat to the
earliest connected member during a 5-second presence sweep. Such a member also
leaves the "everyone answered" count of a running match: the question advances
once every connected player (and always the requesting player) has answered, the
absent member's missing answer is stored as a timeout, and a returning member is
counted again. The presence sweep re-checks the current question when someone
crosses the grace period. Records older than an hour are dropped. These bounds also depend on the single-worker deployment contract.

The host's member removal keeps a second in-process record. A removed
(room, player) pair is remembered for one hour so the player hears "removed by
the host" instead of "room not found", bounded at 4,096 records with the oldest
dropped first. When the host removed a member who was still connected
(`?connected=true`, confirmed in the waiting-room dialog), that player's join,
room read and WebSocket ticket for the same room are refused with `kicked` for
10 minutes; the database is not changed. The block ends early on an API restart
or when the room is deleted, and it relies on the same single-worker contract —
a second worker would not see it.

Persistent growth is bounded by a two-hour player lifetime, an independent
60-second resource cleanup loop, and lobby materialization of no more than
100 complete rooms. Parent rooms are selected before member expansion so a
12-player room is never returned partially. At the process-wide ceilings, the
unreferenced player bound is at most `300/minute × 120 minutes = 36,000` live
rows, and newly created rooms are at most `100/hour × 24 hours = 2,400` before
activity extensions and periodic cleanup. Active room or match references may
outlive the base player TTL only while protected by their own bounded lifecycle.
Cleanup failures are logged and retried on the next tick.

Increasing the worker count, container memory, Argon2 costs or admission
limits, ingress limits, lifetimes, cleanup interval, or lobby cap is a new
resource-envelope review boundary; do not treat it as an operational tuning
change. "Shared-address players" below records such a review.

Before the one-shot migrator handles `QUIZ_DB_PASSWORD`, the owner must confirm
that PostgreSQL statement logging cannot persist credential-bearing SQL. The
verified baseline is `log_statement=none` with duration logging disabled; a
changed logging policy is a new preflight blocker, not a reason to print a
secret for diagnosis.

### Shared-address players (N01, owner decision)

A classroom or home NAT puts every player of a room behind one client address.
With the former authenticated envelope (120/client/minute, 600/process/minute)
a same-address load simulation of a 10-question match lost 10–14% of answers to
`429` at 6 players, about 25% at 8 players (half of them stuck), and 61–70% at
12 players (every player stuck on the last reveal). The cause was O(N²)
fan-out: every accepted answer broadcast `match-invalidated` to the whole room
and every browser re-read `GET /match`, 77% of those reads returning an
unchanged snapshot; a refresh lost to `429` was never retried, and no broadcast
follows the final transition.

The owner approved this envelope change together with three traffic changes:

- Authenticated ingress adds a per-player bucket of 120/minute, keyed by player
  id **and** the bearer-token hash so a forged request that only knows another
  player's id (ids appear in room snapshots) drains its own bucket, not the
  victim's. The client bucket rises to 1,500/minute, above the largest room
  (12 players × 120), and the process bucket to 3,000/minute. All three are
  checked atomically before database authentication. Answer submission keeps
  8/actor+room/30 seconds; unauthenticated limits are unchanged.
- An accepted answer that does not advance the match is no longer broadcast:
  the running snapshot other players read carries no scores and no foreign
  submission flags, so it is byte-for-byte unchanged (Postgres integration test
  `test_postgres_answer_that_does_not_advance_leaves_other_players_payload_unchanged`).
  The answer that opens the reveal, expiry advances, and read-triggered
  advances still broadcast.
- The browser draws the answer response snapshot instead of re-reading, retries
  a `429`'d `GET /match` or room refresh once after `Retry-After` (default 1 s)
  plus up to 500 ms jitter, capped at 3 s, and re-reads once per phase when the
  displayed countdown has been over for 2 seconds without a new phase.

Measured demand with the broadcast suppression and no post-answer read, limits
lifted: peak 60-second totals of 132 (6 players), 177 (8) and 332 (12, lobby
dominated; match phase 115) requests from one address, and at most 36 requests
per player in any 60-second window (50 with the former client). The per-player
bucket therefore keeps more than 3× headroom, and one address can carry about
four full 12-player rooms at that peak.

Resource review for the raised ceiling: the process bucket now admits up to 50
authenticated requests per second, five times the former 10/s, each costing
one indexed authentication read plus the route's own statement. That rate has
not been load-tested inside the `0.50` CPU container; measured rooms stay far
below it, and the expected effect at the ceiling is slower responses rather than
memory growth. Limiter state stays bounded because rejected attempts never
create keys: at most 3,000 admitted requests per minute, each held in three
claims (≤ 9,000 timestamps), and per-player keys bounded by the same 3,000.
The change needs no migration and is compatible in either deployment order: an
older browser still re-reads after its own answer (one extra read, within its
new per-player bucket), and against an older API the new browser falls back to
its read coalescing (every answer is still broadcast) and to the 1-second
default when `Retry-After` is not exposed.

## Caddy integration

`Caddyfile.quiz-by-quiz` is a **candidate fragment**, not an automatically
loaded production configuration. An owner may import it into the existing
platform Caddyfile only after the inactive release and API health gates pass.
Validate the combined Caddy configuration before a reload and preserve the
exact predecessor for task-owned rollback.

The fragment proxies only to `quiz-by-quiz-api:8000` on `internal`. It keeps
Caddy’s peer-derived forwarded identity for API rate limiting. WebSocket event
tickets travel in the `qbb.ticket.<token>` WebSocket subprotocol request header;
the request URI is query-free and the server selects only the public `qbb.v1`
protocol. The event handshake remains excluded from Caddy access logs as defense
in depth; normal REST access logging remains enabled. The API itself runs with
Uvicorn access logging disabled and warning-level server logs so routine accepted
or rejected handshakes cannot persist ticket-bearing request metadata. Caddy
returns public `/healthz` and `/readyz` requests as 404; Docker and Caddy active
health checks reach `/readyz` only on the private container network. The public
`/v1/release-readiness` gate exposes only the fixed compatibility contract and
schema version, and bounds database probes to 12 requests per client and 120
per process per minute.

### Client identity boundary

The API derives its rate-limit key from `X-Forwarded-For` only behind this Caddy
reverse proxy. Caddy's default reverse-proxy behavior ignores incoming
`X-Forwarded-*` values from an untrusted client and supplies the peer-derived
value to its upstream; the verified platform base has no `trusted_proxies`
setting. Do not add a `trusted_proxies` policy, expose port 8000, or put another
proxy in front of this host without re-reviewing the API's client-identity and
rate-limit contract.

## Fail-closed staging order

The current compatibility boundary is **migration 011 → API → Pages**.
Migration 011 stores the host-chosen online question time (20 or 40 seconds,
default 20) on rooms, copies it onto each match, and widens the answer
`elapsed_ms` range to 40 seconds. It only adds defaulted, constrained columns:
the migration-010 API names its columns explicitly and never reads or writes
them, so it keeps serving (at its fixed 20 seconds) while 011 runs and remains
a valid rollback target afterwards. The candidate API reads and writes those
columns, so it must not replace the 010 API before ledger version 011 exists.
The candidate Pages client sends `questionTimeMs`, which the 010 API rejects as
an unknown field, so Pages waits for the candidate API.

1. Recompute and verify the source and private-bank hashes against the approved
   candidate; stop on any mismatch.
2. Render the overlay with the platform base and inspect the result. Do not
   `up`, restart, reload, migrate, or expose anything at this step.
3. With the migration-010 API still serving, build and run only the explicit
   `quiz-by-quiz-migrate` service from the candidate source. Require ledger
   versions 001–011, the `rooms_question_time_check`,
   `matches_question_time_check`, and `match_answers_elapsed_ms_range_check`
   constraints, and `question_time_ms = 20000` on every pre-existing room and
   match. The 010 API's public `/v1/release-readiness` now answers 503
   `migration-required`; that is the expected fail-closed state, not an outage.
4. Build and replace only `quiz-by-quiz-api` with the candidate. Require
   internal `/readyz`, verify that a room created without `questionTimeMs`
   reports `questionTimeMs: 20000`, and require the exact public
   `/v1/release-readiness` response
   `{status: ready, contract: character-only-v1, schemaVersion: 11}`.
5. Verify HTTPS and WSS through the existing Caddy route without changing any
   unrelated platform service or host-port exposure.
6. Only after the production readiness response passes may the independent
   public Pages source be merged and published. The Pages workflow repeats this
   gate and fails closed before `deploy-pages`.

The preceding boundary was **API → migration 010 → Pages**: never run the 010
constraint migration while a legacy API process can still write `false` or
`NULL` values. A database still at migration 009 must first complete that
order with a migration-010 API (all five character-only constraints and
readiness `schemaVersion: 10`) before step 3 above; the current candidate API
does not run on a migration-009 database.

If a stage fails, remove or stop only the task-owned release/service artifacts.
Do not restart, reload, alter, or roll back unrelated n8n, BTC, Caddy,
PostgreSQL, or platform resources.
