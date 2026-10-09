import type {
  AddJobOptions,
  HandlerFn,
  Job,
  JobStats,
  PatchOptions,
  RunRecord,
  RunsFilter,
  SchedulerOptions,
  SchedulerState,
  Schedule,
  TickResult,
} from "./types.js";
import { SchedulerError } from "./errors.js";
import { nextRunAfter, validateSchedule } from "./schedule.js";
import { saveState, loadState, parseState } from "./store.js";
import { createHttpHandler, runWithTimeout, TimeoutError, validateHandlerSpec } from "./handlers.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 60_000;
const BACKOFF_CAP_MS = 3_600_000;
const MAX_ATTEMPTS_HARD_CAP = 20;
const RESULT_TRUNCATE = 500;
const ERROR_TRUNCATE = 300;
const DEFAULT_HISTORY_LIMIT = 1_000;
const NO_NEXT_RUN = Number.MAX_SAFE_INTEGER;

const KNOWN_ADD_KEYS = [
  "name",
  "every",
  "cron",
  "handler",
  "enabled",
  "timeoutMs",
  "maxRetries",
  "backoffMs",
] as const;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function errorText(err: unknown): string {
  if (err instanceof TimeoutError) return err.message;
  if (err instanceof Error) return truncate(err.message, ERROR_TRUNCATE);
  return truncate(String(err), ERROR_TRUNCATE);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h${pad(m % 60)}m`;
}

export class Scheduler {
  private jobs = new Map<string, Job>();
  private runLog: RunRecord[] = [];
  private handlers = new Map<string, HandlerFn>();
  private seq = 0;
  private runSeq = 0;
  private readonly clock: () => number;
  private readonly historyLimit: number;

  constructor(options: SchedulerOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    for (const [name, fn] of Object.entries(options.handlers ?? {})) {
      this.handlers.set(name, fn);
    }
  }

  setHandler(name: string, fn: HandlerFn): void {
    if (!name.trim()) throw new SchedulerError("VALIDATION", "handler name must be non-empty");
    this.handlers.set(name, fn);
  }

  listHandlers(): string[] {
    return [...this.handlers.keys()].sort();
  }

  add(options: AddJobOptions): Job {
    const unknown = Object.keys(options).filter((k) => !(KNOWN_ADD_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      throw new SchedulerError("VALIDATION", `Unknown option(s): ${unknown.join(", ")}`);
    }
    const name = options.name?.trim();
    if (!name) throw new SchedulerError("VALIDATION", "job name must be a non-empty string");
    for (const job of this.jobs.values()) {
      if (job.name === name) {
        throw new SchedulerError("CONFLICT", `a job named "${name}" already exists (${job.id})`);
      }
    }
    validateHandlerSpec(options.handler ?? { kind: "noop" });
    const schedule = this.buildSchedule(options);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new SchedulerError("VALIDATION", "timeoutMs must be an integer >= 1");
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_ATTEMPTS_HARD_CAP) {
      throw new SchedulerError("VALIDATION", `maxRetries must be an integer between 0 and ${MAX_ATTEMPTS_HARD_CAP}`);
    }
    if (!Number.isInteger(backoffMs) || backoffMs < 1) {
      throw new SchedulerError("VALIDATION", "backoffMs must be an integer >= 1");
    }
    if (options.enabled !== undefined && typeof options.enabled !== "boolean") {
      throw new SchedulerError("VALIDATION", "enabled must be a boolean");
    }
    const now = this.clock();
    this.seq += 1;
    const job: Job = {
      id: `j-${String(this.seq).padStart(6, "0")}`,
      name,
      schedule,
      handler: options.handler ?? { kind: "noop" },
      enabled: options.enabled ?? true,
      timeoutMs,
      maxRetries,
      backoffMs,
      createdAt: now,
      nextRunAt: this.requireNext(schedule, now),
      lastStatus: "idle",
      consecutiveFailures: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private buildSchedule(options: AddJobOptions): Schedule {
    const hasEvery = options.every !== undefined;
    const hasCron = options.cron !== undefined;
    if (hasEvery === hasCron) {
      throw new SchedulerError("VALIDATION", "provide exactly one schedule kind: every (seconds) or cron");
    }
    if (hasEvery) {
      const seconds = options.every as number;
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new SchedulerError("VALIDATION", "every must be an integer number of seconds >= 1");
      }
      return { kind: "interval", seconds };
    }
    const expr = options.cron as string;
    const schedule: Schedule = { kind: "cron", expr };
    validateSchedule(schedule);
    return schedule;
  }

  private requireNext(schedule: Schedule, afterMs: number): number {
    const next = nextRunAfter(schedule, afterMs);
    if (next === null) {
      throw new SchedulerError(
        "VALIDATION",
        "cron expression never fires within the 366-day search horizon",
      );
    }
    return next;
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  resolve(idOrName: string): Job {
    const byId = this.jobs.get(idOrName);
    if (byId) return byId;
    for (const job of this.jobs.values()) {
      if (job.name === idOrName) return job;
    }
    throw new SchedulerError("NOT_FOUND", `no job matches "${idOrName}"`);
  }

  get(idOrName: string): Job | undefined {
    try {
      return this.resolve(idOrName);
    } catch {
      return undefined;
    }
  }

  remove(idOrName: string): Job {
    const job = this.resolve(idOrName);
    this.jobs.delete(job.id);
    return job;
  }

  setEnabled(idOrName: string, enabled: boolean): Job {
    const job = this.resolve(idOrName);
    job.enabled = enabled;
    return job;
  }

  enable(idOrName: string): Job {
    return this.setEnabled(idOrName, true);
  }

  disable(idOrName: string): Job {
    return this.setEnabled(idOrName, false);
  }

  patch(idOrName: string, options: PatchOptions): Job {
    const job = this.resolve(idOrName);
    const unknown = Object.keys(options).filter(
      (k) => !["everySeconds", "cronExpr", "enabled", "timeoutMs", "maxRetries", "backoffMs"].includes(k),
    );
    if (unknown.length > 0) {
      throw new SchedulerError("VALIDATION", `Unknown option(s): ${unknown.join(", ")}`);
    }
    const hasEvery = options.everySeconds !== undefined;
    const hasCron = options.cronExpr !== undefined;
    if (hasEvery && hasCron) {
      throw new SchedulerError("VALIDATION", "provide exactly one schedule kind: everySeconds or cronExpr");
    }
    if (hasEvery) {
      const seconds = options.everySeconds as number;
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new SchedulerError("VALIDATION", "everySeconds must be an integer >= 1");
      }
    }
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new SchedulerError("VALIDATION", "timeoutMs must be an integer >= 1");
    }
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > MAX_ATTEMPTS_HARD_CAP)
    ) {
      throw new SchedulerError("VALIDATION", `maxRetries must be an integer between 0 and ${MAX_ATTEMPTS_HARD_CAP}`);
    }
    if (options.backoffMs !== undefined && (!Number.isInteger(options.backoffMs) || options.backoffMs < 1)) {
      throw new SchedulerError("VALIDATION", "backoffMs must be an integer >= 1");
    }
    let scheduleChanged = false;
    if (hasEvery) {
      job.schedule = { kind: "interval", seconds: options.everySeconds as number };
      scheduleChanged = true;
    } else if (hasCron) {
      const schedule: Schedule = { kind: "cron", expr: options.cronExpr as string };
      validateSchedule(schedule);
      job.schedule = schedule;
      scheduleChanged = true;
    }
    if (options.enabled !== undefined) job.enabled = options.enabled;
    if (options.timeoutMs !== undefined) job.timeoutMs = options.timeoutMs;
    if (options.maxRetries !== undefined) job.maxRetries = options.maxRetries;
    if (options.backoffMs !== undefined) job.backoffMs = options.backoffMs;
    if (scheduleChanged) job.nextRunAt = this.requireNext(job.schedule, this.clock());
    return job;
  }

  due(now: number): Job[] {
    return this.list().filter((j) => j.enabled && j.nextRunAt <= now);
  }

  private buildHandler(job: Job): HandlerFn {
    const spec = job.handler;
    if (spec.kind === "noop") {
      return async () => "ok";
    }
    if (spec.kind === "http") {
      return createHttpHandler(spec);
    }
    const fn = this.handlers.get(spec.handler);
    if (!fn) {
      return async () => {
        throw new Error(`no handler registered named "${spec.handler}"`);
      };
    }
    return fn;
  }

  private openRun(jobId: string): RunRecord | undefined {
    for (let i = this.runLog.length - 1; i >= 0; i--) {
      const run = this.runLog[i]!;
      if (run.jobId === jobId && run.outcome === "retrying") return run;
      if (run.jobId === jobId && run.outcome !== "retrying" && run.outcome !== "running") return undefined;
    }
    return undefined;
  }

  private backoffDelay(job: Job, attempts: number): number {
    return Math.min(job.backoffMs * 2 ** (attempts - 1), BACKOFF_CAP_MS);
  }

  private async settleAttempt(
    job: Job,
    run: RunRecord,
    attemptNo: number,
    opts: { allowRetry: boolean; affectsSchedule: boolean },
  ): Promise<void> {
    const now = this.clock();
    const startedAt = now;
    const handler = this.buildHandler(job);
    const ac = new AbortController();
    try {
      const result = await runWithTimeout(
        handler({ job, run, attempt: attemptNo, signal: ac.signal }),
        job.timeoutMs,
        () => ac.abort(),
      );
      run.attempts.push({
        attempt: attemptNo,
        startedAt,
        finishedAt: this.clock(),
        outcome: "succeeded",
      });
      run.outcome = "succeeded";
      run.finishedAt = this.clock();
      run.result = truncate(typeof result === "string" ? result : JSON.stringify(result ?? null), RESULT_TRUNCATE);
      job.lastStatus = "succeeded";
      job.consecutiveFailures = 0;
      job.lastRunAt = startedAt;
      if (opts.affectsSchedule) {
        const next = nextRunAfter(job.schedule, this.clock());
        job.nextRunAt = next ?? NO_NEXT_RUN;
      }
    } catch (err) {
      const message = errorText(err);
      run.attempts.push({
        attempt: attemptNo,
        startedAt,
        finishedAt: this.clock(),
        outcome: "failed",
        error: message,
      });
      if (opts.allowRetry && attemptNo <= job.maxRetries) {
        run.outcome = "retrying";
        job.lastStatus = "retrying";
        if (opts.affectsSchedule) {
          job.nextRunAt = this.clock() + this.backoffDelay(job, attemptNo);
        }
      } else {
        run.outcome = "failed";
        run.finishedAt = this.clock();
        run.result = message;
        job.lastStatus = "failed";
        job.consecutiveFailures += 1;
        job.lastRunAt = startedAt;
        if (opts.affectsSchedule) {
          const next = nextRunAfter(job.schedule, this.clock());
          job.nextRunAt = next ?? NO_NEXT_RUN;
        }
      }
    }
  }

  async tick(): Promise<TickResult> {
    const now = this.clock();
    const result: TickResult = { started: 0, succeeded: 0, failed: 0, retrying: 0, runs: [] };
    for (const job of this.due(now)) {
      const open = this.openRun(job.id);
      const run: RunRecord =
        open ?? {
          id: `r-${String(++this.runSeq).padStart(6, "0")}`,
          jobId: job.id,
          trigger: "scheduled",
          startedAt: now,
          attempts: [],
          outcome: "running",
        };
      if (!open) this.addRun(run);
      result.started += 1;
      const attemptNo = run.attempts.length + 1;
      await this.settleAttempt(job, run, attemptNo, { allowRetry: true, affectsSchedule: true });
      if (run.outcome === "succeeded") result.succeeded += 1;
      else if (run.outcome === "failed") result.failed += 1;
      else if (run.outcome === "retrying") result.retrying += 1;
      result.runs.push(run);
    }
    this.pruneHistory();
    return result;
  }

  async runOnce(idOrName: string): Promise<RunRecord> {
    const job = this.resolve(idOrName);
    if (!job.enabled) {
      throw new SchedulerError("CONFLICT", `job "${job.name}" is disabled`);
    }
    const now = this.clock();
    const run: RunRecord = {
      id: `r-${String(++this.runSeq).padStart(6, "0")}`,
      jobId: job.id,
      trigger: "manual",
      startedAt: now,
      attempts: [],
      outcome: "running",
    };
    this.addRun(run);
    await this.settleAttempt(job, run, 1, { allowRetry: false, affectsSchedule: false });
    this.pruneHistory();
    return run;
  }

  private addRun(run: RunRecord): void {
    this.runLog.push(run);
    if (this.runLog.length > this.historyLimit * 2) {
      this.runLog = this.runLog.slice(-this.historyLimit);
    }
  }

  private pruneHistory(): void {
    if (this.runLog.length > this.historyLimit) {
      this.runLog = this.runLog.slice(-this.historyLimit);
    }
  }

  runs(filter: RunsFilter = {}): RunRecord[] {
    let all = [...this.runLog].reverse();
    if (filter.jobId !== undefined) all = all.filter((r) => r.jobId === filter.jobId);
    if (filter.outcome !== undefined) all = all.filter((r) => r.outcome === filter.outcome);
    if (filter.limit !== undefined) all = all.slice(0, Math.max(0, filter.limit));
    return all;
  }

  stats(): JobStats {
    const jobs = this.list();
    const succeeded = this.runLog.filter((r) => r.outcome === "succeeded").length;
    const failed = this.runLog.filter((r) => r.outcome === "failed").length;
    const settled = succeeded + failed;
    const enabledJobs = jobs.filter((j) => j.enabled);
    const nextDueAt = enabledJobs.length > 0 ? Math.min(...enabledJobs.map((j) => j.nextRunAt)) : undefined;
    return {
      jobs: jobs.length,
      enabledJobs: enabledJobs.length,
      disabledJobs: jobs.length - enabledJobs.length,
      runs: this.runLog.length,
      succeeded,
      failed,
      successRate: settled === 0 ? 1 : succeeded / settled,
      ...(nextDueAt === undefined ? {} : { nextDueAt }),
    };
  }

  exportState(): SchedulerState {
    return {
      version: 1,
      jobs: this.list().map((j) => ({ ...j, schedule: { ...j.schedule }, handler: { ...j.handler } })),
      runs: this.runLog.map((r) => ({ ...r, attempts: r.attempts.map((a) => ({ ...a })) })),
      seq: this.seq,
      runSeq: this.runSeq,
    };
  }

  static fromState(state: SchedulerState, options: SchedulerOptions = {}): Scheduler {
    const scheduler = new Scheduler(options);
    for (const job of state.jobs) {
      scheduler.jobs.set(job.id, { ...job, schedule: { ...job.schedule }, handler: { ...job.handler } });
    }
    scheduler.runLog = state.runs.map((r) => ({ ...r, attempts: r.attempts.map((a) => ({ ...a })) }));
    scheduler.seq = state.seq;
    scheduler.runSeq = state.runSeq;
    const now = scheduler.clock();
    for (const run of scheduler.runLog) {
      if (run.outcome === "running") {
        run.outcome = "failed";
        run.result = "interrupted by restart";
      }
    }
    for (const job of scheduler.jobs.values()) {
      if (job.enabled && job.nextRunAt < now) {
        const next = nextRunAfter(job.schedule, now);
        job.nextRunAt = next ?? NO_NEXT_RUN;
      }
    }
    return scheduler;
  }

  async persist(path: string): Promise<void> {
    await saveState(path, this.exportState());
  }

  static restore(path: string, options: SchedulerOptions = {}): Scheduler {
    let state;
    try {
      state = loadState(path);
    } catch (err) {
      if (err instanceof SchedulerError && err.code === "NOT_FOUND") return new Scheduler(options);
      throw err;
    }
    return Scheduler.fromState(state, options);
  }
}

export { saveState, loadState, parseState };
