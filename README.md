# gcs-job-scheduler

Durable cron/interval job scheduler for GCS-style maintenance jobs — retries with
exponential backoff, run history, a zero-dependency HTTP API, and a zero-dependency CLI.
TypeScript with strict typing. Node >= 20, runs anywhere Node runs (no Bun requirement).

## The problem

GCS maintenance work — lifecycle cleanup of expired objects, inventory snapshots,
transfer verification — needs to run on a schedule, survive process restarts, and
retry transient failures (429s, 503s, network blips) without losing track of what
already ran. The usual answers are a heavyweight orchestrator (too much
infrastructure for three cron jobs) or `setInterval` in a long-lived process (loses
all state on restart, no retry discipline, no history).

## The solution

`gcs-job-scheduler` is a single dependency-free package that gives you:

- **Cron and interval schedules** — full 5-field cron expressions (minute
  granularity, UTC) or simple `every N seconds` intervals.
- **Retries with exponential backoff** — per-job policy; each failed run retries on
  a doubling timeline (`backoffMs * 2^(attempt-1)`, capped at 1h) before the run is
  marked permanently failed and the schedule resumes.
- **Per-attempt timeouts** — a hung handler is treated as a transient failure and
  retried; the attempt is aborted via `AbortSignal`.
- **Durable state** — jobs and run history persist to a JSON file with atomic
  tmp+rename writes; a restart never double-fires a missed schedule (a job whose
  schedule lapsed while down resumes on its *next* slot, not a stampede of catch-ups).
- **Run history** — every attempt is recorded (outcome, duration, error); capped and
  queryable by job, outcome, and limit.
- **HTTP API and CLI** — drive the scheduler from cron, CI, or another service; both
  are built only on Node built-ins (zero runtime dependencies).
- **Pluggable handlers** — HTTP-call jobs out of the box (any 2xx is success), or
  register in-process handlers when embedding the library.

Alternatives trade one problem for another: `node-cron` has no persistence or retry
semantics; BullMQ needs Redis; Cloud Scheduler needs a GCP project and bills per
job. This package is the small, honest middle: one JSON file, one process, real
retry semantics.

## How it works

```
              ┌─────────────────────────────────────────────────┐
  tick()  ──▶ │ due(now): enabled jobs with nextRunAt <= now    │
  HTTP /tick  │                                                 │
              │  for each due job:                              │
              │   open or resume its run record                 │
              │   execute handler (timeoutMs, AbortSignal)      │
              │     ├─ success ──▶ nextRunAt = schedule.next()  │
              │     ├─ failure ──▶ attempt <= maxRetries:       │
              │     │               nextRunAt = now + backoff   │
              │     └─ exhausted ▶ run failed; nextRunAt =      │
              │                     schedule.next()             │
              │  append attempts to the run record              │
              │  prune history to historyLimit                  │
              └─────────────────────────────────────────────────┘
                    │                    │
              persist (atomic)      HTTP API / CLI
```

Key concepts:

- **Job** — a named schedule + handler + policy (timeout, retries, backoff). Jobs
  have stable ids (`j-000001`, never reused) and can be enabled/disabled without
  being deleted.
- **Run** — one execution of a job, possibly across several attempts. A retrying
  run resumes on a later tick instead of forking a second run.
- **Handler** — `{ kind: "http", url, method?, headers?, body? }` (any 2xx is
  success), `{ kind: "noop" }` (always succeeds), or `{ kind: "named", handler }`
  for in-process functions registered with `scheduler.setHandler`.
- **Tick** — the unit of scheduling work. Call it from a loop, a cron job, or the
  HTTP API; the scheduler decides what is due.

## Getting started

Install from GitHub (the package is not on npm; the `prepare` script builds it):

```bash
npm install github:Retsumdk/gcs-job-scheduler
```

Bun blocks lifecycle scripts of git dependencies by default — run `bun pm trust gcs-job-scheduler`
after `bun add github:Retsumdk/gcs-job-scheduler`, or use npm, which runs `prepare` automatically.

Or clone and build:

```bash
git clone https://github.com/Retsumdk/gcs-job-scheduler.git
cd gcs-job-scheduler
bun install
bun run build
```

Requires Node >= 20 (or Bun >= 1.2). Development dependencies are TypeScript and
type definitions only; there are zero runtime dependencies.

## Library usage

```ts
import { Scheduler } from "gcs-job-scheduler";

const scheduler = new Scheduler();

// HTTP handler: calls the GCS JSON API. Any 2xx response is success.
scheduler.add({
  name: "cleanup-expired-objects",
  cron: "0 3 * * *", // 03:00 UTC daily
  handler: {
    kind: "http",
    url: "https://storage.googleapis.com/storage/v1/b/my-bucket/o?deleteAfter=2026-01-01",
    method: "POST",
  },
  maxRetries: 2,
  backoffMs: 5_000,
});

// In-process handler.
scheduler.setHandler("inventory", async ({ job }) => {
  return `snapshot for ${job.name}`;
});
scheduler.add({
  name: "inventory-snapshot",
  every: 3_600, // every hour
  handler: { kind: "named", handler: "inventory" },
});

// Drive the scheduler (from setInterval, a cron job, or the HTTP API):
const result = await scheduler.tick();
console.log(result); // { started: 1, succeeded: 1, failed: 0, retrying: 0, runs: [...] }
```

Run a job once, outside its schedule:

```ts
const run = await scheduler.runOnce("cleanup-expired-objects");
console.log(run.outcome); // "succeeded" | "failed" | "retrying"
```

Persist and restore (state survives restarts; a lapsed schedule resumes on its
next slot instead of stampeding through missed ones):

```ts
await scheduler.persist("/var/lib/gcs-jobs/state.json");
const revived = await Scheduler.restore("/var/lib/gcs-jobs/state.json");
```

## CLI

```bash
npx gcs-job-scheduler create --name cleanup --cron "0 3 * * *" \
  --url "https://storage.googleapis.com/storage/v1/b/my-bucket/o" --method POST \
  --max-retries 2 --backoff-ms 5000 --state jobs.json
# created j-000001 "cleanup" — cron(0 3 * * *) — handler POST https://... — retries 2 — next run ...

npx gcs-job-scheduler tick --state jobs.json
npx gcs-job-scheduler list --all --state jobs.json
npx gcs-job-scheduler stats --state jobs.json
npx gcs-job-scheduler serve --port 8931 --state jobs.json
```

Commands: `demo`, `create`, `list [--all]`, `get <job>`, `rm <job>`, `enable <job>`,
`disable <job>`, `run <job>`, `tick`, `stats`, `runs [--job <id>] [--outcome <o>] [--limit N]`,
`serve [--port N]`. Exit codes: 0 success, 1 runtime/validation failure, 2 usage error.

## Demo output

`gcs-job-scheduler demo` runs a deterministic walkthrough on a fixed clock — a
cron job and an interval job whose first attempt hits a simulated GCS 503 and
recovers on retry:

```
scheduler demo (fixed clock, starts 2026-01-01T09:00:00.000Z)
jobs: j-000001 cleanup-expired-objects cron(*/2 * * * *); j-000002 inventory-snapshot every 120s (maxRetries 1)
+060s tick: started 0, succeeded 0, failed 0, retrying 0
+120s tick: started 2, succeeded 1, failed 0, retrying 1
    run r-000001 cleanup-expired-objects -> succeeded (1 attempt)
    run r-000002 inventory-snapshot -> retrying (1 attempt)
+180s tick: started 1, succeeded 1, failed 0, retrying 0
    run r-000002 inventory-snapshot -> succeeded (2 attempts)
stats: jobs 2 (2 enabled), runs 2 (2 succeeded, 0 failed), success rate 100.0%
inventory handler called 3 time(s)
```

## HTTP API

Start with `serve` (or `startServer(scheduler, { port, token })` from the library).
Reads are always open; mutations require `Authorization: Bearer $SCHEDULER_TOKEN`
when that environment variable (or the `token` option) is set.

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Liveness |
| GET | `/stats` | Job/run aggregates, success rate, next due time |
| GET | `/jobs?enabled=true\|false` | List jobs |
| POST | `/jobs` | Create a job (`{ name, cron \| everySeconds, handler, enabled?, timeoutMs?, maxRetries?, backoffMs? }`) |
| GET | `/jobs/:id` | One job |
| PATCH | `/jobs/:id` | Update (`{ enabled?, timeoutMs?, maxRetries?, backoffMs?, everySeconds?, cron? }`) |
| DELETE | `/jobs/:id` | Remove a job |
| POST | `/jobs/:id/run` | Manual run (409 if the job is disabled) |
| POST | `/jobs/:id/enable` · `/jobs/:id/disable` | Flip the enabled flag |
| POST | `/tick` | Run every due job once, now |
| GET | `/runs?job=&outcome=&limit=` | Run history, newest first |

Errors are JSON: `{ "error": { "code": "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "CORRUPTION", "message": "..." } }`
with matching HTTP status codes (400/404/409/500); unauthenticated mutations get
401 `UNAUTHORIZED`.

## Semantics and limits

- **Cron** — 5 fields (minute hour day-of-month month day-of-week), minute
  granularity, UTC. Supports `*`, lists, ranges, and steps (`*/15`, `9-17`,
  `1,15`, `0 9-17 * * 1-5`). Day-of-month and day-of-week follow standard cron OR
  semantics when both are restricted. Expressions that can never fire (e.g.
  `0 0 30 2 *` — February 30th) return no next slot; `add` rejects them.
- **Intervals** — 1 second to 30 days (`everySeconds`). Interval jobs run `now + N`
  after each completion (drift-tolerant, not fixed-rate).
- **Retries** — up to `maxRetries` (default 2) re-executions per run; the backoff
  doubles per attempt (`backoffMs`, `2·backoffMs`, … capped at 1h). A retrying run
  resumes on a later tick; exhausting retries marks the run failed and the next
  scheduled slot proceeds normally.
- **Persistence** — JSON with atomic tmp+rename writes; history capped at
  `historyLimit` (default 1000) runs. Corrupt state files throw `CORRUPTION` errors
  rather than silently resetting.
- **Overlapping ticks are safe** — a job with an in-flight scheduled attempt is
  skipped by concurrent ticks (two `/tick` requests, or a loop racing the HTTP
  API, cannot double-fire the same due slot). Manual `runOnce` calls are
  intentionally outside this guard — they are explicit user-triggered runs.
- **Not a process supervisor** — one process owns the state file. Run multiple
  replicas only if each has its own state path.

## Project layout

```
src/
  cron.ts        5-field cron parser, matcher, next-slot search, human descriptions
  schedule.ts    interval + cron schedule validation and next-run computation
  scheduler.ts   the engine: jobs, ticks, retries, backoff, history, persistence
  handlers.ts    http/no-op/named handler execution, timeouts, handler validation
  store.ts       atomic JSON state persistence + strict schema validation
  server.ts      zero-dependency HTTP API with bearer auth
  cli.ts         zero-dependency CLI (node:util parseArgs)
  demo.ts        deterministic demo transcript
  errors.ts      typed error hierarchy with HTTP status mapping
tests/           66 tests across 7 suites (bun test)
```

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit (strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes)
bun test            # 66 tests
bun run build       # emits dist/ with declarations
bun run demo        # node dist/cli.js demo
```

## Related repos

- [agent-task-queue](https://github.com/Retsumdk/agent-task-queue) — one-shot task queue with retries and a dead-letter queue
- [serverless-retry-queue](https://github.com/Retsumdk/serverless-retry-queue) — durable retry queue with leases and poison handling
- [cron-scheduler-service](https://github.com/Retsumdk/cron-scheduler-service) — schedule registration and firing service

## License

MIT — see [LICENSE](LICENSE).
