/** Machine-readable error kind; matches the conformance suite's names. */
export type ErrorKind =
  | "rejected"
  | "expired"
  | "handed_off"
  | "declined"
  | "wait_timeout"
  | "validation"
  | "authentication"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "http";

export interface ErrorDetails {
  actionId?: string | null;
  handoffId?: string | null;
  /** HTTP status of the response that caused the error, if any. */
  httpStatus?: number;
  /** Parsed response body (RFC 9457 problem details for HTTP errors). */
  body?: unknown;
  cause?: unknown;
}

/** Base class of every error the SDK throws. */
export class RabbiXError extends Error {
  readonly kind: ErrorKind;
  readonly actionId: string | null;
  readonly handoffId: string | null;
  readonly httpStatus: number | undefined;
  readonly body: unknown;

  constructor(kind: ErrorKind, message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.kind = kind;
    this.actionId = details.actionId ?? null;
    this.handoffId = details.handoffId ?? null;
    this.httpStatus = details.httpStatus;
    this.body = details.body;
  }
}

/** `human_only`: a human takes over. Do not commit; resume later via `getDecision` if released. */
export class HandedOff extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("handed_off", message, details);
  }
}

/** A human (or policy) rejected the proposed action. Do not commit. */
export class Rejected extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("rejected", message, details);
  }
}

/** Nobody decided before the approval deadline. Do not commit. */
export class Expired extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("expired", message, details);
  }
}

/** RabbiX declined to route the action. Do not commit. */
export class Declined extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("declined", message, details);
  }
}

/** `waitTimeoutMs` elapsed while the decision was still pending. Do not commit; resume via `getDecision`. */
export class WaitTimeout extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("wait_timeout", message, details);
  }
}

/** HTTP 400/422: the request was malformed. */
export class ValidationError extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("validation", message, details);
  }
}

/** HTTP 401/403: missing, invalid or insufficient API key. */
export class AuthenticationError extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("authentication", message, details);
  }
}

/** HTTP 404. */
export class NotFound extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("not_found", message, details);
  }
}

/** HTTP 409, e.g. reporting a result for an action that is not approved. */
export class Conflict extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("conflict", message, details);
  }
}

/** RabbiX could not be reached (5xx or network error after all retries) and the fail mode is closed. */
export class Unavailable extends RabbiXError {
  constructor(message: string, details: ErrorDetails = {}) {
    super("unavailable", message, details);
  }
}
