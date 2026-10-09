import { describe, test, expect, afterAll } from "bun:test";
import { saveState, loadState, parseState } from "../src/store.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler } from "../src/scheduler.js";
import { SchedulerError } from "../src/errors.js";

const dir = mkdtempSync(join(tmpdir(), "gcsjob-store-"));
afterAll(() => {
  for (const f of readdirSync(dir)) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      /* best effort cleanup */
    }
  }
  rmdirSync(dir);
});

function stateWithJobs(): ReturnType<Scheduler["exportState"]> {
  const s = new Scheduler();
  s.add({ name: "a", every: 60 });
  s.add({ name: "b", cron: "*/10 * * * *" });
  return s.exportState();
}

describe("saveState / loadState", () => {
  test("round-trips through a temp file with atomic rename", async () => {
    const path = join(dir, "state.json");
    const state = stateWithJobs();
    await saveState(path, state);
    // No .tmp litter left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const loaded = loadState(path);
    expect(loaded.jobs).toHaveLength(2);
    expect(loaded.jobs[0]!.name).toBe("a");
    expect(loaded).toEqual(state);
  });

  test("saveState serializes with a trailing newline and stable key order", async () => {
    const path = join(dir, "stable.json");
    await saveState(path, stateWithJobs());
    const raw = readFileSync(path, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.startsWith("{\n  \"version\": 1")).toBe(true);
  });

  test("loadState rejects missing files and garbage payloads", () => {
    expect(() => loadState(join(dir, "nope.json"))).toThrow(/Cannot read/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "not json at all");
    expect(() => loadState(bad)).toThrow(/not valid JSON/);
  });
});

describe("parseState", () => {
  test("rejects wrong version, missing arrays, and malformed jobs", () => {
    expect(() => parseState({})).toThrow(/version/);
    expect(() => parseState({ version: 2 })).toThrow(/version/);
    expect(() => parseState({ version: 1 })).toThrow(/jobs/);
    expect(() => parseState({ version: 1, jobs: "no" })).toThrow(/jobs/);
    expect(() => parseState({ version: 1, jobs: [{ nope: true }] })).toThrow(/job/);
  });

  test("validates individual job fields", () => {
    const base = {
      id: "j-1",
      name: "a",
      enabled: true,
      createdAt: 1,
      nextRunAt: 2,
      consecutiveFailures: 0,
      lastStatus: "idle",
      schedule: { kind: "interval", seconds: 60 },
      handler: { kind: "noop" },
    };
    expect(() => parseState({ version: 1, jobs: [base], runs: [], seq: 0, runSeq: 0 })).not.toThrow();
    expect(() => parseState({ version: 1, jobs: [{ ...base, name: 5 }], runs: [], seq: 0, runSeq: 0 })).toThrow(/name/);
    expect(() => parseState({ version: 1, jobs: [{ ...base, enabled: "yes" }], runs: [], seq: 0, runSeq: 0 })).toThrow(/enabled/);
    expect(() => parseState({ version: 1, jobs: [{ ...base, nextRunAt: "soon" }], runs: [], seq: 0, runSeq: 0 })).toThrow(/nextRunAt/);
    expect(() => parseState({ version: 1, jobs: [{ ...base, schedule: { kind: "bogus" } }], runs: [], seq: 0, runSeq: 0 })).toThrow(/schedule/);
    expect(() => parseState({ version: 1, jobs: [{ ...base, handler: { kind: "bogus" } }], runs: [], seq: 0, runSeq: 0 })).toThrow(/handler/);
  });

  test("run history entries are validated", () => {
    const job = {
      id: "j-1",
      name: "a",
      enabled: true,
      createdAt: 1,
      nextRunAt: 2,
      consecutiveFailures: 0,
      lastStatus: "idle",
      schedule: { kind: "interval", seconds: 60 },
      handler: { kind: "noop" },
    };
    expect(() => parseState({ version: 1, jobs: [job], runs: "no", seq: 0, runSeq: 0 })).toThrow(/runs/);
    expect(() => parseState({ version: 1, jobs: [job], runs: [{ bogus: 1 }], seq: 0, runSeq: 0 })).toThrow(/run/);
    const run = {
      id: "r-1",
      jobId: "j-1",
      trigger: "scheduled",
      startedAt: 1,
      attempts: [{ attempt: 1, startedAt: 1, finishedAt: 2, outcome: "failed", error: "boom" }],
      outcome: "retrying",
    };
    expect(() => parseState({ version: 1, jobs: [job], runs: [run], seq: 0, runSeq: 0 })).not.toThrow();
    expect(() => parseState({ version: 1, jobs: [job], runs: [{ ...run, outcome: "exploded" }], seq: 0, runSeq: 0 })).toThrow(/outcome/);
    expect(() => parseState({ version: 1, jobs: [job], runs: [{ ...run, trigger: "cosmic" }], seq: 0, runSeq: 0 })).toThrow(/trigger/);
  });

  test("sequence counters are validated", () => {
    const job = {
      id: "j-1",
      name: "a",
      enabled: true,
      createdAt: 1,
      nextRunAt: 2,
      consecutiveFailures: 0,
      lastStatus: "idle",
      schedule: { kind: "interval", seconds: 60 },
      handler: { kind: "noop" },
    };
    expect(() => parseState({ version: 1, jobs: [job], runs: [], seq: -1, runSeq: 0 })).toThrow(/seq/);
    expect(() => parseState({ version: 1, jobs: [job], runs: [], seq: 0, runSeq: 1.5 })).toThrow(/seq/);
  });
});
