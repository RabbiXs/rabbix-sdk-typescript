import { expect, test } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import { HandedOff, RabbiX, Unavailable, WaitTimeout, userAgent } from "../src/index.ts";
import { type Exchange, MOCK_BASE_URL, MockTransport } from "./mock-transport.ts";

const actionId = "0199f3c2-8b40-7e11-a5c3-2f9d0e7b1a44";

function view(status: string, failMode = "closed") {
  return {
    action_id: actionId,
    route: status === "handed_off" ? "human_only" : "human_in_the_loop",
    status,
    reason: "Limit: Agent refund limit (500)",
    decided_by: "policy",
    findings: [],
    tags: [],
    handoff_id: status === "handed_off" ? "0199f3c2-9c51-7f22-b6d4-3a0e1f8c2b55" : null,
    expires_at: null,
    fail_mode: failMode,
  };
}

const sessionExchange: Exchange = {
  request: { method: "POST", path: "/v1/sessions" },
  response: { status: 201, body: { session_id: "s-1" } },
};

function client(exchanges: Exchange[]) {
  const transport = new MockTransport();
  transport.expect(exchanges);
  const rbx = new RabbiX({
    apiKey: "rbx_test_unit",
    baseUrl: `${MOCK_BASE_URL}/`,
    fetch: transport.fetch,
    retryBackoffMs: 0,
  });
  return { rbx, transport };
}

test("user agent carries the package version", () => {
  expect(userAgent).toBe(`rabbix-sdk-typescript/${pkg.version}`);
});

test("sends user agent, a caller-supplied idempotency key, and maps the decision to camelCase", async () => {
  const { rbx, transport } = client([
    sessionExchange,
    {
      request: {
        method: "POST",
        path: "/v1/actions",
        headers: {
          "user-agent": userAgent,
          "idempotency-key": "my-key",
          "content-type": "application/json",
        },
        body: { session_id: "s-1", callback_url: "https://example.test/hook" },
      },
      response: { status: 202, body: { ...view("pending"), expires_at: "2026-10-19T09:15:00Z" } },
    },
  ]);
  const session = await rbx.startSession({ goal: "g" });
  const decision = await session.propose({
    action: "refunds.issue",
    proposal: { amount: 1800 },
    callbackUrl: "https://example.test/hook",
    idempotencyKey: "my-key",
  });
  expect(transport.failures).toEqual([]);
  expect(decision).toMatchObject({
    actionId,
    status: "pending",
    route: "human_in_the_loop",
    decidedBy: "policy",
    expiresAt: "2026-10-19T09:15:00Z",
    degraded: false,
  });
});

test("handed_off is thrown even without waitForApproval", async () => {
  const { rbx } = client([
    sessionExchange,
    {
      request: { method: "POST", path: "/v1/actions" },
      response: { status: 200, body: view("handed_off") },
    },
  ]);
  const session = await rbx.startSession({ goal: "g" });
  const error = await session.propose({ action: "a", proposal: {} }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HandedOff);
  expect(error).toMatchObject({ actionId, handoffId: "0199f3c2-9c51-7f22-b6d4-3a0e1f8c2b55" });
});

test("waitTimeoutMs ends a blocking wait with WaitTimeout", async () => {
  const { rbx } = client([
    sessionExchange,
    {
      request: { method: "POST", path: "/v1/actions" },
      response: { status: 202, body: view("pending") },
    },
  ]);
  const session = await rbx.startSession({ goal: "g" });
  const error = await session
    .propose({ action: "a", proposal: {}, waitForApproval: true, waitTimeoutMs: 0 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WaitTimeout);
  expect(error).toMatchObject({ actionId, kind: "wait_timeout" });
});

test("a degraded (fail-open) decision is not reported, and other calls still fail closed", async () => {
  const down: Exchange = {
    request: { method: "POST", path: "/v1/actions" },
    response: { network_error: true },
  };
  const { rbx, transport } = client([
    sessionExchange,
    {
      request: { method: "POST", path: "/v1/actions" },
      response: { status: 200, body: view("approved", "open") },
    },
    down,
    down,
    down,
    ...Array.from({ length: 3 }, (): Exchange => ({
      request: { method: "GET", path: `/v1/actions/${actionId}` },
      response: { status: 500, body: null },
    })),
  ]);
  const session = await rbx.startSession({ goal: "g" });
  await session.propose({ action: "a", proposal: {} });
  expect(rbx.failMode).toBe("open");
  const degraded = await session.propose({ action: "a", proposal: {} });
  expect(degraded).toMatchObject({ actionId: null, degraded: true, status: "approved" });
  expect(await degraded.report({ success: true })).toEqual({ actionId: null, status: null });
  await expect(rbx.getDecision(actionId)).rejects.toBeInstanceOf(Unavailable);
  expect(transport.failures).toEqual([]);
  expect(transport.remaining).toBe(0);
});

test("a pending action whose long-poll is unreachable throws Unavailable with its actionId, even under fail mode open", async () => {
  const poll: Exchange = {
    request: { method: "GET", path: `/v1/actions/${actionId}?wait=30s` },
    response: { network_error: true },
  };
  const { rbx, transport } = client([
    sessionExchange,
    {
      request: { method: "POST", path: "/v1/actions" },
      response: { status: 202, body: view("pending", "open") },
    },
    poll,
    poll,
    poll,
  ]);
  const session = await rbx.startSession({ goal: "g" });
  const error = await session
    .propose({ action: "a", proposal: {}, waitForApproval: true })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Unavailable);
  expect(error).toMatchObject({ actionId });
  expect(transport.remaining).toBe(0);
});

test("getDecision never throws on status, exposes approved, and returns the pending decision on waitTimeoutMs", async () => {
  const get = (status: string): Exchange => ({
    request: { method: "GET", path: `/v1/actions/${actionId}` },
    response: { status: 200, body: view(status) },
  });
  const { rbx } = client([
    get("rejected"),
    get("released"),
    {
      request: { method: "GET", path: `/v1/actions/${actionId}?wait=30s` },
      response: { status: 202, body: view("pending") },
    },
  ]);
  expect(await rbx.getDecision(actionId)).toMatchObject({ status: "rejected", approved: false });
  expect(await rbx.getDecision(actionId)).toMatchObject({ status: "released", approved: true });
  expect(await rbx.getDecision(actionId, { wait: true, waitTimeoutMs: 0 })).toMatchObject({
    status: "pending",
    approved: false,
  });
});

test("propose returns (does not throw) committed on an idempotent replay", async () => {
  const { rbx } = client([
    sessionExchange,
    {
      request: { method: "POST", path: "/v1/actions" },
      response: { status: 200, body: view("committed") },
    },
  ]);
  const session = await rbx.startSession({ goal: "g" });
  expect(await session.propose({ action: "a", proposal: {} })).toMatchObject({
    status: "committed",
    approved: false,
  });
});

function endExchange(status: string): Exchange {
  return {
    request: { method: "POST", path: "/v1/sessions/s-1/end", body: { status } },
    response: { status: 200, body: { session_id: "s-1", status } },
  };
}

test("withSession ends completed on success, failed on an escaping error, and never twice", async () => {
  const { rbx, transport } = client([
    sessionExchange,
    endExchange("completed"),
    sessionExchange,
    {
      request: { method: "POST", path: "/v1/actions" },
      response: { status: 200, body: view("handed_off") },
    },
    endExchange("failed"),
    sessionExchange,
    endExchange("cancelled"),
  ]);
  expect(await rbx.withSession({ goal: "g" }, async () => 42)).toBe(42);
  await expect(
    rbx.withSession({ goal: "g" }, (s) => s.propose({ action: "a", proposal: {} })),
  ).rejects.toBeInstanceOf(HandedOff);
  await rbx.withSession({ goal: "g" }, (s) => s.end({ status: "cancelled" }));
  expect(transport.failures).toEqual([]);
  expect(transport.remaining).toBe(0);
});
