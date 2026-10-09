import http from "node:http";
import { timingSafeEqual as cryptoTimingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { Scheduler } from "./scheduler.js";
import { SchedulerError, isSchedulerError } from "./errors.js";
import type { HandlerSpec, PatchOptions, RunOutcome, RunsFilter } from "./types.js";

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) return false;
  return cryptoTimingSafeEqual(aBytes, bBytes);
}

function requireAuth(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return timingSafeEqual(auth.slice(7), token);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new SchedulerError("VALIDATION", `request body exceeds ${maxBytes} bytes`));
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseScheduleBody(raw: unknown): { cron?: string; everySeconds?: number } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object") {
    throw new SchedulerError("VALIDATION", "schedule must be an object");
  }
  const s = raw as Record<string, unknown>;
  if (s.cron !== undefined && s.everySeconds !== undefined) {
    throw new SchedulerError("VALIDATION", "provide exactly one of cron or everySeconds");
  }
  const out: { cron?: string; everySeconds?: number } = {};
  if (s.cron !== undefined) {
    if (typeof s.cron !== "string") throw new SchedulerError("VALIDATION", "cron must be a string");
    out.cron = s.cron;
  }
  if (s.everySeconds !== undefined) {
    const n = Number(s.everySeconds);
    if (!Number.isInteger(n) || n < 1) {
      throw new SchedulerError("VALIDATION", "everySeconds must be an integer >= 1");
    }
    out.everySeconds = n;
  }
  return out;
}

function parseHandlerBody(raw: unknown): HandlerSpec {
  if (raw === undefined) return { kind: "noop" };
  if (raw === null || typeof raw !== "object") {
    throw new SchedulerError("VALIDATION", "handler must be an object");
  }
  const h = raw as Record<string, unknown>;
  if (h.kind === "noop") return { kind: "noop" };
  if (h.kind === "named") {
    if (typeof h.handler !== "string" || h.handler.trim().length === 0) {
      throw new SchedulerError("VALIDATION", "named handler requires a non-empty handler name");
    }
    return { kind: "named", handler: h.handler };
  }
  if (h.kind === "http") {
    if (typeof h.url !== "string" || h.url.length === 0) {
      throw new SchedulerError("VALIDATION", "http handler requires a url string");
    }
    let parsed: URL;
    try {
      parsed = new URL(h.url);
    } catch {
      throw new SchedulerError("VALIDATION", `http handler url "${h.url}" is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new SchedulerError("VALIDATION", "http handler url must use http or https");
    }
    const spec: Extract<HandlerSpec, { kind: "http" }> = { kind: "http", url: h.url };
    if (h.method !== undefined) {
      if (typeof h.method !== "string" || !/^[A-Za-z]+$/.test(h.method)) {
        throw new SchedulerError("VALIDATION", "http handler method must be a method token");
      }
      spec.method = h.method.toUpperCase();
    }
    if (h.body !== undefined) {
      if (typeof h.body !== "string") {
        throw new SchedulerError("VALIDATION", "http handler body must be a string");
      }
      spec.body = h.body;
    }
    if (spec.body !== undefined && (spec.method ?? "GET") === "GET") {
      throw new SchedulerError("VALIDATION", "http handler body requires a non-GET method");
    }
    if (h.headers !== undefined) {
      if (typeof h.headers !== "object" || h.headers === null) {
        throw new SchedulerError("VALIDATION", "http handler headers must be an object");
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(h.headers as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new SchedulerError("VALIDATION", `header ${key} must be a string`);
        }
        headers[key] = value;
      }
      if (Object.keys(headers).length > 0) spec.headers = headers;
    }
    return spec;
  }
  throw new SchedulerError("VALIDATION", 'handler.kind must be "noop", "named", or "http"');
}

const OUTCOMES: readonly RunOutcome[] = ["running", "succeeded", "failed", "retrying"];

function isRunOutcome(value: string): value is RunOutcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

export interface ServeOptions {
  token?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

export function startServer(scheduler: Scheduler, opts: ServeOptions = {}): Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    try {
      if (path === "/healthz" && req.method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      if (mutating && !requireAuth(req, opts.token)) {
        sendError(res, 401, "UNAUTHORIZED", "missing or invalid bearer token");
        return;
      }
      if (path === "/stats" && req.method === "GET") {
        sendJson(res, 200, scheduler.stats());
        return;
      }
      if (path === "/jobs" && req.method === "GET") {
        const enabledRaw = url.searchParams.get("enabled");
        let jobs = scheduler.list();
        if (enabledRaw !== null) jobs = jobs.filter((j) => j.enabled === (enabledRaw === "true"));
        sendJson(res, 200, { jobs });
        return;
      }
      if (path === "/jobs" && req.method === "POST") {
        const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || "{}") as Record<string, unknown>;
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          throw new SchedulerError("VALIDATION", "job name must be a non-empty string");
        }
        const schedule = parseScheduleBody(body.schedule);
        const job = scheduler.add({
          name: body.name,
          ...(schedule.cron === undefined ? {} : { cron: schedule.cron }),
          ...(schedule.everySeconds === undefined ? {} : { every: schedule.everySeconds }),
          handler: parseHandlerBody(body.handler),
          ...(body.enabled === undefined ? {} : { enabled: Boolean(body.enabled) }),
          ...(body.timeoutMs === undefined ? {} : { timeoutMs: Number(body.timeoutMs) }),
          ...(body.maxRetries === undefined ? {} : { maxRetries: Number(body.maxRetries) }),
          ...(body.backoffMs === undefined ? {} : { backoffMs: Number(body.backoffMs) }),
        });
        sendJson(res, 201, { job });
        return;
      }
      if (parts[0] === "jobs" && parts.length === 2 && typeof parts[1] === "string") {
        const id = parts[1];
        if (req.method === "GET") {
          sendJson(res, 200, { job: scheduler.resolve(id) });
          return;
        }
        if (req.method === "PATCH") {
          const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || "{}") as Record<string, unknown>;
          const patch: PatchOptions = {};
          if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
          if (body.timeoutMs !== undefined) patch.timeoutMs = Number(body.timeoutMs);
          if (body.maxRetries !== undefined) patch.maxRetries = Number(body.maxRetries);
          if (body.backoffMs !== undefined) patch.backoffMs = Number(body.backoffMs);
          if (body.everySeconds !== undefined) patch.everySeconds = Number(body.everySeconds);
          if (typeof body.cron === "string") patch.cronExpr = body.cron;
          const job = scheduler.patch(id, patch);
          sendJson(res, 200, { job });
          return;
        }
        if (req.method === "DELETE") {
          const job = scheduler.remove(id);
          sendJson(res, 200, { deleted: job.id });
          return;
        }
      }
      if (parts[0] === "jobs" && parts.length === 3) {
        const id = parts[1] as string;
        const action = parts[2];
        if (req.method === "POST" && action === "run") {
          sendJson(res, 200, { run: await scheduler.runOnce(id) });
          return;
        }
        if (req.method === "POST" && (action === "enable" || action === "disable")) {
          sendJson(res, 200, { job: scheduler.setEnabled(id, action === "enable") });
          return;
        }
      }
      if (path === "/runs" && req.method === "GET") {
        const jobId = url.searchParams.get("job") ?? undefined;
        const outcomeRaw = url.searchParams.get("outcome");
        if (outcomeRaw !== null && !isRunOutcome(outcomeRaw)) {
          throw new SchedulerError("VALIDATION", `unknown outcome filter "${outcomeRaw}"`);
        }
        const limitRaw = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : 50;
        const filter: RunsFilter = {};
        if (jobId !== undefined) filter.jobId = jobId;
        if (outcomeRaw !== null) filter.outcome = outcomeRaw as RunOutcome;
        filter.limit = limit;
        const runs = scheduler.runs(filter);
        sendJson(res, 200, { runs });
        return;
      }
      if (path === "/tick" && req.method === "POST") {
        sendJson(res, 200, await scheduler.tick());
        return;
      }
      sendError(res, 404, "NOT_FOUND", `no route for ${req.method} ${path}`);
    } catch (e) {
      if (isSchedulerError(e)) {
        sendError(res, e.httpStatus, e.code, e.message);
        return;
      }
      if (e instanceof SyntaxError) {
        sendError(res, 400, "VALIDATION", "request body is not valid JSON");
        return;
      }
      sendError(res, 500, "INTERNAL", e instanceof Error ? e.message : String(e));
    }
  });
}
