export type SchedulerErrorCode = "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "CORRUPTION";

const HTTP_STATUS: Record<SchedulerErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CORRUPTION: 500,
};

export class SchedulerError extends Error {
  readonly code: SchedulerErrorCode;

  constructor(code: SchedulerErrorCode, message: string) {
    super(message);
    this.name = "SchedulerError";
    this.code = code;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export function isSchedulerError(err: unknown): err is SchedulerError {
  return err instanceof SchedulerError;
}
