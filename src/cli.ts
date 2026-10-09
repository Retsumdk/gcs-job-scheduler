#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Scheduler } from "./scheduler.js";
import { isSchedulerError } from "./errors.js";
import type { HandlerSpec, Job, RunOutcome, RunRecord } from "./types.js";
import { startServer } from "./server.js";
import { runDemo } from "./demo.js";

export const COMMANDS = [
  "demo",
  "create",
  "list",
  "get",
  "rm",
  "enable",
  "disable",
  "run",
  "tick",
  "stats",
  "runs",
  "serve",
] as const;

export function isKnownCommand(command: string): boolean {
  return (COMMANDS as readonly string[]).includes(command);
}

export const HELP = `gcs-job-scheduler — durable cron/interval scheduler for GCS maintenance jobs

Usage: gcs-job-scheduler [--state <file>] <command> [options]

Commands:
  demo                Run the deterministic walkthrough (no state file needed)
  create              Create a job (--name required; exactly one of --cron / --every)
  list [--all]        List jobs (disabled jobs marked "[disabled]")
  get <job>           Show one job by id or name
  rm <job>            Remove a job
  enable <job>        Re-enable a job
  disable <job>       Stop scheduling a job (it stays in the state file)
  run <job>           Trigger one immediate run, outside the schedule
  tick                Run every due job once, now
  stats               Aggregate stats over jobs and run history
  runs                Recent run history (--limit N, --outcome O, --job <id>)
  serve [--port N]    HTTP API server; writes require bearer auth when
                      the SCHEDULER_TOKEN environment variable is set

Create flags:
  --name <name>       Unique job name
  --cron "<expr>"     5-field cron expression, minute granularity, UTC
                      (e.g. "*/15 * * * *")
  --every <seconds>   Simple interval schedule (e.g. --every 3600)
  --url <url>         HTTP handler: each run calls this URL (e.g. a GCS
                      JSON API endpoint); any 2xx response is success
  --method <m>        HTTP method for --url (default GET)
  --header "K: V"     Repeatable request header for the HTTP handler
  --body <text>       Request body (requires a non-GET --method)
  --handler <name>    Named in-process handler (library embedding; registered
                      via scheduler.setHandler)
  --timeout-ms N      Per-attempt timeout (default 30000)
  --max-retries N     Retry attempts per run before the run fails (default 2)
  --backoff-ms N      Base retry backoff, doubled per attempt, capped at 1h
                      (default 60000)

Common flags:
  --state <file>      Persist scheduler state to <file> (JSON, atomic writes)
  --limit N           Cap listing output
  --outcome <o>       Filter runs: running | succeeded | failed | retrying

Exit codes: 0 success, 1 runtime/validation failure, 2 usage error.`;

type Options = Record<string, string | string[] | boolean | undefined>;

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function dieUsage(message: string): never {
  throw new UsageError(`${message}\n\n${HELP}`);
}

const SHARED_OPTIONS = {
  name: { type: "string" },
  cron: { type: "string" },
  every: { type: "string" },
  url: { type: "string" },
  method: { type: "string" },
  header: { type: "string", multiple: true },
  body: { type: "string" },
  handler: { type: "string" },
  "timeout-ms": { type: "string" },
  "max-retries": { type: "string" },
  "backoff-ms": { type: "string" },
  port: { type: "string" },
  limit: { type: "string" },
  job: { type: "string" },
  outcome: { type: "string" },
  all: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

function num(opts: Options, key: string): number | undefined {
  const raw = opts[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") dieUsage(`--${key} takes one value`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) dieUsage(`--${key} must be a non-negative integer`);
  return n;
}

function parseHeaders(values: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of values ?? []) {
    const idx = raw.indexOf(":");
    if (idx <= 0) dieUsage(`invalid --header "${raw}", expected "Name: value"`);
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    if (key.length === 0) dieUsage(`invalid --header "${raw}", empty header name`);
    headers[key] = value;
  }
  return headers;
}

function targetFrom(opts: Options, positional: string[]): string {
  if (positional.length > 0) return positional[0]!;
  if (typeof opts.name === "string" && opts.name.length > 0) return opts.name;
  dieUsage("provide a job id or name (or --name)");
}

function describeHandler(handler: HandlerSpec): string {
  if (handler.kind === "noop") return "noop";
  if (handler.kind === "named") return `named:${handler.handler}`;
  return `${handler.method ?? "GET"} ${handler.url}`;
}

function describeScheduleOf(job: Job): string {
  return job.schedule.kind === "interval"
    ? `every ${job.schedule.seconds}s`
    : `cron(${job.schedule.expr})`;
}

function printJob(job: Job): void {
  const next = new Date(job.nextRunAt).toISOString();
  const marker = job.enabled ? "" : " [disabled]";
  console.log(
    `${job.id}  ${job.name}${marker}  ${describeScheduleOf(job)}  next ${next}  last ${job.lastStatus}  failures ${job.consecutiveFailures}  handler ${describeHandler(job.handler)}`,
  );
}

function printRun(scheduler: Scheduler, run: RunRecord): void {
  const started = new Date(run.startedAt).toISOString();
  const job = scheduler.get(run.jobId);
  const last = run.attempts[run.attempts.length - 1];
  const suffix = run.result ? ` — ${run.result}` : "";
  console.log(
    `${started}  ${run.id}  ${job?.name ?? run.jobId}  ${run.trigger}  attempts ${run.attempts.length}  ${run.outcome}${last?.error ? ` (${last.error})` : ""}${suffix}`,
  );
}

interface CreateResult {
  name: string;
  cron?: string;
  every?: number;
  handler: HandlerSpec;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

function buildCreateOptions(opts: Options): CreateResult {
  const name = typeof opts.name === "string" ? opts.name.trim() : "";
  if (name.length === 0) dieUsage("--name is required for create");
  const cron = typeof opts.cron === "string" ? opts.cron : undefined;
  const everyRaw = typeof opts.every === "string" ? opts.every : undefined;
  if ((cron === undefined) === (everyRaw === undefined)) {
    dieUsage("provide exactly one of --cron or --every");
  }
  let every: number | undefined;
  if (everyRaw !== undefined) {
    every = Number(everyRaw);
    if (!Number.isInteger(every) || every < 1) dieUsage("--every must be an integer >= 1");
  }
  const hasUrl = typeof opts.url === "string";
  const hasNamed = typeof opts.handler === "string";
  if (hasUrl && hasNamed) dieUsage("provide only one of --url or --handler");
  let handler: HandlerSpec;
  if (hasUrl) {
    const spec: Extract<HandlerSpec, { kind: "http" }> = { kind: "http", url: opts.url as string };
    const headers = parseHeaders(opts.header as string[] | undefined);
    if (Object.keys(headers).length > 0) spec.headers = headers;
    if (typeof opts.method === "string") {
      if (!/^[A-Za-z]+$/.test(opts.method)) dieUsage("--method must be an HTTP method token");
      spec.method = opts.method.toUpperCase();
    }
    if (typeof opts.body === "string") {
      if ((spec.method ?? "GET") === "GET") dieUsage("--body requires a non-GET --method");
      spec.body = opts.body;
    }
    handler = spec;
  } else if (hasNamed) {
    handler = { kind: "named", handler: opts.handler as string };
  } else {
    handler = { kind: "noop" };
  }
  const result: CreateResult = { name, handler };
  if (cron !== undefined) result.cron = cron;
  if (every !== undefined) result.every = every;
  const timeoutMs = num(opts, "timeout-ms");
  if (timeoutMs !== undefined) result.timeoutMs = timeoutMs;
  const maxRetries = num(opts, "max-retries");
  if (maxRetries !== undefined) result.maxRetries = maxRetries;
  const backoffMs = num(opts, "backoff-ms");
  if (backoffMs !== undefined) result.backoffMs = backoffMs;
  return result;
}

async function openScheduler(statePath: string | undefined): Promise<{ scheduler: Scheduler; save: () => Promise<void> }> {
  const scheduler = statePath === undefined ? new Scheduler() : await Scheduler.restore(statePath);
  return {
    scheduler,
    save: async () => {
      if (statePath !== undefined) await scheduler.persist(statePath);
    },
  };
}

export async function runCli(argv: string[], injected?: Scheduler): Promise<number> {
  const { values: opts, positionals } = parseArgs({
    args: argv,
    options: {
      state: { type: "string" },
      ...SHARED_OPTIONS,
    },
    strict: true,
    allowPositionals: true,
  });
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const command = positionals[0];
  if (command === undefined) {
    console.log(HELP);
    return 0;
  }
  if (!isKnownCommand(command)) {
    dieUsage(`unknown command "${command}"`);
  }
  const args = positionals.slice(1);

  if (command === "demo") {
    for (const line of await runDemo()) console.log(line);
    return 0;
  }

  const opened =
    injected !== undefined
      ? { scheduler: injected, save: async (): Promise<void> => {} }
      : await openScheduler(typeof opts.state === "string" ? opts.state : undefined);
  const { scheduler, save } = opened;

  switch (command) {
    case "create": {
      const job = scheduler.add(buildCreateOptions(opts));
      await save();
      console.log(
        `created ${job.id} "${job.name}" — ${describeScheduleOf(job)} — handler ${describeHandler(job.handler)}${job.maxRetries > 0 ? ` — retries ${job.maxRetries}` : ""} — next run ${new Date(job.nextRunAt).toISOString()}`,
      );
      return 0;
    }
    case "list": {
      const jobs = scheduler.list();
      if (jobs.length === 0) {
        console.log("no jobs");
        return 0;
      }
      for (const job of jobs) printJob(job);
      return 0;
    }
    case "get": {
      const job = scheduler.resolve(targetFrom(opts, args));
      printJob(job);
      return 0;
    }
    case "rm": {
      const removed = scheduler.remove(targetFrom(opts, args));
      await save();
      console.log(`removed ${removed.id} "${removed.name}"`);
      return 0;
    }
    case "enable":
    case "disable": {
      const job =
        command === "enable"
          ? scheduler.enable(targetFrom(opts, args))
          : scheduler.disable(targetFrom(opts, args));
      await save();
      console.log(`${job.id} "${job.name}" ${job.enabled ? "enabled" : "disabled"}`);
      return 0;
    }
    case "run": {
      const run = await scheduler.runOnce(targetFrom(opts, args));
      await save();
      printRun(scheduler, run);
      return run.outcome === "succeeded" ? 0 : 1;
    }
    case "tick": {
      const result = await scheduler.tick();
      await save();
      console.log(
        `started ${result.started}  succeeded ${result.succeeded}  retrying ${result.retrying}  failed ${result.failed}`,
      );
      for (const run of result.runs) printRun(scheduler, run);
      return 0;
    }
    case "stats": {
      const s = scheduler.stats();
      console.log(`jobs: ${s.jobs} (${s.enabledJobs} enabled, ${s.disabledJobs} disabled)`);
      console.log(
        `runs: ${s.runs} total, ${s.succeeded} succeeded, ${s.failed} failed (${s.runs - s.succeeded - s.failed} in flight or retrying)`,
      );
      const rate = (s.successRate * 100).toFixed(1);
      console.log(`success rate: ${rate}%`);
      if (s.nextDueAt !== undefined) {
        console.log(`next due: ${new Date(s.nextDueAt).toISOString()}`);
      }
      return 0;
    }
    case "runs": {
      const limit = num(opts, "limit") ?? 20;
      const jobId = typeof opts.job === "string" ? opts.job : undefined;
      const outcome = typeof opts.outcome === "string" ? (opts.outcome as RunOutcome) : undefined;
      const runs = scheduler.runs({
        ...(jobId === undefined ? {} : { jobId }),
        ...(outcome === undefined ? {} : { outcome }),
        limit,
      });
      if (runs.length === 0) {
        console.log("no runs");
        return 0;
      }
      for (const run of runs) printRun(scheduler, run);
      return 0;
    }
    case "serve": {
      const port = num(opts, "port") ?? Number(process.env.PORT ?? 8931);
      const token = process.env.SCHEDULER_TOKEN;
      const server = startServer(scheduler, { ...(token === undefined ? {} : { token }) });
      server.listen(port, "127.0.0.1", () => {
        console.log(
          `gcs-job-scheduler listening on http://127.0.0.1:${port}${token === undefined ? "" : " (writes require bearer auth)"}`,
        );
      });
      const shutdown = (): void => {
        server.close(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return 0;
    }
    default: {
      dieUsage(`unknown command "${command}"`);
    }
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err: unknown) => {
      if (err instanceof UsageError) {
        console.error(`error: ${err.message}`);
        process.exit(2);
      }
      if (isSchedulerError(err)) {
        console.error(`error [${err.code}]: ${err.message}`);
        process.exit(1);
      }
      console.error(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    });
}
