import pkg from "../package.json" with { type: "json" };
import {
  AuthenticationError,
  Conflict,
  Declined,
  Expired,
  HandedOff,
  NotFound,
  RabbiXError,
  Rejected,
  Unavailable,
  ValidationError,
  WaitTimeout,
} from "./errors.ts";

/** Sent as `User-Agent` on every request (see README: what this SDK sends). */
export const userAgent = `rabbix-sdk-typescript/${pkg.version}`;

export type Route = "ai_autonomous" | "human_in_the_loop" | "human_only";
export type ActionStatus =
  | "proposed"
  | "approved"
  | "pending"
  | "rejected"
  | "expired"
  | "handed_off"
  | "released"
  | "declined"
  | "done_by_human"
  | "committed"
  | "failed";
export type FailMode = "closed" | "open";
export type SessionStatus = "active" | "completed" | "failed" | "cancelled";
export type DecidedBy = "policy" | "classifier" | "fail_mode";

export interface Finding {
  check: string;
  result: string;
  detail?: string | null;
  claim?: string | null;
  evidence?: string | null;
}

export interface RabbiXOptions {
  /** Your RabbiX API key (`rbx_live_...` / `rbx_test_...`). The SDK never reads it from the environment itself. */
  apiKey: string;
  /** API endpoint. Default `https://api.rabbix.ai`. */
  baseUrl?: string;
  /** `fetch` implementation; defaults to the global `fetch`. Inject one for proxies, tests or custom agents. */
  fetch?: typeof globalThis.fetch;
  /** Base delay before a retry (doubles per attempt). Default 200 ms; 0 disables the delay. */
  retryBackoffMs?: number;
  /** Per-request timeout; a long-poll gets this plus its wait. Default 30000 ms. A timeout counts as a network error (retried). */
  timeoutMs?: number;
}

export interface StartSessionOptions {
  goal: string;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface EndSessionOptions {
  /** Default `completed`. */
  status?: Exclude<SessionStatus, "active">;
  summary?: string;
}

export interface EndSessionResult {
  sessionId: string;
  status: SessionStatus;
}

export interface ProposeOptions {
  /** Action name, e.g. `refunds.issue`. */
  action: string;
  /** The concrete effect your code is about to commit (a JSON object). */
  proposal: Record<string, unknown>;
  reasoning?: string;
  evidence?: Record<string, unknown>;
  tags?: string[];
  /** Webhook RabbiX calls when the decision changes. */
  callbackUrl?: string;
  /** Block (long-poll) while a human decides. Default false: a pending decision is returned. */
  waitForApproval?: boolean;
  /** Reuse a key to make a retried propose idempotent across process restarts. Default: random UUID per call. */
  idempotencyKey?: string;
  /** Upper bound for `waitForApproval`; throws `WaitTimeout` when reached. Default: no client-side limit. */
  waitTimeoutMs?: number;
}

export interface GetDecisionOptions {
  /** Long-poll while the action is `pending` or `handed_off`. Default false. */
  wait?: boolean;
  /** Upper bound for `wait`; when reached, the still-pending decision is returned. Default: no client-side limit. */
  waitTimeoutMs?: number;
}

export interface ReportOptions {
  success: boolean;
  output?: unknown;
  error?: string;
}

export interface ReportResult {
  /** `null` for a degraded (fail-open) decision, which is not reported. */
  actionId: string | null;
  status: ActionStatus | null;
}

export interface Decision {
  /** `null` only for a degraded decision made locally under fail mode `open`. */
  readonly actionId: string | null;
  readonly route: Route | null;
  readonly status: ActionStatus;
  readonly handoffId: string | null;
  /** True when RabbiX was unreachable and the cached fail mode `open` approved the action locally. */
  readonly degraded: boolean;
  /** True when your code may commit: status `approved` or `released`. */
  readonly approved: boolean;
  readonly reason: string | null;
  readonly decidedBy: DecidedBy | null;
  readonly findings: Finding[];
  readonly tags: string[];
  readonly expiresAt: string | null;
  /** Report the result after your code committed (or failed to commit). */
  report(options: ReportOptions): Promise<ReportResult>;
}

export interface Session {
  readonly sessionId: string;
  /** Propose an effect before committing it. Throws `HandedOff`, `Rejected`, `Expired` or `Declined` when you must not commit. */
  propose(options: ProposeOptions): Promise<Decision>;
  /** True once `end` succeeded (or is in flight). */
  readonly ended: boolean;
  end(options?: EndSessionOptions): Promise<EndSessionResult>;
}

interface ActionView {
  action_id: string;
  route: Route | null;
  status: ActionStatus;
  reason: string | null;
  decided_by: DecidedBy | null;
  findings?: Finding[];
  tags?: string[];
  handoff_id: string | null;
  expires_at: string | null;
  fail_mode?: FailMode;
}

const MAX_ATTEMPTS = 3;
const LONG_POLL_SECONDS = 30;

class Core {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #backoffMs: number;
  readonly #timeoutMs: number;
  failMode: FailMode = "closed";

  constructor(options: RabbiXOptions) {
    if (!options.apiKey) throw new TypeError("RabbiX: apiKey is required");
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.rabbix.ai").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#backoffMs = options.retryBackoffMs ?? 200;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** One logical call: up to 3 attempts on 5xx/network errors, 4xx mapped to typed errors. */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    waitSeconds = 0,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      accept: "application/json",
      "user-agent": userAgent,
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let lastError: unknown;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1 && this.#backoffMs > 0) await sleep(this.#backoffMs * 2 ** (attempt - 2));
      let response: Response;
      let parsed: unknown;
      try {
        const signal = AbortSignal.timeout(this.#timeoutMs + waitSeconds * 1000);
        response = await this.#fetch(this.#baseUrl + path, {
          method,
          headers,
          body: payload,
          signal,
        });
        parsed = await readJson(response);
      } catch (error) {
        lastError = error;
        lastStatus = undefined;
        continue;
      }
      if (response.status >= 500) {
        lastError = undefined;
        lastStatus = response.status;
        continue;
      }
      if (response.status >= 400) throw httpError(response.status, parsed);
      return parsed as T;
    }
    throw new Unavailable(
      `RabbiX unreachable after ${MAX_ATTEMPTS} attempts (${method} ${path}: ${lastStatus === undefined ? "network error" : `HTTP ${lastStatus}`})`,
      { httpStatus: lastStatus, cause: lastError },
    );
  }

  async getView(actionId: string, waitSeconds?: number): Promise<ActionView> {
    const query = waitSeconds === undefined ? "" : `?wait=${waitSeconds}s`;
    return this.#cache(
      await this.request<ActionView>(
        "GET",
        `/v1/actions/${encodeURIComponent(actionId)}${query}`,
        undefined,
        {},
        waitSeconds,
      ),
    );
  }

  /** Long-polls while the status is in `statuses`; on `timeoutMs` either throws `WaitTimeout` or returns the view. */
  async waitWhile(
    view: ActionView,
    statuses: ActionStatus[],
    timeoutMs: number | undefined,
    onTimeout: "throw" | "return",
  ): Promise<ActionView> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (statuses.includes(view.status)) {
      let seconds = LONG_POLL_SECONDS;
      if (deadline !== undefined) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          if (onTimeout === "return") return view;
          throw new WaitTimeout(
            `Timed out waiting for a decision on action ${view.action_id} (still ${view.status})`,
            {
              actionId: view.action_id,
              handoffId: view.handoff_id,
            },
          );
        }
        seconds = Math.min(seconds, Math.ceil(remaining / 1000));
      }
      view = await this.getView(view.action_id, seconds);
    }
    return view;
  }

  async propose(sessionId: string, options: ProposeOptions): Promise<Decision> {
    const body = {
      session_id: sessionId,
      action: options.action,
      proposal: options.proposal,
      reasoning: options.reasoning,
      evidence: options.evidence,
      tags: options.tags,
      callback_url: options.callbackUrl,
    };
    const idempotencyKey = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    let view: ActionView;
    try {
      view = this.#cache(
        await this.request<ActionView>("POST", "/v1/actions", body, {
          "idempotency-key": idempotencyKey,
        }),
      );
    } catch (error) {
      if (error instanceof Unavailable && this.failMode === "open") return degradedDecision(this);
      throw error;
    }
    if (options.waitForApproval) {
      try {
        view = await this.waitWhile(view, ["pending"], options.waitTimeoutMs, "throw");
      } catch (error) {
        // Fail mode never applies here: a pending human decision is never auto-approved.
        if (error instanceof Unavailable)
          throw new Unavailable(
            `${error.message}; action ${view.action_id} is still ${view.status}`,
            {
              actionId: view.action_id,
              httpStatus: error.httpStatus,
              cause: error,
            },
          );
        throw error;
      }
    }
    throwIfBlocked(view);
    return toDecision(this, view);
  }

  async report(actionId: string, options: ReportOptions): Promise<ReportResult> {
    const response = await this.request<{ action_id: string; status: ActionStatus }>(
      "POST",
      `/v1/actions/${encodeURIComponent(actionId)}/result`,
      { success: options.success, output: options.output, error: options.error },
    );
    return { actionId: response.action_id, status: response.status };
  }

  #cache(view: ActionView): ActionView {
    if (view.fail_mode === "open" || view.fail_mode === "closed") this.failMode = view.fail_mode;
    return view;
  }
}

/** RabbiX client. One instance per process is enough; it caches the organization's fail mode. */
export class RabbiX {
  readonly #core: Core;

  constructor(options: RabbiXOptions) {
    this.#core = new Core(options);
  }

  /** The organization's fail mode as last reported by RabbiX (default `closed` until a decision was seen). */
  get failMode(): FailMode {
    return this.#core.failMode;
  }

  /**
   * Runs `fn` in a session and ends it: `completed` when `fn` returns, `failed` when it throws (including
   * `HandedOff`; the error is rethrown). A session your code already ended is not ended again.
   */
  async withSession<T>(
    options: StartSessionOptions,
    fn: (session: Session) => Promise<T>,
  ): Promise<T> {
    const session = await this.startSession(options);
    let result: T;
    try {
      result = await fn(session);
    } catch (error) {
      if (!session.ended) await session.end({ status: "failed" }).catch(() => undefined);
      throw error;
    }
    if (!session.ended) await session.end({ status: "completed" });
    return result;
  }

  async startSession(options: StartSessionOptions): Promise<Session> {
    const response = await this.#core.request<{ session_id: string }>("POST", "/v1/sessions", {
      goal: options.goal,
      agent: options.agent,
      metadata: options.metadata,
    });
    return new SessionImpl(this.#core, response.session_id);
  }

  /** Current decision for an action, e.g. to resume a pending or handed-off action. Never throws for the decision's status. */
  async getDecision(actionId: string, options: GetDecisionOptions = {}): Promise<Decision> {
    let view = await this.#core.getView(actionId, options.wait ? LONG_POLL_SECONDS : undefined);
    if (options.wait)
      view = await this.#core.waitWhile(
        view,
        ["pending", "handed_off"],
        options.waitTimeoutMs,
        "return",
      );
    return toDecision(this.#core, view);
  }

  /** Report a commit's result by action id (same as `decision.report`). */
  report(actionId: string, options: ReportOptions): Promise<ReportResult> {
    return this.#core.report(actionId, options);
  }
}

class SessionImpl implements Session {
  readonly #core: Core;
  readonly sessionId: string;
  #ended = false;

  constructor(core: Core, sessionId: string) {
    this.#core = core;
    this.sessionId = sessionId;
  }

  propose(options: ProposeOptions): Promise<Decision> {
    return this.#core.propose(this.sessionId, options);
  }

  get ended(): boolean {
    return this.#ended;
  }

  async end(options: EndSessionOptions = {}): Promise<EndSessionResult> {
    this.#ended = true;
    let response: { session_id: string; status: SessionStatus };
    try {
      response = await this.#core.request<{ session_id: string; status: SessionStatus }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(this.sessionId)}/end`,
        { status: options.status ?? "completed", summary: options.summary },
      );
    } catch (error) {
      this.#ended = false;
      throw error;
    }
    return { sessionId: response.session_id, status: response.status };
  }
}

class DecisionImpl implements Decision {
  readonly #core: Core;
  readonly actionId: string | null;
  readonly route: Route | null;
  readonly status: ActionStatus;
  readonly handoffId: string | null;
  readonly degraded: boolean;
  readonly approved: boolean;
  readonly reason: string | null;
  readonly decidedBy: DecidedBy | null;
  readonly findings: Finding[];
  readonly tags: string[];
  readonly expiresAt: string | null;

  constructor(core: Core, fields: Omit<Decision, "report" | "approved">) {
    this.#core = core;
    this.actionId = fields.actionId;
    this.route = fields.route;
    this.status = fields.status;
    this.handoffId = fields.handoffId;
    this.degraded = fields.degraded;
    this.approved = fields.status === "approved" || fields.status === "released";
    this.reason = fields.reason;
    this.decidedBy = fields.decidedBy;
    this.findings = fields.findings;
    this.tags = fields.tags;
    this.expiresAt = fields.expiresAt;
  }

  report(options: ReportOptions): Promise<ReportResult> {
    // A degraded decision never reached RabbiX, so there is nothing to report against.
    if (this.actionId === null) return Promise.resolve({ actionId: null, status: null });
    return this.#core.report(this.actionId, options);
  }
}

function toDecision(core: Core, view: ActionView): Decision {
  return new DecisionImpl(core, {
    actionId: view.action_id,
    route: view.route,
    status: view.status,
    handoffId: view.handoff_id ?? null,
    degraded: false,
    reason: view.reason ?? null,
    decidedBy: view.decided_by ?? null,
    findings: view.findings ?? [],
    tags: view.tags ?? [],
    expiresAt: view.expires_at ?? null,
  });
}

function degradedDecision(core: Core): Decision {
  return new DecisionImpl(core, {
    actionId: null,
    route: "ai_autonomous",
    status: "approved",
    handoffId: null,
    degraded: true,
    reason: "RabbiX unreachable; approved by fail mode open",
    decidedBy: "fail_mode",
    findings: [],
    tags: [],
    expiresAt: null,
  });
}

function throwIfBlocked(view: ActionView): void {
  const details = { actionId: view.action_id, handoffId: view.handoff_id ?? null, body: view };
  const why = view.reason ? `: ${view.reason}` : "";
  switch (view.status) {
    case "handed_off":
      throw new HandedOff(`Action ${view.action_id} was handed off to a human${why}`, details);
    case "rejected":
      throw new Rejected(`Action ${view.action_id} was rejected${why}`, details);
    case "expired":
      throw new Expired(`Action ${view.action_id} expired before anyone decided${why}`, details);
    case "declined":
      throw new Declined(`Action ${view.action_id} was declined${why}`, details);
  }
}

function httpError(status: number, body: unknown): RabbiXError {
  const problem = (body ?? {}) as { title?: unknown; detail?: unknown };
  const text = [problem.title, problem.detail]
    .filter((part) => typeof part === "string" && part)
    .join(": ");
  const message = `HTTP ${status}${text ? ` ${text}` : ""}`;
  const details = { httpStatus: status, body };
  if (status === 400 || status === 422) return new ValidationError(message, details);
  if (status === 401 || status === 403) return new AuthenticationError(message, details);
  if (status === 404) return new NotFound(message, details);
  if (status === 409) return new Conflict(message, details);
  return new RabbiXError("http", message, details);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
