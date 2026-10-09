import { describe, test, expect } from "bun:test";
import { validateSchedule, describeSchedule, nextRunAfter, MAX_INTERVAL_SECONDS } from "../src/schedule.js";
import { SchedulerError } from "../src/errors.js";

const BASE = Date.parse("2026-03-15T09:00:00.000Z");

describe("interval schedules", () => {
  test("validate and describe", () => {
    expect(() => validateSchedule({ kind: "interval", seconds: 3600 })).not.toThrow();
    expect(describeSchedule({ kind: "interval", seconds: 3600 })).toBe("every 3600s");
    expect(() => validateSchedule({ kind: "interval", seconds: 0 })).toThrow(SchedulerError);
    expect(() => validateSchedule({ kind: "interval", seconds: 1.5 })).toThrow(SchedulerError);
    expect(() => validateSchedule({ kind: "interval", seconds: MAX_INTERVAL_SECONDS })).not.toThrow();
    expect(() => validateSchedule({ kind: "interval", seconds: MAX_INTERVAL_SECONDS + 1 })).toThrow(SchedulerError);
  });

  test("nextRunAfter anchors on the previous run", () => {
    expect(nextRunAfter({ kind: "interval", seconds: 90 }, BASE)).toBe(BASE + 90_000);
    expect(nextRunAfter({ kind: "interval", seconds: 90 }, BASE + 90_000)).toBe(BASE + 180_000);
  });
});

describe("cron schedules", () => {
  test("validate and describe", () => {
    expect(() => validateSchedule({ kind: "cron", expr: "*/10 * * * *" })).not.toThrow();
    expect(describeSchedule({ kind: "cron", expr: "*/10 * * * *" })).toBe("cron(*/10 * * * *)");
    expect(() => validateSchedule({ kind: "cron", expr: "not a cron" })).toThrow(SchedulerError);
  });

  test("nextRunAfter delegates to the cron engine", () => {
    expect(nextRunAfter({ kind: "cron", expr: "*/10 * * * *" }, BASE)).toBe(BASE + 10 * 60_000);
  });

  test("nextRunAfter returns null for unreachable cron expressions", () => {
    expect(nextRunAfter({ kind: "cron", expr: "0 0 30 2 *" }, BASE)).toBeNull();
  });
});

describe("invalid schedule shapes", () => {
  test("rejects unknown kinds and malformed payloads", () => {
    expect(() => validateSchedule({ kind: "weekly" } as never)).toThrow(/schedule/);
    expect(() => validateSchedule(null as never)).toThrow(SchedulerError);
    expect(() => validateSchedule({ kind: "cron" } as never)).toThrow(SchedulerError);
    expect(() => validateSchedule({ kind: "interval" } as never)).toThrow(SchedulerError);
  });
});
