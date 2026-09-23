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
authentication at 120/client/minute and 600/process/minute. Public/private join is
12/actor+room/minute and 300/process/minute;
room mutations are 30/actor+room/10 seconds and 600/process/minute; chat is
12/actor+room/minute and 600/process/minute; answer submission is
8/actor+room/30 seconds and 600/process/minute; WebSocket ticket issue is
6/actor+room/minute and 300/process/minute. These process-global limits require
exactly one Uvicorn worker.
Do not increase the worker count or horizontally scale this service without a
shared distributed limiter and a fresh memory/rate-envelope review.

The in-process event hub admits at most two sockets per actor+room, 32 per room,
and 256 total. Movement and heartbeat frames share an actor+room budget of 30 per
second and 1,200 per minute, plus a process-wide budget of 15,000 per minute;
excess closes with 4429. The browser coalesces movement to eight frames per second
and sends standing positions every two seconds for reconnect recovery. Broadcast
sends run concurrently with a two-second per-socket deadline. Leaving a room closes
that actor's sockets immediately, and the
60-second cleanup sweep revalidates all admitted memberships. These bounds also
depend on the single-worker deployment contract.

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
change.

Before the one-shot migrator handles `QUIZ_DB_PASSWORD`, the owner must confirm
that PostgreSQL statement logging cannot persist credential-bearing SQL. The
verified baseline is `log_statement=none` with duration logging disabled; a
changed logging policy is a new preflight blocker, not a reason to print a
secret for diagnosis.

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

The compatibility boundary is **API → migration 010 → Pages**. Never run the
constraint migration while a legacy API process can still write `false` or
`NULL` values.

1. Recompute and verify the source and private-bank hashes against the approved
   candidate; stop on any mismatch.
2. Render the overlay with the platform base and inspect the result. Do not
   `up`, restart, reload, migrate, or expose anything at this step.
3. Build and replace only `quiz-by-quiz-api` with the candidate while the
   database is still at migration 009. Require internal `/readyz` and verify
   that omitted characters and legacy `gameMode:false` requests are normalized.
   The profiled `quiz-by-quiz-migrate` service must not start in this step.
4. After the candidate API is the sole writer, run only the explicit
   `quiz-by-quiz-migrate` service. Require ledger versions 001–010, all five
   character-only constraints, and the exact public `/v1/release-readiness`
   response `{status: ready, contract: character-only-v1, schemaVersion: 10}`.
5. Verify HTTPS and WSS through the existing Caddy route without changing any
   unrelated platform service or host-port exposure.
6. Only after the production readiness response passes may the independent
   public Pages source be merged and published. The Pages workflow repeats this
   gate and fails closed before `deploy-pages`.

If a stage fails, remove or stop only the task-owned release/service artifacts.
Do not restart, reload, alter, or roll back unrelated n8n, BTC, Caddy,
PostgreSQL, or platform resources.
