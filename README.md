# RabbiX SDK for TypeScript

Govern what your autonomous AI agents commit: propose an effect, get a route from RabbiX, commit only when allowed. Zero runtime dependencies (uses `fetch`).

```sh
npm install @rabbix/sdk   # not published yet
```

## Status

Pre-release (0.x). Implements the RabbiX agent API v1 and passes the shared SDK conformance suite (`conformance/`, vendored from the platform repository). Not published yet; the API may still change.

## Usage

```ts
import { HandedOff, RabbiX, Rejected } from "@rabbix/sdk";

const rbx = new RabbiX({ apiKey: process.env.RABBIX_API_KEY! });
const session = await rbx.startSession({
  agent: "refund-agent",
  goal: "Decide whether C-4411 gets a refund",
});

try {
  const decision = await session.propose({
    action: "refunds.issue",
    proposal: { customer_id: "C-4411", order_id: "O-9012", amount: 350, currency: "USD" },
    reasoning: "New customer, no previous refunds, item arrived damaged (photo attached).",
    evidence: { "customer.refund_count": 0, "ticket.attachments": ["damage.jpg"] },
    tags: ["support"],
    waitForApproval: true, // human_in_the_loop: block until a human decides
  });
  const refund = await payments.refund(/* ... */); // the commit
  await decision.report({ success: true, output: { refund_id: refund.id } });
} catch (error) {
  if (error instanceof HandedOff) savePending(error.actionId); // do not commit; resume if released
  else if (!(error instanceof Rejected)) throw error;
}

await session.end({ status: "completed", summary: "Refund issued" });
```

- `new RabbiX({ apiKey, baseUrl?, fetch?, retryBackoffMs?, timeoutMs? })`: `baseUrl` defaults to `https://api.rabbix.ai`; `fetch` lets you inject a transport (proxy, tests); `timeoutMs` (default 30000) bounds each request, and a long-poll gets it plus its wait.
- `session.propose({ action, proposal, reasoning?, evidence?, tags?, callbackUrl?, waitForApproval?, idempotencyKey?, waitTimeoutMs? })` returns a `Decision` (`actionId`, `route`, `status`, `approved`, `handoffId`, `degraded`, `reason`, `decidedBy`, `findings`, `tags`, `expiresAt`, `report(...)`).
  - Without `waitForApproval`, a `pending` decision is returned; resume with `rbx.getDecision(actionId, { wait: true })`.
  - Throws `HandedOff` (`human_only`, always), `Rejected`, `Expired`, `Declined`; `WaitTimeout` if `waitTimeoutMs` elapses while still pending. Other statuses (`committed`, `failed`, `done_by_human`, possible on an idempotent replay) are returned; check `decision.approved` before committing.
- `rbx.getDecision(actionId, { wait?, waitTimeoutMs? })`: the current decision; with `wait`, long-polls while `pending` or `handed_off` (a released handoff comes back as `status: "released"`, `approved: true`). Never throws for the decision's status; on `waitTimeoutMs` it returns the still-pending decision.
- `rbx.report(actionId, { success, output?, error? })` does the same as `decision.report(...)`.
- `rbx.withSession({ goal, agent?, metadata? }, async (session) => ...)`: scoped session; ends `completed` when the callback returns, `failed` when it throws (including `HandedOff`; the error is rethrown), and never ends a session twice.
- HTTP errors: `ValidationError` (400/422), `AuthenticationError` (401/403), `NotFound` (404), `Conflict` (409). All errors extend `RabbiXError` (`kind`, `actionId`, `handoffId`, `httpStatus`, `body`).
- Reliability: 5xx, network errors and timeouts are retried per request, long-polls included (3 attempts in total, exponential backoff, same `Idempotency-Key`). If the initial propose request stays unreachable, the organization's fail mode applies (sent with every decision and cached by the client; default closed): closed throws `Unavailable`; open returns a `degraded` approval with `actionId: null` (its `report` sends nothing). If the long-poll of a waiting propose is unreachable, it throws `Unavailable` with the `actionId` (a pending human decision is never auto-approved). All other calls throw `Unavailable`.

A runnable sample agent is in [`examples/refund-agent.ts`](examples/refund-agent.ts):

```sh
RABBIX_API_KEY=rbx_test_... RABBIX_BASE_URL=http://localhost:5021 node examples/refund-agent.ts
```

## How it works

Your agent works freely. Before its work takes effect (a refund is paid, an email sent, code pushed), it **proposes** that effect to RabbiX together with its goal, reasoning and evidence. RabbiX answers with a route:

| Route               | What the SDK does                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ai_autonomous`     | Returns; your code commits.                                                                                           |
| `human_in_the_loop` | Blocks (or returns a pending decision) until a human approves or rejects.                                             |
| `human_only`        | Raises `HandedOff`. Your code must not commit; a human takes over. If they approve, RabbiX releases the commit later. |

## What this SDK sends, and when

This repository is public so your security reviewers can verify this list against the code. The SDK sends **only what your code explicitly passes to it**, plus the transport metadata listed below. It does not read environment variables (you pass the API key and endpoint explicitly), files, process or host information, and it has no telemetry of its own.

| Call          | When                                                               | Fields sent                                                                                                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Start session | Your code starts a session                                         | `agent` (name), `goal`, optional `metadata`                                                                  |
| Propose       | Before your code commits an effect                                 | `session_id`, `action` (name), `proposal`, `reasoning`, `evidence`, optional `tags`, optional `callback_url` |
| Wait / resume | While waiting for a human decision, or when you call `getDecision` | `action_id` (in the URL)                                                                                     |
| Report result | After your code committed                                          | `action_id`, `success`, `output` and/or `error` as passed                                                    |
| End session   | Your code ends the session                                         | `session_id`, `status`, optional summary                                                                     |

Transport metadata on every request: `Authorization: Bearer <your API key>`, `User-Agent` (SDK name and version), `Accept` / `Content-Type: application/json`. Propose requests also carry an `Idempotency-Key` (a random UUID unless you pass `idempotencyKey`; reused on retries). No trace headers are sent.

All requests go to the RabbiX API endpoint you configure (`https://api.rabbix.ai` by default, over HTTPS), through the global `fetch` or the one you inject. Nothing is sent anywhere else.

**Redaction**: you decide what goes into `proposal`, `reasoning` and `evidence`. Leave out or mask fields you are not allowed to share; a redaction hook will let you do this centrally.

## License

Apache-2.0
