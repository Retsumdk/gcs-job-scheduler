import { describe, test, expect, afterAll } from "bun:test";
import { Scheduler } from "../src/scheduler.js";
import { startServer } from "../src/server.js";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";

const TOKEN = "test-token-123";
let t = Date.parse("2026-03-15T09:00:00.000Z");
const clock = (): number => t;

let srv: Server | undefined;
let base = "";

afterAll(() => {
  srv?.close();
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function setup(): Scheduler {
  const s = new Scheduler({ clock });
  s.setHandler("hb", async () => "ok");
  s.add({ name: "alpha", every: 60, handler: { kind: "named", handler: "hb" } });
  srv = startServer(s, { token: TOKEN });
  srv.listen(0, "127.0.0.1");
  const addr = srv.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  return s;
}

describe("HTTP API auth", () => {
  test("mutations require a valid bearer token; reads are open", async () => {
    setup();
    const noAuth = await call("POST", "/jobs", { name: "x", schedule: { everySeconds: 60 } }, false);
    expect(noAuth.status).toBe(401);

    const wrong = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ name: "x", schedule: { everySeconds: 60 } }),
    });
    expect(wrong.status).toBe(401);

    const good = await call("POST", "/jobs", { name: "beta", schedule: { everySeconds: 60 } });
    expect(good.status).toBe(201);

    const reads = await Promise.all([
      call("GET", "/healthz", undefined, false),
      call("GET", "/stats", undefined, false),
      call("GET", "/jobs", undefined, false),
      call("GET", "/runs", undefined, false),
    ]);
    for (const r of reads) expect(r.status).toBe(200);
  });
});

describe("HTTP API CRUD and execution", () => {
  test("healthz, jobs lifecycle, run, tick, runs, stats, errors", async () => {
    setup();

    const health = await call("GET", "/healthz", undefined, false);
    expect(health.json).toEqual({ ok: true });

    const badName = await call("POST", "/jobs", { schedule: { everySeconds: 60 } });
    expect(badName.status).toBe(400);
    expect(badName.json.error.code).toBe("VALIDATION");

    const badSchedule = await call("POST", "/jobs", { name: "x", schedule: { cron: "nope" } });
    expect(badSchedule.status).toBe(400);

    const created = await call("POST", "/jobs", {
      name: "nightly",
      schedule: { cron: "0 3 * * *" },
      handler: { kind: "noop" },
    });
    expect(created.status).toBe(201);
    expect(created.json.job.name).toBe("nightly");

    const dup = await call("POST", "/jobs", { name: "nightly", schedule: { everySeconds: 60 } });
    expect(dup.status).toBe(409);

    const list = await call("GET", "/jobs?enabled=true");
    expect(list.json.jobs.some((j: any) => j.name === "nightly")).toBe(true);

    const got = await call("GET", "/jobs/j-000002");
    expect(got.json.job.name).toBe("nightly");
    expect((await call("GET", "/jobs/j-9999")).status).toBe(404);

    const patched = await call("PATCH", "/jobs/j-000002", { enabled: false });
    expect(patched.json.job.enabled).toBe(false);

    const run = await call("POST", "/jobs/j-000001/run");
    expect(run.status).toBe(200);
    expect(run.json.run.outcome).toBe("succeeded");

    t += 60_000;
    const tick = await call("POST", "/tick");
    expect(tick.json.started).toBe(1);

    const runs = await call("GET", "/runs?outcome=succeeded&limit=10");
    expect(runs.json.runs.length).toBeGreaterThanOrEqual(1);

    const stats = await call("GET", "/stats");
    expect(stats.json.jobs).toBe(2);
    expect(stats.json.runs).toBeGreaterThanOrEqual(1);

    const del = await call("DELETE", "/jobs/j-000002");
    expect(del.status).toBe(200);
    expect((await call("GET", "/jobs/j-000002")).status).toBe(404);

    const missing = await call("GET", "/definitely-not-a-route");
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });

  test("disabled jobs cannot be manually run via API", async () => {
    setup();
    await call("PATCH", "/jobs/j-000001", { enabled: false });
    const res = await call("POST", "/jobs/j-000001/run");
    expect(res.status).toBe(409);
  });

  test("http handler validation and body-size cap", async () => {
    setup();
    const badUrl = await call("POST", "/jobs", {
      name: "bad-url",
      schedule: { everySeconds: 60 },
      handler: { kind: "http", url: "ftp://nope" },
    });
    expect(badUrl.status).toBe(400);

    const getWithBody = await call("POST", "/jobs", {
      name: "bad-body",
      schedule: { everySeconds: 60 },
      handler: { kind: "http", url: "https://example.com", body: "x" },
    });
    expect(getWithBody.status).toBe(400);

    const huge = "x".repeat(70 * 1024);
    const res = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: huge }),
    });
    expect([400, 408]).toContain(res.status);
  });
});
