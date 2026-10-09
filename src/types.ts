export type Schedule = { kind: "interval"; seconds: number } | { kind: "cron"; expr: string };

export type HandlerSpec =
  | { kind: "named"; handler: string }
  | { kind: "noop" }
  | { kind: "http"; url: string; method?: string; headers?: Record<string, string>; body?: string };

export type JobStatus = "idle" | "retrying" | "succeeded" | "failed";

export interface Job {
  id: string;
  name: string;
  schedule: Schedule;
  handler: HandlerSpec;
  enabled: boolean;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus: JobStatus;
  consecutiveFailures: number;
}

export type RunTrigger = "scheduled" | "manual";

export type AttemptOutcome = "succeeded" | "failed";

export interface AttemptRecord {
  attempt: number;
  startedAt: number;
  finishedAt: number;
  outcome: AttemptOutcome;
  error?: string;
}

export type RunOutcome = "running" | "succeeded" | "failed" | "retrying";

export interface RunRecord {
  id: string;
  jobId: string;
  trigger: RunTrigger;
  startedAt: number;
  finishedAt?: number;
  attempts: AttemptRecord[];
  outcome: RunOutcome;
  result?: string;
}

export interface SchedulerState {
  version: 1;
  jobs: Job[];
  runs: RunRecord[];
  seq: number;
  runSeq: number;
}

export interface TickResult {
  started: number;
  succeeded: number;
  failed: number;
  retrying: number;
  runs: RunRecord[];
}

export interface JobStats {
  jobs: number;
  enabledJobs: number;
  disabledJobs: number;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number;
  nextDueAt?: number;
}

export type HandlerFn = (input: {
  job: Job;
  run: RunRecord;
  attempt: number;
  signal: AbortSignal;
}) => Promise<unknown>;

export interface SchedulerOptions {
  clock?: () => number;
  handlers?: Record<string, HandlerFn>;
  historyLimit?: number;
}

export interface AddJobOptions {
  name: string;
  every?: number;
  cron?: string;
  handler?: HandlerSpec;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface PatchOptions {
  everySeconds?: number;
  cronExpr?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  backoffMs?: number;
}

export interface RunsFilter {
  jobId?: string;
  outcome?: RunOutcome;
  limit?: number;
}
