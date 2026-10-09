import type { HandlerFn, HandlerSpec } from "./types.js";
import { SchedulerError } from "./errors.js";

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`job handler timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createHttpHandler(spec: HandlerSpec & { kind: "http" }): HandlerFn {
  if (!/^https?:\/\//.test(spec.url)) {
    throw new SchedulerError("VALIDATION", `http handler url "${spec.url}" must use http or https`);
  }
  const headers: Record<string, string> | undefined =
    spec.headers !== undefined && Object.keys(spec.headers).length > 0 ? spec.headers : undefined;
  const body: string | undefined = spec.body;
  if (body !== undefined && (spec.method ?? "GET") === "GET") {
    throw new SchedulerError("VALIDATION", "http handler body requires a non-GET method");
  }
  return async ({ signal }) => {
    const res = await fetch(spec.url, {
      method: spec.method ?? "GET",
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.length > 300 ? `${text.slice(0, 300)}...` : text;
      throw new Error(`HTTP ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}`);
    }
    return text;
  };
}

export function validateHandlerSpec(spec: unknown): void {
  if (spec === null || typeof spec !== "object") {
    throw new SchedulerError("VALIDATION", "handler must be an object");
  }
  const h = spec as { kind?: unknown; handler?: unknown; url?: unknown; method?: unknown; body?: unknown; headers?: unknown };
  if (h.kind === "noop") return;
  if (h.kind === "named") {
    if (typeof h.handler !== "string" || h.handler.trim().length === 0) {
      throw new SchedulerError("VALIDATION", "named handler requires a non-empty handler name");
    }
    return;
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
    if (h.method !== undefined && (typeof h.method !== "string" || !/^[A-Za-z]+$/.test(h.method))) {
      throw new SchedulerError("VALIDATION", "http handler method must be an HTTP method token");
    }
    if (h.body !== undefined) {
      if (typeof h.body !== "string") {
        throw new SchedulerError("VALIDATION", "http handler body must be a string");
      }
      if ((typeof h.method === "string" ? h.method.toUpperCase() : "GET") === "GET") {
        throw new SchedulerError("VALIDATION", "http handler body requires a non-GET method");
      }
    }
    if (h.headers !== undefined) {
      if (typeof h.headers !== "object" || h.headers === null) {
        throw new SchedulerError("VALIDATION", "http handler headers must be an object");
      }
      for (const [key, value] of Object.entries(h.headers as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new SchedulerError("VALIDATION", `header ${key} must be a string`);
        }
      }
    }
    return;
  }
  throw new SchedulerError("VALIDATION", 'handler.kind must be "noop", "named", or "http"');
}
