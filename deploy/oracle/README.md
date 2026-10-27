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
| `QUIZ_ONLINE_BANK_DIR` | The separately hash-verified private bank directory, owned by `10001:10001`, mode `0750` or narrower with bank files `0640` and no access for other users (`ONLINE_QUESTION_BANK.md`); never `data/` from Pages. |
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
6/actor+room/minute and 300/process/minute. Each of these per-endpoint limiters
also charges, atomically with the two above, an actor claim across room codes
(3 × the actor+room limit in the same window: join 36/minute, mutations 90/10
seconds, chat 36/minute, answers 24/30 seconds, tickets 18/minute) and a client
claim of half the process limit per minute (join 150, mutations 300, chat 300,
answers 300, tickets 150), so neither one identity nor one address can fill a
per-endpoint process bucket. Public online-ranking reads (`GET /v1/rankings`,
"Online rankings" below) are 300/client/minute and 1,200/process/minute; a read
that carries a browser identity also passes the authenticated bucket above.
These process-global limits require
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

Standing-answer drafts (U13) are a third in-process record. When a match
snapshot carries `standingAnswers: true` and the WebSocket ticket advertises
`standingAnswer: "standing-answer-v1"`, the browser sends the tile its character
stands on after it really moved (`{"type": "standing-answer", ...}`, debounced,
`choiceIndex: null` when it steps off). The API keeps one draft per room+player,
never broadcasts it, and drops drafts after 90 seconds, beyond 4,096 records
(oldest first), when the question advances or the match ends, and on leave,
removal or room deletion. Drafts never count toward "everyone answered"; when a
deadline (or an absent player's fill) closes a question, a draft received before
`deadline_at` for that match and position is stored as that player's normal
graded answer (`timed_out = false`, full question time) instead of a timeout. An
API restart loses the drafts: browsers resend their latest draft when the socket
reconnects, otherwise the old timeout applies. Drafts travel only over the room
socket, so a browser whose socket is down at the deadline (dropped and
reconnecting, or unable to get a ticket) cannot update its draft: the API grades
the last draft it received before the deadline — an earlier tile if the player
moved during the outage — or records the timeout if it has none. The browser
tells the player to submit explicitly while its socket is down. This needs no migration. Rooms
and the session response also carry `minPlayers: 1` — the host alone may start a
match; a frontend that sees no such field treats the API as the previous
two-player one.

Persistent growth is bounded by a two-hour player lifetime, an independent
60-second resource cleanup loop, and lobby materialization of no more than
100 complete rooms. Parent rooms are selected before member expansion so a
12-player room is never returned partially. At the process-wide ceilings, the
unreferenced player bound is at most `300/minute × 120 minutes = 36,000` live
rows, and newly created rooms are at most `100/hour × 24 hours = 2,400` before
activity extensions and periodic cleanup. Solo rooms (FR-7.13 step 3, "Solo
online play" below) do not take the room-create bucket; they have their own
hard ceiling of 1,200 at once. Active room or match references may
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
secret for diagnosis. `python -m app.release_check db` (below) reads these
settings without printing anything secret.

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
authenticated requests per second, five times the former 10/s. Authentication
is not a read: `authenticate` is a primary-key `UPDATE` of the player row that
refreshes `last_seen_at` and the indexed `expires_at` (a non-HOT write with WAL,
index maintenance and a dead tuple for autovacuum), so the ceiling means up to
50 player-row `UPDATE`s per second through the 5-connection pool, plus the
route's own statements; forged tokens match no row and cost a statement and a
pool checkout without a write. That rate has not been load-tested inside the
`0.50` CPU container, neither for CPU nor for write/WAL and autovacuum load;
measured rooms stay far below it (a 12-player match phase is about 2 requests
per second), and the expected effect at the ceiling is slower responses rather
than memory growth. Limiter state stays bounded because rejected attempts never
create keys: at most 3,000 admitted authenticated requests per minute, each held
in three claims (≤ 9,000 timestamps), per-player keys bounded by the same 3,000,
and every per-endpoint limiter bounded by its own process claim (four claims per
admitted request). Untouched keys are swept within one second after their
window ends.
The change needs no migration and is compatible in either deployment order: an
older browser still re-reads after its own answer (one extra read, within its
new per-player bucket), and against an older API the new browser falls back to
its read coalescing (every answer is still broadcast) and to the 1-second
default when `Retry-After` is not exposed.

Review follow-up (same envelope, tighter per-endpoint scopes):

- The 1,500/client authenticated bucket let one address with a few cheap sessions
  fill a per-endpoint process bucket (tickets 300, answers 600, …): those
  limiters are charged before the membership check, and every random room code
  is a fresh actor+room key. The per-endpoint client and cross-code actor claims
  listed under the ingress limits close that; filling any of those process
  buckets again needs at least two addresses, as for the authenticated bucket.
  One classroom behind one address — three 12-player rooms, 36 players — still
  fits: answers peak at 36 × 7.5 questions/minute (the 8-second reveal bounds
  the pace) = 270 of 300, realistically 70–110 at 20-second questions; tickets
  at most 108 of 150 (three socket opens per player in a fast rematch minute:
  result → waiting room → next match), 144 even if a Wi-Fi blip reconnects
  everyone in that same minute (a refused ticket is retried by the 1-second
  reconnect loop, not lost); joins 36 of 150; ready toggles and settings well
  under 300; chat 300 is 8 lines per player per minute against the 12/minute
  personal cap. `test_a_classroom_behind_one_address_fits_every_per_endpoint_share`
  sends that busiest minute and expects no `429`. Four 12-player rooms (the
  authenticated bucket's measured capacity above) fit the answer share at a
  brisk pace (everyone answering within 5 seconds: 60 s / 13 s ≈ 4.6
  questions/minute → about 220) but not at the theoretical 7.5/minute (360);
  revisit these shares before promising more than three rooms per address or
  raising room capacity.
- The limiter prunes only the claims a call touches and sweeps every retained
  key at most once per second. Per-player keys are attacker-inflatable (a fresh
  forged id/token per admitted request), and the former full sweep on every call,
  rejections included, cost about 150× more per call at 3,000 keys.
- The browser re-reads `GET /match` once (coalesced behind any read in flight)
  when an answer POST fails without a definite 4xx rejection (timeout, network
  error, 5xx, unreadable body) or when its successful response is discarded
  because a reconnect invalidation changed the match identity meanwhile. Without
  the per-answer broadcast nothing else would show the player that the server
  kept their answer. A `429`'d `GET /match` is not retried separately when a
  follow-up read is already queued (the room refresh already skipped it), and
  the waiting-room/result-screen match recovery read now gets the same single
  `429` retry.

These review fixes need no migration and work in either deployment order: an
older browser simply lacks the extra re-reads, and the new browser against an
older API only sends one more read in the rare cases above.

### Online rankings (FR-7.13 step 2, migration 012)

Every online match the API closes is recorded, solo and multi alike (PRD 12.1,
owner decision). In the same transaction that turns the last reveal into
`finished`, the API inserts one row per match player into
`quiz_online.online_rankings`: the server-graded score and correct count (the
final standings' own aggregate over `match_answers`; no browser-reported score
is accepted anywhere), total questions, mode (`category` or `all`) and category,
the match's question time, the nickname as shown in that room, the character id,
the browser player id (`players.id`, kept in the browser's localStorage), the
owner key and the close time (`matches.finished_at`). The owner key is
`sha256("qbb-ranking-owner:" || players.token_hash)` (32 bytes, `NULL` only if
the player row were already gone; the token hash itself is not stored): the
player id alone cannot prove ownership, because every lobby reader sees member
ids and anyone may register an id again with their own token once its player row
expired (2 hours), so a record is "mine" only for the same id **and** the same
browser token. A player who dropped out during the match is
recorded with the timeouts that filled their answers; a member who was absent at
the start is not a match player and is not recorded. `UNIQUE (match_id,
player_id)` (`online_rankings_match_player_key`) keeps a re-read of a finished
match from recording twice. The table has no foreign key: players and matches
are deleted within hours, the records stay. If the insert fails, the match is not
closed either and the next read or deadline sweep closes and records it again.
The finished match snapshot carries `rankingRecorded` for the reader.

Nicknames: duplicates are allowed. `PUT /v1/session` refuses profanity with 400
`nickname-profanity` and personal-data shapes (six or more digits in a run,
whatever non-letter separates them — space, dot, slash, tilde, comma, dashes or
the vowel `ㅡ` typed as a dash; `x@y`, `://`, `www.` or `name.<common suffix>`)
with 400 `nickname-personal-info`. The short word lists and suffixes live in
`server/app/nickname_filter.py`'s data file `nickname_rules.json`
(`blockedWords` match anywhere in the letters-only form; `blockedTokens` such as
`shit`, `porn`, `존나` also occur inside ordinary names like Ashita, Pornchai or
생존나라 and only match as a standalone word), mirrored in the Pages client
(`src/online/nickname-rules.ts`) so the home dialog explains it before
sending. At record time the room nickname is checked again and an old
nickname that fails is stored as `익명`.

Reads: `GET /v1/rankings?mode=category&category=<id>&period=week|all` (or
`mode=all` without a category) returns the top 10 as `{mode, categoryId, period,
window, limit, entries}`, each entry `{rank, nickname, characterId, score,
correctCount, totalCount, recordedAt, isMine}`. Order is score descending, then
the earlier record (record time, then insertion order — a match inserts in its
final standings order), and ranks follow that order (1, 2, 3), as the local
ranking does. `week` is Monday 00:00 to the next Monday 00:00 in Asia/Seoul
(`window: {start, end, timeZone}`; `null` for `all`). The browser player id is
never returned; `isMine` is true only when the request carries the same
authenticated browser identity — the same player id and an owner key derived from
the same bearer token (a wrong identity is 401, not an anonymous read).
Each read is one index scan of at most 10 rows (`online_rankings_board_order_idx`
for all time, `online_rankings_board_week_order_idx` on the stored generated
`board`/`week_start` columns for the week; about 0.05 ms measured on 100,000
rows).

Own reads (FR-7.13 step 3): `GET /v1/rankings/mine` returns the caller's best
record per board as `{boards: {all, history, science, geography, general, art}}`,
each `{score, correctCount, totalCount, recordedAt}` or `null` (score
descending, then the earlier record — the board order). `?excludeMatch=<match
uuid>` leaves that match out, so the result screen compares a just-closed solo
match with the best **before** it (FR-5.7). `GET /v1/rankings/mine/records`
returns the caller's records for the records export, newest first, at most 500
(`{records, limit, truncated}`; each `{mode, categoryId, score, correctCount,
totalCount, questionTimeMs, nickname, recordedAt}`). Both require a session
(`require_actor`) and match the same id **and** the owner key derived from the
bearer token, like `isMine`; neither returns a player id. They read through
`online_rankings_player_board_order_idx` (`player_id, board, score DESC,
recorded_at, id`) and take their own bucket in front of the authenticated one
(best: 30 per player, records: 6 per player, 600 per address and 1,200 per
process per minute; the home asks for the best once per visit).

Grants: the runtime role may only `INSERT` and `SELECT` the table (no `UPDATE`,
`DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER`, table or column grant) and still
has nothing on the ledger. Retention runs through
`quiz_online.prune_online_rankings()`, a `SECURITY DEFINER` function with a fixed
`search_path` and no arguments, which the 60-second resource cleanup calls after
its own transaction (a failing prune is logged and does not stop room cleanup).
It keeps the last 8 weeks (56 days) and, beyond that, only each board's all-time
top 100; above 250,000 rows it trims the oldest rows even inside the 8 weeks
(each board's top 100 always stay). It deletes at most 10,000 rows per call, and
the `cleanup` log line counts them (`rankingsPruned`).

Resource envelope: a row with its three board indexes takes about 445 bytes (100,000
synthetic rows with owner keys: 17 MB heap, 25 MB indexes). The per-player index
of FR-7.13 step 3 is one more btree of the same width (about one third more index
space, an estimate, not re-measured). A class of 30
playing ten matches a day writes 300 rows a day, about 16,800 (7.5 MB) in 8
weeks. The 250,000-row ceiling bounds the table at roughly 110 MB (about 140 MB
with the per-player index) plus 600 retained top rows, whatever the traffic. Rows are written only when a match closes; a match takes at least
ten 8-second reveals (80 s, 200 s for the all-categories round), a room holds one
match at a time with at most 12 players, match starts share the
600/process/minute room-mutation bucket (12 rows each) and solo starts have
their own 600/process/minute bucket (1 row each, "Solo online play" below), so
ingest cannot exceed 7,800 rows a minute even in theory, below the 10,000 rows
the prune may delete each minute
(a 5,000-row batch took 0.12–0.19 s on 100,000 rows). Reads are bounded by the
1,200/process/minute ranking bucket (at most 20 index scans a second); the API
keeps nothing about rankings in memory. Changing the retention, the ceiling,
the batch or the read limits is a resource-envelope review boundary like the
others above.

### Solo online play (FR-7.13 step 3, migration 012)

The owner direction removes the local solo mode: the home's category cards and
"all categories" button start a **solo online match** directly, without a
waiting room, and the 온라인 button keeps opening the lobby for playing with
others. `POST /v1/solo` with `{categoryId (null for all), questionTimeMs
(20000|40000)}` reuses the caller's solo room or creates one and starts a match
in the same transaction (`start_solo`, through the same `_start_locked_match`
as the host's start: question selection avoiding that room's recent questions,
deadlines, closing and recording are identical). If a match is already running
in that room it returns `{room, match: null, resumed: true}` instead of starting
another. The response is `{room, match, resumed}`; `room.solo` is `true`. The
session response announces the feature additively with `soloPlay: true`; a
client that does not see it keeps the old local solo mode.

Storage: migration 012 also creates `quiz_online.solo_rooms (room_id PRIMARY
KEY REFERENCES rooms ON DELETE CASCADE, player_id, created_at,
UNIQUE (player_id) solo_rooms_one_per_player)` — one mark per room and one solo
room per player; existing tables are not altered. The runtime role may only
`SELECT` and `INSERT` it; a mark disappears with its room through the cascade
(leaving the last member deletes the room, the 30-minute stale-member cleanup
and the 24-hour expiry delete it as for any room). A solo room is a normal room
(capacity 2, public, no password, the creator as its only member and host) that
`_ROOM_ROWS_SQL` shows **only to its members**: other players' lobby lists and
code lookups never contain it, `POST /v1/rooms/{code}/join` answers 404
`not-found` for a non-member (the repository's `join_room` refuses it again),
and the Pages client also leaves it out of its own lobby list (the home's
"풀던 혼자 판 · 이어 풀기" line returns to it). Leaving mid-match, browser Back,
tab close and reconnect follow the existing online rules: the match continues
on the server and is recorded when it closes.

Limits and envelope: `POST /v1/solo` takes 12 per player, 120 per address and
600 per process per minute; a starting request needs no running match, and a
match takes at least ten 8-second reveals, so one player starts at most about
one match a minute and owns at most one solo room. Solo rooms do **not** take
the room-create bucket (100/process/hour), and the client's 홈으로 deletes the
solo room, so every round started from home creates a room. Because session
identities are cheap (60 per address, 300 per process a minute), the per-player
bound alone does not bound rooms or concurrent matches, so a **new** solo room
is admitted only when both of these hold (reusing a player's live solo room —
다시 하기, a resumed match — pays neither):

- Hard ceiling: fewer than `SOLO_ROOM_CEILING` = 1,200 solo rooms exist
  (`SELECT count(*) FROM quiz_online.solo_rooms` inside the creating
  transaction; concurrent creators can overshoot by at most their own number).
  At the ceiling `POST /v1/solo` answers 503 `solo-busy` and the Pages client
  falls back to practice ("not recorded") like any 5xx.
- Creation budget: `solo-create:client` 720 per address and
  `solo-create:process` 2,400 per process per hour (429 with an hourly
  `Retry-After`). 720 lets 36 players behind one address start a new round from
  home every 3 minutes; an abandoned solo room lives until the 30-minute
  stale-member cleanup, so one address can hold at most about half its hourly
  budget (about 360 rooms, 30% of the ceiling) at once.

Concurrent matches are therefore at most 1,200 solo (one per solo room) plus the
2,400-room bound of the other rooms. 1,200 idle solo matches at 20-second
questions need two deadline transitions per 28 seconds each, about 86 per
second, within the deadline sweep's 100 matches a second; the combined
theoretical maximum (3,600 idle matches, about 257 transitions a second) would
exceed one sweep's pace, so deadlines and reveals would lag rather than fail —
the same theoretical state the 2,400-room bound already allowed before solo
play. Solo rooms add at most 1,200 room, member and mark rows. Rows written to
the ranking table stay within the ingest bound of "Online rankings" above.
Changing the ceiling, the creation budget or the start bucket is a
resource-envelope review boundary like the others. The ops log writes one
`solo_started` line per started solo match instead of `room_created` and
`match_started`.

Rollback: an API without solo play (the 011 API, or #108) does not know the
marks and would list every leftover solo room as an ordinary public, joinable
room named «혼자 하기» — first in its member's list, taking lobby slots (the
100-room lobby cap) and joinable by strangers once its match ended. Before the
older API serves again, run as the migrator:

```sql
DELETE FROM quiz_online.rooms r USING quiz_online.solo_rooms s WHERE s.room_id = r.id;
```

The delete cascades to members, matches and marks; solo matches still running
are lost unrecorded, which is acceptable on rollback. Finished solo matches are
already in the ranking table, which has no foreign key and stays. The client of
this branch only creates solo rooms against an API that announced `soloPlay`.

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
or rejected handshakes cannot persist ticket-bearing request metadata. The
operational log ("Operational log and uptime monitor" below) adds its own INFO
lines. Those carry room codes and counts (the 5-minute summary adds REST
request counts by status class and the p50/p95/max latency) and, for an
unhandled error, the HTTP method, the route template and the exception class,
but no request values: no paths with their values, query strings, headers,
bodies, tickets, tokens or addresses. Caddy returns public `/healthz` and
`/readyz` requests as 404; Docker and Caddy active health checks reach
`/readyz` only on the private container network. The public
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

The current compatibility boundary is **migration 012 → API → Pages**. The
solo online play of FR-7.13 step 3 ("Solo online play" above) is part of the
same candidate: its table and index are folded into the not yet applied
migration 012, so its server changes deploy with #108's rankings as one API
candidate and do not add a boundary.

**Hard rule: do not deploy #108 on its own while the solo-play PR is open.**
Editing migration 012 in place makes ledger version 12 mean two schemas, and
the migrator compares version numbers only (no checksums), so on a database
where #108's 012 was applied this 012 would never run. This API's room SQL reads
`quiz_online.solo_rooms` in every lobby, room, join and access query, so there
it would fail all of them. Its public readiness therefore checks the table as
well as the number: on a version-12 ledger without `quiz_online.solo_rooms` it
answers 503 `migration-required` (`solo_rooms_ready`), and the Pages gate stays
closed. If ledger 012 already exists without the table (`release_check`
`solo-rooms-table` FAIL at step 3), move the `solo_rooms` table, its grant and
`online_rankings_player_board_order_idx` into a new `013_solo_rooms.sql`, set
`RELEASE_SCHEMA_VERSION = 13` and the Pages readiness gate to 13, restore 012 to
the #108 text, and repeat this order with ledger versions 001–013.
Production runs the migration-010 API until #106 (migration 011, below) is
deployed; #107 follows it without a migration, so this boundary starts from the
migration-011 API (readiness `schemaVersion: 11`). Migration 012 adds the online
ranking table, its indexes and the retention function ("Online rankings"
above). It only adds: the migration-011 API never reads or writes the table, so
it keeps serving while 012 runs and remains a valid rollback target afterwards
(matches it closes in that window are simply not recorded). Its public
readiness then answers 503 `migration-required`, because it requires exactly
schema version 11 — the expected fail-closed state, not an outage. The
candidate API records every match it closes inside the closing transaction, so
it must not replace the 011 API before ledger version 012 exists: on a
migration-011 database no match could close (each closing transaction fails;
the deadline sweep isolates every match in its own savepoint, so it keeps
advancing the other matches and retries the closing ones every second), every
read of a finished match fails, and its readiness answers 503
`migration-required` there too. The candidate Pages client asks for a session
before it offers the online ranking: it shows the online ranking only when the
session response carries `rankings: true`, hides the online ranking UI when the
API lacks that field, and opens on the browser's own records when the session
cannot be opened at all (API unreachable, or a saved nickname the new filter
refuses); the "online ranking" tab stays there to retry. The Pages workflow
still waits for `schemaVersion: 12`, so the published client's "recorded to the
online ranking" line is always backed by a recording API.

1. Recompute and verify the source and private-bank hashes against the approved
   candidate; stop on any mismatch. The source is a fresh clone checked out at
   the approved commit: `git rev-parse HEAD` must equal it and
   `git status --porcelain --ignored` must print nothing (Git checks every
   object against that commit). The bank is compared as a full manifest,
   `find <bank> -type f -print0 | sort -z | xargs -0 sha256sum` (names and
   hashes only), against the manifest recorded when the owner approved that
   bank.
2. Render the overlay with the platform base and inspect the result. Do not
   `up`, restart, reload, migrate, or expose anything at this step.
3. With the migration-011 API still serving, build and run only the explicit
   `quiz-by-quiz-migrate` service from the candidate source. Require ledger
   versions 001–012, the `online_rankings` table with its six checks and
   `online_rankings_match_player_key`, its four indexes,
   `quiz_online.prune_online_rankings()` as `SECURITY DEFINER`, the runtime
   role's `SELECT`/`INSERT`-only access to the table and `EXECUTE` on the
   function, the `solo_rooms` table cascading from `rooms` with
   `solo_rooms_one_per_player` and `SELECT`/`INSERT`-only runtime access, and
   no ranking record yet. The 011 API's public
   `/v1/release-readiness` now answers 503 `migration-required`; that is the
   expected fail-closed state, not an outage.
4. Build and replace only `quiz-by-quiz-api` with the candidate. Require
   internal `/readyz`, verify that `PUT /v1/session` answers `rankings: true`
   and `soloPlay: true` (a #108-only API also reports `schemaVersion: 12`;
   `soloPlay` tells them apart — `smoke.py candidate` checks both)
   and refuses an e-mail-shaped nickname with 400 `nickname-personal-info`,
   that `GET /v1/rankings?mode=all&period=week` answers 200 with at most 10
   entries and an Asia/Seoul window, and require the exact public
   `/v1/release-readiness` response
   `{status: ready, contract: character-only-v1, schemaVersion: 12}`.
5. Verify HTTPS and WSS through the existing Caddy route without changing any
   unrelated platform service or host-port exposure.
6. Only after the production readiness response passes may the independent
   public Pages source be merged and published. The Pages workflow repeats this
   gate and fails closed before `deploy-pages`.

The preceding boundary was **migration 011 → API → Pages** (#106). Migration
011 stores the host-chosen online question time (20 or 40 seconds, default 20)
on rooms, copies it onto each match, and widens the answer `elapsed_ms` range to
40 seconds. It only adds defaulted, constrained columns: the migration-010 API
names its columns explicitly and never reads or writes them, so it keeps
serving (at its fixed 20 seconds) while 011 runs and remains a valid rollback
target afterwards. The migration-011 API reads and writes those columns, so it
must not replace the 010 API before ledger version 011 exists. Its Pages client
sends `questionTimeMs`, which the 010 API rejects as an unknown field, so Pages
waited for that API. Its steps were the ones above with ledger versions
001–011, the `rooms_question_time_check`, `matches_question_time_check` and
`match_answers_elapsed_ms_range_check` constraints and `question_time_ms =
20000` on every pre-existing room and match after step 3, a room created
without `questionTimeMs` reporting `questionTimeMs: 20000` after step 4, and the
exact readiness `{status: ready, contract: character-only-v1, schemaVersion:
11}`. A database still at migration 010 (production today) must complete that
order with a migration-011 API before step 3 above — and run that whole boundary
from the #107 source checkout (`QUIZ_BY_QUIZ_SOURCE_DIR` at the approved #107
commit, its `app.release_check` and its `smoke.py` with `baseline` = the
migration-010 API and `candidate` = the migration-011 API). This candidate's
`quiz-by-quiz-migrate` cannot stop at 011: on a migration-010 database it
applies 011 and 012 together (`pending-migrations` names `11, 12`), which would
leave the 010 API serving on a migration-012 database, a state no step here
covers; and this candidate's `smoke.py` has no migration-010 baseline. The
current candidate API does not run on a migration-010 or migration-011
database.

The boundary before that was **API → migration 010 → Pages**: never run the 010
constraint migration while a legacy API process can still write `false` or
`NULL` values. A database still at migration 009 must first complete that
order with a migration-010 API (all five character-only constraints and
readiness `schemaVersion: 10`) before the 011 boundary; the current candidate
API does not run on a migration-009 database.

If a stage fails, remove or stop only the task-owned release/service artifacts.
Do not restart, reload, alter, or roll back unrelated n8n, BTC, Caddy,
PostgreSQL, or platform resources.

### Read-only release checks

`python -m app.release_check` ships in the runtime image and replaces the
hand-written SQL and shell checks of the staging order. It runs through the
existing services, so it needs no new secret or mount. It never writes to the
database (the session sets `default_transaction_read_only`, and every check
runs in its own transaction opened `READ ONLY` and verified before the check
sends anything, so it holds even where a session setting would not carry over),
never reads `QUIZ_DB_PASSWORD` or touches the runtime role, and never prints a
connection string, question content, or question id. Each line is `OK`,
`FAIL`, `WARN`, or `INFO` plus a check name, the last line is the verdict, and
the exit status is 0 only when no line is `FAIL`. Stop on a non-zero exit. In
the commands below, `docker compose …` is the platform base rendered with this
overlay.

- **Step 3, before the migration** (candidate image, migration-011 API still
  serving):
  `docker compose … --profile migration run --rm --no-deps quiz-by-quiz-migrate /app/.venv/bin/python -m app.release_check db --expect 11`.
  It requires ledger 1–11 and `character_only_schema_version() = 11`, the five
  010 character-only constraints, both 011 `question_time_ms` columns as
  `integer NOT NULL DEFAULT 20000` with their validated checks, exactly one
  `elapsed_ms` check of 0..40000, no 012 table (`rankings-table`), a safe
  `quiz_by_quiz_app` (the attributes `app.migrate` demands, `EXECUTE` on the
  schema-version function, effective `SELECT`/`INSERT`/`UPDATE` on
  `question_time_ms`, no access to the ledger), and the statement-logging
  preflight above: `log_statement`, `log_min_duration_statement`,
  `log_duration` and statement sampling must be off (`FAIL`);
  `log_min_error_statement` and any per-database or per-role logging setting are
  `WARN`, because a failed `ALTER ROLE … PASSWORD` could be logged with the
  password. `question-time-values` counts the stored values (`INFO`; the 011
  API writes `40000` rooms) and fails on anything but `20000`/`40000`.
  `pending-migrations` names what this image's `app.migrate` would apply
  (`12`), `migration-lock` warns while another migrator holds the advisory
  lock, and `active-matches`/`recent-members` report activity as `INFO`; add
  `--require-idle` to fail while a match is running or revealing.
- **Step 3, after `quiz-by-quiz-migrate`**: the same command with `--expect 12 --require-empty-rankings`.
  It requires ledger 1–12, the ranking table's 15 columns (`board` and
  `week_start` stored generated, `id` an identity, `owner_key` a nullable
  `bytea`), its six validated checks (`online_rankings_owner_key_length` must
  require 32-byte keys) and `online_rankings_match_player_key`, its four indexes valid
  (including `online_rankings_player_board_order_idx`),
  `prune_online_rankings()` `SECURITY DEFINER` with a fixed `search_path`, and
  the runtime role's effective `SELECT`/`INSERT` on the table without `UPDATE`,
  `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` (table or column grants),
  `EXECUTE` on the prune function, still without ledger access. For solo
  online play it requires `solo_rooms` with its three columns
  (`solo-rooms-table`), `room_id` referencing `rooms` `ON DELETE CASCADE` and
  `solo_rooms_one_per_player` (`solo-rooms-constraints`), and the runtime
  role's `SELECT`/`INSERT`-only access (`runtime-solo-rooms-access`); before
  012 `solo-rooms-table` requires the table to be absent.
  `rankings-records` counts the records; `--require-empty-rankings` fails on
  any, because until step 4 only the migration-011 API serves and it never
  writes the table, so a record means the candidate API ran too early. After
  step 4 run `--expect 12` without it: records are then expected and only
  counted (`INFO`).
- At the preceding 011 boundary the same commands ran with `--expect 10` before
  the migration and `--expect 11 --require-default-question-time` after it
  (every room and match still at `20000`, because only the migration-010 API
  served until its step 4). Run them from the #107 image for a database still at
  migration 010: this image's migrate service cannot stop at 011 (it applies 11
  and 12 together), so its `--expect 11` check after migrating would fail with
  "latest version is 12".
- **Step 3, first — the private bank** (before the `db` checks, while the
  migration-011 API still serves):
  `docker compose … --profile migration run --build --rm --no-deps -e QUESTION_BANK_DIR=/run/quiz-by-quiz/online-bank --volume "<QUIZ_ONLINE_BANK_DIR>:/run/quiz-by-quiz/online-bank:ro" quiz-by-quiz-migrate /app/.venv/bin/python -m app.release_check bank`.
  It builds the candidate migrate image, mounts only the bank read-only and
  loads it exactly as the candidate API will at startup, so a bank the candidate
  would refuse stops the release while the database is still at 11. Do not build
  the `quiz-by-quiz-api` image for this: once that image changes, the next
  `docker compose up` could replace the 011 API before migration 012. It prints
  counts only: questions per category (`FAIL` below the 10 a category round
  needs), ids longer than 64 characters (`FAIL` — `match_questions.question_id`
  is `varchar(64)`, so the API would start but a match that draws one could
  not), ids in the public Pages form `<category>-<digits>` (`FAIL`: the
  candidate catalog refuses them with a `CatalogError` that names only a count
  and file names — the migration-010 API accepted any unique id, so a bank that
  serves today can still fail here, and renaming is an owner decision described
  in `ONLINE_QUESTION_BANK.md`), other ids without the `online-` prefix
  (`WARN`), ids that are not `online-<category>-<digits>` (`WARN`, ids reach
  public issue reports), any other `CatalogError` with its class and message (a
  known id in the message is shown as `<id>`), the public `data/` path
  (`FAIL`), and other-user access to the mount (`WARN`). It cannot see whether
  the content was copied from the public bank; `ONLINE_QUESTION_BANK.md` forbids
  that whatever the ids are, so the approved-bank hash of step 1 stays the gate
  for that. A serving candidate API answers the same through
  `docker compose … exec quiz-by-quiz-api /app/.venv/bin/python -m app.release_check bank`.

### Smoke test through Caddy

`deploy/oracle/smoke.py` is a Python 3 standard-library script for the Oracle
host (no curl, jq or openssl). It creates one throwaway browser identity, a
public two-seat room and an event socket through the public Caddy route, checks
the answers, and always leaves the room again (also on Ctrl-C, SIGTERM and
SIGHUP). It never prints tokens, tickets or response bodies, and exits 0 only
when every step is `ok`.

- Before step 3: `python3 deploy/oracle/smoke.py baseline` (the migration-011
  API, readiness `schemaVersion: 11`; a room created without `questionTimeMs`
  reports 20000 and its players carry `connected`; 40000 is accepted and 30000
  refused). Its websocket result is the baseline for step 5: a later websocket
  failure then points at the candidate, not at the host's route.
- After step 3: `python3 deploy/oracle/smoke.py baseline-migrated` (the same
  API on a migration-12 database; readiness must be 503 `migration-required`).
- After step 4: `python3 deploy/oracle/smoke.py candidate` (readiness
  `schemaVersion: 12`; the session answers `rankings: true` and `soloPlay: true`
  — a #108-only API fails here; an e-mail-shaped
  nickname is refused with 400 `nickname-personal-info` without changing the
  profile; an anonymous `GET /v1/rankings?mode=all&period=week` and an
  identified all-time history read answer 200 with exactly the public fields,
  at most 10 entries, an Asia/Seoul week window and no anonymous `isMine`, and
  an unknown board is 400 `invalid-ranking`; then the same room, settings and
  socket checks as the baseline — the socket answers 101 `qbb.v1` and echoes
  one movement message). It opens no match, so it records nothing in the
  ranking.

If the host cannot reach its own public address, add `--resolve-to 127.0.0.1`;
the URL host still names the Host header and the TLS certificate.

## Operational log and uptime monitor

### Operational log (`quiz.ops`)

The API writes its own operational log: one JSON object per line on the
container's stderr, at INFO, through a dedicated handler of the `quiz.ops`
logger (`server/app/ops_log.py`). It does not depend on the Uvicorn
`--log-level warning` of the runtime `CMD` and is not propagated to other
loggers, so each line appears once. Docker keeps it in the existing json-file
log of `quiz-by-quiz-api` (10 MB × 3); there is no new volume, port or service.
In the commands below `docker compose …` is the platform base rendered with this
overlay, as above; `docker logs <container>` works too but prints the
container's stderr on the CLI's stderr (add `2>&1` before a pipe).

```sh
# the latest summaries
docker compose … logs --no-log-prefix --since 1h quiz-by-quiz-api | grep -F '{"event":"summary"'
# unhandled server errors of the last day
docker compose … logs --no-log-prefix --since 24h quiz-by-quiz-api | grep -F '{"event":"server_error"'
# follow every operational event (warnings and tracebacks are not JSON lines)
docker compose … logs --no-log-prefix -f quiz-by-quiz-api | grep --line-buffered -F '{"event":'
# summaries as a table, with the host's python3 (no jq needed)
docker compose … logs --no-log-prefix --since 24h quiz-by-quiz-api | python3 -c '
import json, sys
for line in sys.stdin:
    if line.startswith("{\"event\":\"summary\""):
        e = json.loads(line)
        print(e["ts"], e["rooms"], e["matches"], e["requests"], e["rateLimited"], e["latencyMs"])
'
```

Sample lines:

```json
{"event":"api_started","ts":"2026-10-27T03:00:01.214Z","schemaVersion":12}
{"event":"room_created","ts":"2026-10-27T03:02:12.342Z","room":"K7PQ2M","capacity":6,"category":"all","questionTimeMs":20000,"locked":false}
{"event":"member_joined","ts":"2026-10-27T03:02:40.118Z","room":"K7PQ2M","players":2}
{"event":"match_started","ts":"2026-10-27T03:04:03.977Z","room":"K7PQ2M","players":4,"category":"science","questionTimeMs":40000,"questions":10}
{"event":"match_finished","ts":"2026-10-27T03:10:52.006Z","room":"K7PQ2M","via":"sweep"}
{"event":"host_transferred","ts":"2026-10-27T03:12:30.401Z","room":"K7PQ2M","reason":"host-absent"}
{"event":"server_error","ts":"2026-10-27T03:13:07.552Z","method":"POST","route":"/v1/rooms/{raw_code}/match/answers","error":"ConnectionError"}
{"event":"summary","ts":"2026-10-27T03:15:00.012Z","windowSeconds":300,"sockets":14,"players":12,"rooms":{"waiting":3,"playing":1},"matches":1,"requests":{"total":1185,"2xx":1161,"3xx":0,"4xx":24,"5xx":0},"rateLimited":2,"unhandled":0,"latencyMs":{"p50":20.0,"p95":50.0,"max":212.4}}
```

| Event | Fields | When |
| --- | --- | --- |
| `api_started` / `api_stopped` | `schemaVersion` (start only) | Lifespan start and shutdown. A restart also ends kick blocks and presence records (single-worker memory). |
| `room_created` | `room`, `capacity`, `category` (`all` for the all-categories round), `questionTimeMs`, `locked` | A room is created. |
| `room_deleted` | `room`, `reason` (`empty`) | The last member left. Rooms removed by the cleanup sweep are counted in `cleanup`. |
| `member_joined` / `member_left` | `room`, `players` (members after the change) | A new membership (re-entering an existing one is not) / leaving through the API. |
| `member_removed` | `room`, `players`, `blocked` | The host removed someone; `blocked` is the 10-minute kick of a connected member. |
| `host_transferred` | `room`, `reason` (`host-left`, `host-absent`) | The host left, or the presence sweep moved the seat from a disconnected host. Cleanup handovers are counted in `cleanup`. |
| `match_started` | `room`, `players`, `category`, `questionTimeMs`, `questions` | The host started a match. |
| `match_finished` | `room`, `via` (`sweep`, `request`) | The last reveal ended, closed by the deadline sweep or by a player's read. |
| `solo_started` | `room`, `created` (the solo room was created by this request), `category`, `questionTimeMs`, `questions` | A solo online match started from the home (FR-7.13 step 3). Solo starts write this line instead of `room_created` and `match_started`; `match_finished` is the same. |
| `cleanup` | `roomsDeleted`, `membersRemoved`, `hostsTransferred`, `matchesDeleted`, `playersDeleted`, `rankingsPruned` | A 60-second cleanup tick that changed anything (no line otherwise); `rankingsPruned` counts ranking records past their retention ("Online rankings"). |
| `server_error` | `method`, `route` (the route template, e.g. `/v1/rooms/{raw_code}`), `error` (exception class) | An exception no handler turned into a response; the client gets 500 and Uvicorn still logs the traceback as before. |
| `summary` | see below | Every 5 minutes. |

`summary` covers the window since the previous summary (`windowSeconds`).
`sockets` is the open event sockets, `players` the (room, player) pairs with at
least one live socket, `rooms.waiting`/`rooms.playing` the unexpired rooms
without/with a running or revealing match, and `matches` the running or
revealing matches; those three come from one aggregate query per summary and
are `null` when it failed (the warning `ops summary room counts failed` follows).
`requests` counts REST responses by status class, `rateLimited` the `429`s and
`unhandled` the exceptions that became `500` (each also has a `server_error`
line). The private health checks used by Docker and Caddy (`/healthz`,
`/readyz`) and WebSockets are not counted. `latencyMs` is the time to the end of
the response: `p50` and `p95` are the upper bound of the fixed bucket holding
that rank (1, 2, 5, 10, 20, 50, 100, 200, 500, 1,000, 2,000, 5,000 and
10,000 ms, never above `max`), `max` the slowest request, all `null` in a window
without requests.

**Never logged:** nicknames, room names, chat text, bearer tokens or their
hashes, WebSocket tickets, IP addresses or `X-Forwarded-For`, player ids,
passwords or password hashes, question ids or content, request paths with their
values, query strings, bodies, and exception messages (they can carry SQL
values). Each event is a function whose parameters are its fields
(`EVENT_FIELDS`); there is no free-form field, and unexpected values are
written as `<invalid>`. Room codes and counts are logged; a room code is the
six characters the lobby already shows and is reused after the room is gone.
`server/tests/test_ops_log.py` drives a room's whole life through the API with
personal data in every value, including a match whose question id, text,
choices, explanation and review pass through the responses, and asserts that
none of it reaches a line.

Resource envelope: the request counters are fixed-size (14 latency buckets, 5
status classes and three numbers) whatever the traffic, nothing is retained per
request, and the per-request cost is a bisect and a few increments. Events are
per room, membership and match, not per request, so a busy classroom day is on
the order of a few thousand lines (well under 1 MB) plus 288 summaries, and the
30 MB json-file budget still holds weeks of history alongside the warnings. This
changes none of the limits above.

### Uptime monitor

`.github/workflows/uptime.yml` runs `deploy/oracle/uptime.py check` every 15
minutes and on `workflow_dispatch` (`gh workflow run uptime.yml`). It only
reads — no session, room or socket is created; `smoke.py` stays the write check
for deploys. It checks that:

- `GET /v1/release-readiness` answers 200 with `status: ready`,
  `contract: character-only-v1` and a `schemaVersion` at least the one the Pages
  workflow's `backend-ready` job waits for (read from `.github/workflows/pages.yml`
  of the same checkout, so the two never drift), with
  `Access-Control-Allow-Origin: https://perust.github.io`, within 5 seconds;
- `https://perust.github.io/quiz-by-quiz/` answers 200 itself (redirects are not
  followed) and its `quiz-api-base` meta names that same API.

A failing check is tried three times in all, 5 and 15 seconds apart; a `429`
waits for its `Retry-After` (at most 60 seconds) instead, a response slower than
5 seconds counts as a failed attempt, and every request times out after 15
seconds. Only then does the check fail. The report is a few lines of status
codes, error codes and the checked values:

```text
quiz-by-quiz uptime check 2026-10-27T13:04:44Z
api: https://quiz-by-quiz-api.150.230.222.142.sslip.io
pages: https://perust.github.io/quiz-by-quiz/
expected schemaVersion >= 12 (pages.yml backend-ready)
ok readiness: HTTP 200 ready character-only-v1 schemaVersion 12 (want >= 12), CORS ok, 0.28s
ok pages: HTTP 200, quiz-api-base "https://quiz-by-quiz-api.150.230.222.142.sslip.io", 0.27s
verdict: ok
```

and on failure, for example, `FAIL readiness: HTTP 503 migration-required
(after 3 attempts)` followed by `verdict: FAIL`.

On failure the workflow (permissions `contents: read` and `issues: write`, the
`GITHUB_TOKEN` through the `gh` CLI) opens one issue labelled `운영 경보` with
the report and the run URL, or comments on the open one — there is never more
than one open alert — and then fails the job, so GitHub sends its failed-run
e-mail. For scheduled runs GitHub mails the user who created the workflow, then
whoever last changed its `cron` line or re-enabled it, if their notification
settings include failed Actions workflows. The next passing run comments that
the service recovered and closes the alert. Runs share one concurrency group:
at most one runs and one waits, and a running check is not cancelled. A run
that is cancelled — by hand, or by reaching the job's 10-minute limit — opens,
comments on and closes nothing (the alert steps run only when `!cancelled()`),
because a check that never finished is not a failed check. A check that hangs
is still reported: the probe step has its own 8-minute limit, above the
longest designed check (two checks of three attempts, each request waiting up
to 15 seconds to connect and 15 more for the response, with waits of at most
60 seconds, 7 minutes in all), and a step that reaches it fails without
cancelling the run, so the alert says the report is missing and the job
fails. The repository is public, so the runs cost no Actions minutes and the
alert issues are public too; the report holds nothing that is not already
public.

- Scheduled workflows run only from the default branch, so the monitor starts
  once this file is on `main`. GitHub may delay scheduled runs at busy times,
  and in a public repository it disables a schedule after 60 days without
  repository activity; re-enable it in the Actions tab or with
  `gh workflow enable uptime.yml`.
- A planned deploy window opens an alert: while a migration runs ahead of its
  API (step 3 until step 4 of the staging order) the serving API answers 503
  `migration-required`. Disable the monitor before step 3 with
  `gh workflow disable uptime.yml` and enable it again with
  `gh workflow enable uptime.yml` once the public readiness response passes; a
  run already in progress may still report the window.
- Run it by hand from any machine with Python 3.8 or newer:
  `python3 deploy/oracle/uptime.py check` (exit 0 only when the verdict is `ok`).
