import { SchedulerError } from "./errors.js";

export const MINUTE_MS = 60_000;


interface FieldSet {
  values: Set<number>;
  min: number;
  max: number;
  label: string;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  label: string,
  dow = false,
): FieldSet {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (part.length === 0) {
      throw new SchedulerError("VALIDATION", `cron ${label} field has an empty list item`);
    }
    const slashIdx = part.indexOf("/");
    const rangePart = slashIdx === -1 ? part : part.slice(0, slashIdx);
    let step = 1;
    if (slashIdx !== -1) {
      const stepPart = part.slice(slashIdx + 1);
      if (!/^\d+$/.test(stepPart)) {
        throw new SchedulerError("VALIDATION", `cron ${label} step must be a number`);
      }
      step = Number(stepPart);
      if (step < 1) {
        throw new SchedulerError("VALIDATION", `cron ${label} step must be >= 1`);
      }
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(rangePart)) {
      lo = Number(rangePart);
      hi = slashIdx !== -1 ? max : lo;
    } else if (/^\d+-\d+$/.test(rangePart)) {
      const [a, b] = rangePart.split("-").map(Number) as [number, number];
      lo = a;
      hi = b;
    } else {
      throw new SchedulerError(
        "VALIDATION",
        `cron ${label} field "${part}" is not a valid value, range, or stepped range`,
      );
    }
    if (lo < min || hi > max || lo > hi) {
      throw new SchedulerError(
        "VALIDATION",
        `cron ${label} value ${rangePart} out of range [${min}-${max}]`,
      );
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(dow && v === 7 ? 0 : v);
    }
  }
  if (values.size === 0) {
    throw new SchedulerError("VALIDATION", `cron ${label} field matched no values`);
  }
  return { values, min, max, label };
}

export interface CronExpr {
  minutes: FieldSet;
  hours: FieldSet;
  doms: FieldSet;
  months: FieldSet;
  dows: FieldSet;
  domRestricted: boolean;
  dowRestricted: boolean;
  expr: string;
}

export function parseCron(expr: string): CronExpr {
  if (typeof expr !== "string") {
    throw new SchedulerError("VALIDATION", "cron expression must be a string");
  }
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new SchedulerError(
      "VALIDATION",
      `cron expression must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const parsed: CronExpr = {
    minutes: parseField(fields[0]!, 0, 59, "minute"),
    hours: parseField(fields[1]!, 0, 23, "hour"),
    doms: parseField(fields[2]!, 1, 31, "day-of-month"),
    months: parseField(fields[3]!, 1, 12, "month"),
    dows: parseField(fields[4]!, 0, 7, "day-of-week", true),
    domRestricted: fields[2] !== "*",
    dowRestricted: fields[4] !== "*",
    expr: trimmed,
  };
  return parsed;
}

export function cronMatches(expr: CronExpr | string, atMs: number): boolean {
  const e = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(atMs);
  if (!e.minutes.values.has(d.getUTCMinutes())) return false;
  if (!e.hours.values.has(d.getUTCHours())) return false;
  if (!e.months.values.has(d.getUTCMonth() + 1)) return false;
  const domOk = e.doms.values.has(d.getUTCDate());
  const dowOk = e.dows.values.has(d.getUTCDay());
  if (e.domRestricted && e.dowRestricted) return domOk || dowOk;
  if (e.domRestricted) return domOk;
  if (e.dowRestricted) return dowOk;
  return true;
}

export function cronNext(expr: CronExpr | string, afterMs: number): number | null {
  const e = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(afterMs + MINUTE_MS);
  d.setUTCSeconds(0, 0);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(e, d.getTime())) return d.getTime();
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function sorted(field: FieldSet): number[] {
  return [...field.values].sort((a, b) => a - b);
}

function isContiguousRange(values: number[]): boolean {
  return values.length > 1 && values[values.length - 1]! - values[0]! === values.length - 1;
}

function dayListDesc(days: number[]): string {
  if (days.length === 1) return DAY_NAMES[days[0]!]!;
  if (isContiguousRange(days)) {
    return `${DAY_NAMES[days[0]!]} through ${DAY_NAMES[days[days.length - 1]!]!}`;
  }
  return days.map((d) => DAY_NAMES[d]!).join(", ");
}

function monthListDesc(months: number[]): string {
  if (months.length === 1) return MONTH_NAMES[months[0]! - 1]!;
  if (isContiguousRange(months)) {
    return `${MONTH_NAMES[months[0]! - 1]} through ${MONTH_NAMES[months[months.length - 1]! - 1]}`;
  }
  return months.map((m) => MONTH_NAMES[m - 1]!).join(", ");
}

export function describeCron(expr: CronExpr | string): string {
  const e = typeof expr === "string" ? parseCron(expr) : expr;
  if (e.expr === "* * * * *") return "every minute";
  const m = sorted(e.minutes);
  const h = sorted(e.hours);
  const parts: string[] = [];
  if (e.hours.values.size === 24 && m.length > 1 && m[0] === 0) {
    const step = m[1]! - m[0]!;
    const uniform =
      m.every((v, i) => i === 0 || v - m[i - 1]! === step) &&
      step > 0 &&
      60 % step === 0 &&
      m[m.length - 1]! + step === 60;
    parts.push(uniform ? `every ${step} minutes` : `at minute ${m.join(",")}`);
  } else if (m.length === 1) {
    parts.push(`at ${pad(h[0]!)}:${pad(m[0]!)}`);
  } else {
    parts.push(`at minute ${m.join(",")}`);
    if (e.hours.values.size < 24) parts.push(`hour ${h.join(",")}`);
  }
  const dom = sorted(e.doms);
  const dow = sorted(e.dows);
  if (e.domRestricted && e.dowRestricted) {
    parts.push(`on day-of-month ${dom.join(",")} or ${dayListDesc(dow)}`);
  } else if (e.domRestricted) {
    parts.push(`on day-of-month ${dom.join(",")}`);
  } else if (e.dowRestricted) {
    parts.push(dow.length === 1 ? `on ${dayListDesc(dow)}` : dayListDesc(dow));
  }
  if (e.months.values.size < 12) {
    parts.push(`in ${monthListDesc(sorted(e.months))}`);
  }
  return parts.join(", ");
}
