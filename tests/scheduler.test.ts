import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Scheduler } from "../src/scheduler.js";
import { saveState, loadState, parseState } from "../src/store.js";
import type { Job, RunRecord, HandlerFn } from "../src/types.js";
import { SchedulerError } from "../src/errors.js";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = Date.parse("2026-03-15T09:00:00.000Z");

class FixedClock {
  private nowMs: number;
  constructor(start: number) {
    this.nowMs = start;
  }
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

function makeScheduler(
  clock: FixedClock,
  handlers: Record<string, HandlerFn> = {},
  options: { historyLimit?: number } = {},
): Scheduler {
  return new Scheduler({ clock: () => clock.now(), handlers, ...options });
}

let clock: FixedClock;
beforeEach(() => {
  clock = new FixedClock(BASE);
});

describe("job CRUD", () => {
  test("add creates a job with a computed first run and stable ids", () => {
    const s = makeScheduler(clock);
    const job = s.add({ name: "cleanup", every: 60 });
    expect(job.id).toBe("j-000001");
    expect(job.enabled).toBe(true);
    expect(job.nextRunAt).toBe(BASE + 60_000);
    const second = s.add({ name: "snapshot", cron: "*/5 * * * *" });
    expect(second.id).toBe("j-000002");
    expect(second.nextRunAt).toBe(BASE + 5 * 60_000);
  });

  test("add rejects duplicate names, bad schedules, and bad options", () => {
    const s = makeScheduler(clock);
    s.add({ name: "a", every: 60 });
    expect(() => s.add({ name: "a", every: 60 })).toThrow(/already exists/);
    expect(() => s.add({ name: "b", every: 0 })).toThrow(SchedulerError);
    expect(() => s.add({ name: "b", cron: "bad cron" })).toThrow(SchedulerError);
    expect(() => s.add({ name: "b", every: 60, maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => s.add({ name: "b", every: 60, backoffMs: -5 })).toThrow(/backoff/);
    expect(() => s.add({ name: "b", every: 60, timeoutMs: 0 })).toThrow(/timeout/);
    expect(() => s.add({ name: "b", every: 60, bogus: 1 } as never)).toThrow(/Unknown/);
  });

  test("add rejects empty names and both schedule kinds at once", () => {
    const s = makeScheduler(clock);
    expect(() => s.add({ name: "  ", every: 60 })).toThrow(/name/);
    expect(() => s.add({ name: "a", every: 60, cron: "* * * * *" })).toThrow(/exactly one schedule/);
  });

  test("add validates the handler shape at creation", () => {
    const s = makeScheduler(clock);
    expect(() => s.add({ name: "x", every: 60, handler: { kind: "bogus" } as never })).toThrow(/handler/);
  });

  test("get returns undefined for unknown jobs; resolve throws", () => {
    const s = makeScheduler(clock);
    s.add({ name: "a", every: 60 });
    expect(s.get("j-000001")?.name).toBe("a");
    expect(s.get("missing")).toBeUndefined();
    expect(() => s.resolve("missing")).toThrow(SchedulerError);
  });

  test("remove never reuses ids", () => {
    const s = makeScheduler(clock);
    s.add({ name: "a", every: 60 });
    s.add({ name: "b", every: 60 });
    s.remove("j-000001");
    expect(s.get("j-000001")).toBeUndefined();
    const c = s.add({ name: "c", every: 60 });
    expect(c.id).toBe("j-000003");
  });

  test("enable / disable flips state and disabled jobs stop being due", async () => {
    const s = makeScheduler(clock);
    const seen: string[] = [];
    s.setHandler("hb", async () => {
      seen.push("ran");
    });
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    clock.advance(60_000);
    expect((await s.tick()).started).toBe(1);
    expect(seen).toEqual(["ran"]);
    s.disable("j-000001");
    expect(s.get("j-000001")?.enabled).toBe(false);
    clock.advance(60_000);
    expect((await s.tick()).started).toBe(0);
    s.enable("j-000001");
    clock.advance(60_000);
    expect((await s.tick()).started).toBe(1);
  });

  test("patch validates and applies schedule and policy changes", () => {
    const s = makeScheduler(clock);
    s.add({ name: "a", every: 60 });
    const patched = s.patch("j-000001", { everySeconds: 120, maxRetries: 1 });
    expect(patched.schedule).toEqual({ kind: "interval", seconds: 120 });
    expect(patched.nextRunAt).toBe(clock.now() + 120_000);
    expect(patched.maxRetries).toBe(1);
    expect(() => s.patch("j-000001", { cronExpr: "garbage" })).toThrow(SchedulerError);
    expect(() => s.patch("missing", { enabled: true })).toThrow(SchedulerError);
  });
});

describe("tick execution", () => {
  test("runs due jobs, advances their schedule, and records runs", async () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    expect((await s.tick()).started).toBe(0);

    clock.advance(60_000);
    const t = await s.tick();
    expect(t.started).toBe(1);
    expect(t.succeeded).toBe(1);

    const job = s.get("j-000001") as Job;
    expect(job.nextRunAt).toBe(BASE + 120_000);
    expect(job.lastStatus).toBe("succeeded");

    const runs = s.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("succeeded");
    expect(runs[0]!.attempts).toHaveLength(1);
    expect(runs[0]!.result).toBe("ok");
    expect(runs[0]!.trigger).toBe("scheduled");
  });

  test("only due jobs start, and a job never runs twice in one tick", async () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 30, handler: { kind: "named", handler: "hb" } });
    s.add({ name: "b", every: 300, handler: { kind: "named", handler: "hb" } });
    clock.advance(30_000);
    const t = await s.tick();
    expect(t.started).toBe(1);
    expect(s.runs()).toHaveLength(1);
  });

  test("transient failures retry on the backoff timeline and recover", async () => {
    let calls = 0;
    const s = makeScheduler(clock, {
      flaky: async () => {
        calls += 1;
        if (calls === 1) throw new Error("transient network blip");
        return "recovered";
      },
    });
    s.add({ name: "a", every: 60, backoffMs: 10_000, handler: { kind: "named", handler: "flaky" } });

    clock.advance(60_000);
    let t = await s.tick();
    expect(t.started).toBe(1);
    expect(t.succeeded).toBe(0);
    expect(t.retrying).toBe(1);
    const job = s.get("j-000001") as Job;
    expect(job.nextRunAt).toBe(BASE + 70_000);
    expect(job.lastStatus).toBe("retrying");

    clock.advance(5_000);
    expect((await s.tick()).started).toBe(0);

    clock.advance(5_000);
    t = await s.tick();
    expect(t.started).toBe(1);
    expect(t.succeeded).toBe(1);

    const runs = s.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("succeeded");
    expect(runs[0]!.attempts).toHaveLength(2);
    expect(runs[0]!.result).toBe("recovered");
    expect(runs[0]!.attempts[0]!.error).toContain("transient network blip");
    expect(job.nextRunAt).toBe(BASE + 130_000);
  });

  test("exhausted retries permanently fail the run and reschedule from the cron clock", async () => {
    const s = makeScheduler(clock, {
      always: async () => {
        throw new Error("storage unavailable");
      },
    });
    s.add({
      name: "a",
      cron: "*/10 * * * *",
      maxRetries: 2,
      backoffMs: 10_000,
      handler: { kind: "named", handler: "always" },
    });
    clock.advance(10 * 60_000);
    expect((await s.tick()).retrying).toBe(1);

    clock.advance(10_000);
    expect((await s.tick()).retrying).toBe(1);

    clock.advance(20_000);
    const t = await s.tick();
    expect(t.started).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.retrying).toBe(0);

    const run = s.runs()[0] as RunRecord;
    expect(run.outcome).toBe("failed");
    expect(run.attempts).toHaveLength(3);
    const job = s.get("j-000001") as Job;
    expect(job.nextRunAt).toBe(Date.parse("2026-03-15T09:20:00.000Z"));
    expect(job.lastStatus).toBe("failed");
  });

  test("a retrying run resumes rather than forking a second run", async () => {
    let calls = 0;
    const s = makeScheduler(clock, {
      flaky: async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
        return "ok";
      },
    });
    s.add({ name: "a", every: 60, backoffMs: 5_000, handler: { kind: "named", handler: "flaky" } });

    clock.advance(60_000);
    await s.tick(); // attempt 1 fails -> retry at +65s
    clock.advance(5_000);
    await s.tick(); // attempt 2 fails -> retry at +75s (backoff doubled)
    clock.advance(10_000);
    await s.tick(); // attempt 3 succeeds

    expect(s.runs()).toHaveLength(1);
    expect(s.runs()[0]!.attempts).toHaveLength(3);
    expect(s.runs()[0]!.outcome).toBe("succeeded");
  });

  test("handler timeout aborts the attempt as a transient failure", async () => {
    const s = makeScheduler(clock);
    s.setHandler("slow", () => new Promise<string>((resolve) => setTimeout(() => resolve("too late"), 500)));
    s.add({ name: "a", every: 60, timeoutMs: 25, handler: { kind: "named", handler: "slow" } });
    clock.advance(60_000);
    const t = await s.tick();
    expect(t.retrying).toBe(1);
    const run = s.runs()[0] as RunRecord;
    expect(run.attempts[0]!.error).toContain("timed out after 25ms");
  });

  test("missing handler is a transient failure, not a crash", async () => {
    const s = makeScheduler(clock);
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "nope" } });
    clock.advance(60_000);
    const t = await s.tick();
    expect(t.retrying).toBe(1);
    expect(s.runs()[0]?.attempts[0]?.error).toContain("nope");
  });

  test("manual runOnce works even when the job is not due", async () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "manual-ok");
    s.add({ name: "a", every: 3600, handler: { kind: "named", handler: "hb" } });
    const run = await s.runOnce("j-000001");
    expect(run.outcome).toBe("succeeded");
    expect(run.result).toBe("manual-ok");
    expect(run.trigger).toBe("manual");
    expect(s.get("j-000001")?.nextRunAt).toBe(BASE + 3_600_000);
  });

  test("runOnce on unknown or disabled job throws", async () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "ok");
    expect(() => s.runOnce("missing")).toThrow(SchedulerError);
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" }, enabled: false });
    await expect(s.runOnce("j-000001")).rejects.toThrow(/disabled/);
  });
});

describe("stats and history", () => {
  test("stats aggregate outcomes and success rate", async () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    s.add({ name: "b", every: 60, enabled: false, handler: { kind: "named", handler: "hb" } });
    clock.advance(60_000);
    await s.tick();
    const stats = s.stats();
    expect(stats.jobs).toBe(2);
    expect(stats.enabledJobs).toBe(1);
    expect(stats.disabledJobs).toBe(1);
    expect(stats.runs).toBe(1);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.successRate).toBe(1);
    expect(stats.nextDueAt).toBe(BASE + 120_000);
  });

  test("run history is capped and queryable", async () => {
    const s = makeScheduler(clock, {}, { historyLimit: 3 });
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 10, handler: { kind: "named", handler: "hb" } });
    for (let i = 0; i < 5; i++) {
      clock.advance(10_000);
      await s.tick();
    }
    expect(s.runs()).toHaveLength(3);
    expect(s.runs({ limit: 1 })).toHaveLength(1);
    expect(s.runs({ jobId: "j-000001" })).toHaveLength(3);
    expect(s.runs({ outcome: "failed" })).toHaveLength(0);
  });

  test("runs can be filtered by outcome and job", async () => {
    const s = makeScheduler(clock, {
      always: async () => {
        throw new Error("x");
      },
    });
    s.setHandler("hb", async () => "ok");
    s.add({ name: "good", every: 10, maxRetries: 0, handler: { kind: "named", handler: "hb" } });
    s.add({ name: "bad", every: 10, maxRetries: 0, handler: { kind: "named", handler: "always" } });
    clock.advance(10_000);
    await s.tick();
    expect(s.runs({ outcome: "succeeded" })).toHaveLength(1);
    expect(s.runs({ outcome: "failed" })).toHaveLength(1);
    expect(s.runs({ jobId: "j-000002" })).toHaveLength(1);
  });
});

describe("persistence round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "gcsjob-sched-"));
  afterAll(() => {
    for (const f of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* best effort */
      }
    }
    try {
      rmdirSync(dir);
    } catch {
      /* best effort */
    }
  });

  test("state survives save/load with runs and counters intact", async () => {
    const s = makeScheduler(clock, {
      flaky: async () => {
        throw new Error("boom");
      },
    });
    s.add({ name: "a", every: 10, maxRetries: 0, backoffMs: 5_000, handler: { kind: "named", handler: "flaky" } });
    s.add({ name: "b", every: 600, enabled: false, handler: { kind: "named", handler: "flaky" } });
    clock.advance(10_000);
    await s.tick();

    const path = join(dir, "state.json");
    await s.persist(path);
    expect(existsSync(path)).toBe(true);

    const revived = Scheduler.restore(path, { clock: () => clock.now() });
    expect(revived.list().map((j) => j.name)).toEqual(["a", "b"]);
    expect(revived.runs()).toHaveLength(1);
    expect(revived.get("j-000001")?.nextRunAt).toBe(s.get("j-000001")?.nextRunAt);
    const c = revived.add({ name: "c", every: 60 });
    expect(c.id).toBe("j-000003");
  });

  test("restore on a missing file yields a fresh scheduler", () => {
    const fresh = Scheduler.restore(join(dir, "nope.json"), { clock: () => clock.now() });
    expect(fresh.list()).toEqual([]);
  });
});

describe("revive semantics", () => {
  test("a job whose schedule lapsed while down resumes on its next slot, not a stampede", () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", cron: "*/5 * * * *", handler: { kind: "named", handler: "hb" } });
    const state = JSON.parse(JSON.stringify(s.exportState()));
    const stored = state.jobs[0] as Job;
    stored.nextRunAt = BASE - 3 * 24 * 3_600_000;

    const revived = Scheduler.fromState(state, { clock: () => clock.now() });
    expect(revived.get("j-000001")?.nextRunAt).toBe(Date.parse("2026-03-15T09:05:00.000Z"));
    clock.advance(5 * 60_000);
    void revived;
  });

  test("runs left in flight by a crash are failed on revive, not stuck", () => {
    const s = makeScheduler(clock);
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    const state = s.exportState();
    state.runs.push({
      id: "run-000001",
      jobId: "j-000001",
      trigger: "scheduled",
      startedAt: BASE - 1000,
      attempts: [],
      outcome: "running",
    });
    const revived = Scheduler.fromState(state, { clock: () => clock.now() });
    expect(revived.runs()[0]?.outcome).toBe("failed");
  });
});
