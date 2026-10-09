import { describe, test, expect } from "bun:test";
import { parseCron, cronMatches, cronNext, describeCron } from "../src/cron.js";
import { SchedulerError } from "../src/errors.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (iso: string): number => Date.parse(iso);

describe("cron parsing", () => {
  test("accepts common expressions and normalizes dom/dow", () => {
    expect(describeCron(parseCron("* * * * *"))).toBe("every minute");
    expect(describeCron(parseCron("*/15 * * * *"))).toBe("every 15 minutes");
    expect(describeCron(parseCron("0 9-17 * * 1-5"))).toBe("at 09:00, Monday through Friday");
    expect(describeCron(parseCron("30 2 1 * *"))).toBe("at 02:30, on day-of-month 1");
    expect(describeCron(parseCron("0 0 * * 0"))).toBe("at 00:00, on Sunday");
    expect(describeCron(parseCron("0 0 * * 7"))).toBe("at 00:00, on Sunday");
  });

  test("rejects malformed expressions with field-accurate errors", () => {
    expect(() => parseCron("*/15 * * *")).toThrow(SchedulerError);
    expect(() => parseCron("*/15 * * * * *")).toThrow(SchedulerError);
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("* 24 * * *")).toThrow(/hour/);
    expect(() => parseCron("* * 0 * *")).toThrow(/day-of-month/);
    expect(() => parseCron("* * * 13 *")).toThrow(/month/);
    expect(() => parseCron("* * * * 8")).toThrow(/day-of-week/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
    expect(() => parseCron("a * * * *")).toThrow(/minute/);
    expect(() => parseCron("")).toThrow(SchedulerError);
  });
});

describe("cron matching", () => {
  test("steps, ranges, and lists", () => {
    const every5 = parseCron("*/5 * * * *");
    expect(cronMatches(every5, at("2026-03-15T09:05:00Z"))).toBe(true);
    expect(cronMatches(every5, at("2026-03-15T09:07:00Z"))).toBe(false);

    const business = parseCron("0 9-17 * * 1-5");
    expect(cronMatches(business, at("2026-03-16T09:00:00Z"))).toBe(true); // Monday
    expect(cronMatches(business, at("2026-03-16T18:00:00Z"))).toBe(false);
    expect(cronMatches(business, at("2026-03-14T09:00:00Z"))).toBe(false); // Saturday

    const list = parseCron("0 0 1,15 * *");
    expect(cronMatches(list, at("2026-03-01T00:00:00Z"))).toBe(true);
    expect(cronMatches(list, at("2026-03-02T00:00:00Z"))).toBe(false);
  });

  test("day-of-month/day-of-week use standard OR semantics", () => {
    // 2026-03-15 is a Sunday and day 15.
    const both = parseCron("0 0 15 * 0");
    expect(cronMatches(both, at("2026-03-15T00:00:00Z"))).toBe(true);
    // 2026-03-22 is a Sunday but not day 15 -> dow matches.
    expect(cronMatches(both, at("2026-03-22T00:00:00Z"))).toBe(true);
    // 2026-04-15 is day 15 but a Wednesday -> dom matches.
    expect(cronMatches(both, at("2026-04-15T00:00:00Z"))).toBe(true);
    // 2026-03-17 is day 17, a Tuesday -> neither matches.
    expect(cronMatches(both, at("2026-03-17T00:00:00Z"))).toBe(false);
  });
});

describe("cronNext", () => {
  test("advances to the next matching minute", () => {
    const every15 = parseCron("*/15 * * * *");
    expect(cronNext(every15, at("2026-03-15T09:00:00Z"))).toBe(at("2026-03-15T09:15:00Z"));
    expect(cronNext(every15, at("2026-03-15T09:15:00Z"))).toBe(at("2026-03-15T09:30:00Z"));
    expect(cronNext(every15, at("2026-03-15T09:16:00Z"))).toBe(at("2026-03-15T09:30:00Z"));
  });

  test("rolls across hours, days, and years", () => {
    const daily = parseCron("30 2 * * *");
    expect(cronNext(daily, at("2026-03-15T09:00:00Z"))).toBe(at("2026-03-16T02:30:00Z"));
    expect(cronNext(daily, at("2026-03-16T02:30:00Z"))).toBe(at("2026-03-17T02:30:00Z"));

    const yearly = parseCron("0 0 1 1 *");
    expect(cronNext(yearly, at("2026-03-15T00:00:00Z"))).toBe(at("2027-01-01T00:00:00Z"));
  });

  test("weekly schedule with dow restriction", () => {
    const weekly = parseCron("0 6 * * 1");
    expect(cronNext(weekly, at("2026-03-15T06:00:00Z"))).toBe(at("2026-03-16T06:00:00Z")); // Sun -> Mon
    expect(cronNext(weekly, at("2026-03-16T06:00:00Z"))).toBe(at("2026-03-23T06:00:00Z"));
  });

  test("returns null for schedules that can never fire", () => {
    // Feb 30 never exists.
    const impossible = parseCron("0 0 30 2 *");
    expect(cronNext(impossible, at("2026-03-15T00:00:00Z"))).toBeNull();
  });

  test("ignores seconds in the anchor time", () => {
    const everyHour = parseCron("0 * * * *");
    expect(cronNext(everyHour, at("2026-03-15T09:00:30Z"))).toBe(at("2026-03-15T10:00:00Z"));
  });
});

describe("round-trip stability", () => {
  test("matches(cronNext(x)) is always true for reachable slots", () => {
    const expr = parseCron("*/7 3,9 * * *");
    let t = at("2026-03-15T00:00:00Z");
    for (let i = 0; i < 30; i++) {
      const next = cronNext(expr, t);
      expect(next).not.toBeNull();
      expect(cronMatches(expr, next as number)).toBe(true);
      t = next as number;
    }
  });

  test("daily arithmetic stays UTC-stable across a DST-heavy year", () => {
    const daily = parseCron("0 12 * * *");
    let t = at("2026-01-01T12:00:00Z");
    for (let i = 0; i < 365; i++) {
      const next = cronNext(daily, t) as number;
      expect(next - t).toBe(DAY);
      t = next;
    }
  });

  test("hourly arithmetic stays exact", () => {
    const hourly = parseCron("10 * * * *");
    let t = at("2026-01-01T00:10:00Z");
    for (let i = 0; i < 48; i++) {
      const next = cronNext(hourly, t) as number;
      expect(next - t).toBe(HOUR);
      t = next;
    }
  });
});
