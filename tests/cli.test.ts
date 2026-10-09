import { describe, test, expect } from "bun:test";
import { runCli, isKnownCommand, UsageError } from "../src/cli.js";
import { Scheduler } from "../src/scheduler.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gcsjob-cli-"));
const statePath = join(dir, "cli-state.json");

const BASE = Date.parse("2026-03-15T09:00:00.000Z");

function argv(rest: string[]): string[] {
  return [...rest];
}

function newScheduler(): Scheduler {
  return new Scheduler({ clock: () => BASE });
}

async function capture(argv_: string[], scheduler?: Scheduler, statePathOverride?: string): Promise<string> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(" "));
  };
  try {
    const rest = statePathOverride ? [...argv_, "--state", statePathOverride] : argv_;
    await runCli(rest, scheduler);
  } finally {
    console.log = original;
  }
  return logs.join("\n");
}

describe("CLI commands", () => {
  test("create with interval and flags", async () => {
    const out = await capture(
      argv(["create", "--name", "cleanup", "--every", "60", "--max-retries", "3", "--backoff-ms", "15000"]),
      newScheduler(),
      statePath,
    );
    expect(out).toContain("j-000001");
    expect(out).toContain("cleanup");
    expect(out).toContain("every 60s");
    expect(out).toContain("retries 3");
  });

  test("create with cron and url handler", async () => {
    const out = await capture(
      argv(["create", "--name", "inventory", "--cron", "0 2 * * *", "--url", "https://storage.googleapis.com/storage/v1/b/my-bucket/o"]),
      newScheduler(),
    );
    expect(out).toContain("cron(0 2 * * *)");
    expect(out).toContain("http");
  });

  test("create requires exactly one of --every or --cron", async () => {
    await expect(runCli(argv(["create", "--name", "x"]), newScheduler())).rejects.toThrow(/exactly one/);
    await expect(
      runCli(argv(["create", "--name", "x", "--every", "60", "--cron", "* * * * *"]), newScheduler()),
    ).rejects.toThrow(/exactly one/);
  });

  test("create requires --name", async () => {
    await expect(runCli(argv(["create", "--every", "60"]), newScheduler())).rejects.toThrow(/name/);
  });

  test("list shows jobs with disabled markers", async () => {
    const s = newScheduler();
    s.add({ name: "on", every: 60 });
    s.add({ name: "off", every: 60, enabled: false });
    const out = await capture(argv(["list"]), s);
    expect(out).toContain("on");
    expect(out).toContain("off");
    expect(out).toContain("[disabled]");
    expect(out).toContain("[disabled]");
  });

  test("get shows detail; missing job errors", async () => {
    const s = newScheduler();
    s.add({ name: "a", every: 60 });
    const out = await capture(argv(["get", "j-000001"]), s);
    expect(out).toContain("a");
    await expect(runCli(argv(["get", "j-9999"]), s)).rejects.toThrow(/no job matches/i);
  });

  test("rm, enable, disable round-trip", async () => {
    const s = newScheduler();
    s.add({ name: "a", every: 60 });
    expect(await capture(argv(["disable", "j-000001"]), s)).toContain("disabled");
    expect(s.get("j-000001")?.enabled).toBe(false);
    expect(await capture(argv(["enable", "j-000001"]), s)).toContain("enabled");
    expect(s.get("j-000001")?.enabled).toBe(true);
    expect(await capture(argv(["rm", "j-000001"]), s)).toContain("removed");
    expect(s.get("j-000001")).toBeUndefined();
    await expect(runCli(argv(["rm", "j-000001"]), s)).rejects.toThrow(/no job matches/i);
  });

  test("run executes immediately; tick reports due work", async () => {
    const s = newScheduler();
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    const out = await capture(argv(["run", "j-000001"]), s);
    expect(out).toContain("succeeded");
    expect(out).toContain("manual");
    expect(await capture(argv(["tick"]), s)).toContain("started 0");
  });

  test("stats output", async () => {
    const s = newScheduler();
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    const out = await capture(argv(["stats"]), s);
    expect(out).toContain("jobs: 1 (1 enabled");
    expect(out).toContain("success rate: 100.0%");
  });

  test("runs output", async () => {
    const s = newScheduler();
    s.setHandler("hb", async () => "ok");
    s.add({ name: "a", every: 60, handler: { kind: "named", handler: "hb" } });
    await s.runOnce("j-000001");
    const out = await capture(argv(["runs", "--limit", "5"]), s);
    expect(out).toContain("succeeded");
  });

  test("unknown command and empty list", async () => {
    expect(isKnownCommand("list")).toBe(true);
    expect(isKnownCommand("bogus")).toBe(false);
    await expect(runCli(argv(["bogus"]), newScheduler())).rejects.toThrow(UsageError);
    expect(await capture(argv(["list"]), newScheduler())).toContain("no jobs");
  });

  test("state flag persists across invocations", async () => {
    await capture(argv(["create", "--name", "persisted", "--every", "60"]), undefined, statePath);
    const out = await capture(argv(["list"]), undefined, statePath);
    expect(out).toContain("persisted");
  });
});
