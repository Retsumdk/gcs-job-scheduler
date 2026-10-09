import type { Job, RunRecord, Schedule, SchedulerState } from "./types.js";
import { SchedulerError } from "./errors.js";
import { validateSchedule } from "./schedule.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const STATE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function reviveJob(raw: unknown): Job {
  if (!isRecord(raw)) throw new SchedulerError("CORRUPTION", "state job entry is not an object");
  const j = raw as unknown as Job;
  if (typeof j.id !== "string" || j.id.length === 0) {
    throw new SchedulerError("CORRUPTION", "state job entry missing id");
  }
  if (typeof j.name !== "string") {
    throw new SchedulerError("CORRUPTION", `job ${j.id} has invalid name`);
  }
  if (!isRecord(j.schedule)) {
    throw new SchedulerError("CORRUPTION", `job ${j.id} missing schedule`);
  }
  validateSchedule(j.schedule as Schedule);
  if (!isRecord(j.handler)) {
    throw new SchedulerError("CORRUPTION", `job ${j.id} missing handler`);
  }
  const kind = (j.handler as { kind?: unknown }).kind;
  if (kind !== "named" && kind !== "noop" && kind !== "http") {
    throw new SchedulerError("CORRUPTION", `job ${j.id} has unknown handler kind`);
  }
  if (typeof j.enabled !== "boolean") {
    throw new SchedulerError("CORRUPTION", `job ${j.id} has invalid enabled flag`);
  }
  if (!isFiniteNumber(j.createdAt) || !isFiniteNumber(j.nextRunAt)) {
    throw new SchedulerError("CORRUPTION", `job ${j.id} has invalid createdAt or nextRunAt`);
  }
  return j;
}

function reviveRun(raw: unknown): RunRecord {
  if (!isRecord(raw)) throw new SchedulerError("CORRUPTION", "state run entry is not an object");
  const r = raw as unknown as RunRecord;
  if (typeof r.id !== "string" || typeof r.jobId !== "string") {
    throw new SchedulerError("CORRUPTION", "state run entry missing id or jobId");
  }
  if (r.trigger !== "scheduled" && r.trigger !== "manual") {
    throw new SchedulerError("CORRUPTION", `run ${r.id} has invalid trigger`);
  }
  if (!Array.isArray(r.attempts) || !isFiniteNumber(r.startedAt)) {
    throw new SchedulerError("CORRUPTION", `run ${r.id} has invalid fields`);
  }
  if (
    r.outcome !== "running" &&
    r.outcome !== "succeeded" &&
    r.outcome !== "failed" &&
    r.outcome !== "retrying"
  ) {
    throw new SchedulerError("CORRUPTION", `run ${r.id} has invalid outcome`);
  }
  return r;
}

export function parseState(value: unknown): SchedulerState {
  if (!isRecord(value)) {
    throw new SchedulerError("CORRUPTION", "state file is not an object");
  }
  if (value.version !== STATE_VERSION) {
    throw new SchedulerError("CORRUPTION", `state file version ${String(value.version)} unsupported (expected ${STATE_VERSION})`);
  }
  if (!Array.isArray(value.jobs)) {
    throw new SchedulerError("CORRUPTION", "state file missing jobs array");
  }
  const jobs = (value.jobs as unknown[]).map(reviveJob);
  if (!Array.isArray(value.runs)) {
    throw new SchedulerError("CORRUPTION", "state file missing runs array");
  }
  const runs = (value.runs as unknown[]).map(reviveRun);
  if (value.seq !== undefined && (!Number.isInteger(value.seq) || (value.seq as number) < 0)) {
    throw new SchedulerError("CORRUPTION", "state file has invalid sequence counter");
  }
  if (value.runSeq !== undefined && (!Number.isInteger(value.runSeq) || (value.runSeq as number) < 0)) {
    throw new SchedulerError("CORRUPTION", "state file has invalid runSeq sequence counter");
  }
  return {
    version: STATE_VERSION,
    jobs,
    runs,
    seq: value.seq === undefined ? 0 : (value.seq as number),
    runSeq: value.runSeq === undefined ? 0 : (value.runSeq as number),
  };
}

export async function saveState(path: string, state: SchedulerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, path);
}

export function loadState(path: string): SchedulerState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new SchedulerError("NOT_FOUND", `Cannot read state file ${path} (${code})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SchedulerError("CORRUPTION", "state file is not valid JSON");
  }
  return parseState(data);
}
