import type { Schedule } from "./types.js";
import { SchedulerError } from "./errors.js";
import { cronNext, parseCron, describeCron, MINUTE_MS } from "./cron.js";

export const MAX_INTERVAL_SECONDS = 30 * 24 * 3_600;

export function validateSchedule(schedule: Schedule): void {
  if (schedule === null || typeof schedule !== "object") {
    throw new SchedulerError("VALIDATION", "schedule must be an object");
  }
  if (schedule.kind === "interval") {
    const s = schedule as { seconds: unknown };
    if (!Number.isInteger(s.seconds) || (s.seconds as number) < 1) {
      throw new SchedulerError("VALIDATION", "interval schedule seconds must be an integer >= 1");
    }
    if ((s.seconds as number) > MAX_INTERVAL_SECONDS) {
      throw new SchedulerError("VALIDATION", `interval schedule seconds must be <= ${MAX_INTERVAL_SECONDS} (30 days)`);
    }
    return;
  }
  if (schedule.kind === "cron") {
    const s = schedule as { expr: unknown };
    if (typeof s.expr !== "string") {
      throw new SchedulerError("VALIDATION", "cron schedule requires a string expr");
    }
    parseCron(s.expr);
    return;
  }
  throw new SchedulerError("VALIDATION", 'schedule.kind must be "interval" or "cron"');
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") return `every ${schedule.seconds}s`;
  return `cron(${schedule.expr})`;
}

export function nextRunAfter(schedule: Schedule, afterMs: number): number | null {
  if (schedule.kind === "interval") return afterMs + schedule.seconds * 1000;
  return cronNext(schedule.expr, afterMs);
}

export { MINUTE_MS, cronNext, parseCron, describeCron };


export function alignIntervalStart(schedule: Schedule, fromMs: number): number {
  if (schedule.kind === "cron") return fromMs;
  const period = schedule.seconds * 1000;
  return Math.ceil(fromMs / period) * period;
}
