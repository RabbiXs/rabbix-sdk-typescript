> **Vendored copy.** The source of truth is `conformance/` in the private `rabbix-platform` repository; do not edit these files here, re-copy them when a fixture changes. Relative doc links below point into that repository.

# SDK conformance suite

Language-neutral fixtures every RabbiX SDK must pass, so Python, TypeScript and .NET behave identically ([SDKs](../docs/components/sdks.md)).
This directory is the source of truth. The SDK repos are public and this one is private, so each SDK **vendors a copy** in its own `conformance/` directory; update the copies whenever a fixture changes.

## How an SDK runs a fixture

1. Create a client with `api_key = "rbx_test_conformance"`, base URL of a mock transport/server, and **zero retry backoff**.
2. For each entry in `calls`, invoke the SDK method named by `call` with `args`.
3. Every HTTP request the SDK makes during that call must match the next entry of the call's `exchanges` (in order); the mock answers with that entry's `response`. After the call, all its exchanges must be consumed: no fewer, no more requests.
4. Compare the outcome with `expect`: either `result` (the call returned) or `error` (the call raised).

Calls within one fixture share one client and one session: `propose` and `end_session` use the session from the most recent `start_session`.

## Calls

| `call` | `args` | Returns (`result`) |
| --- | --- | --- |
| `start_session` | `goal`, optional `agent`, `metadata` | `session_id` |
| `end_session` | `status` (`completed`/`failed`/`cancelled`), optional `summary` | `status` |
| `propose` | `action`, `proposal`, optional `reasoning`, `evidence`, `tags`, `callback_url`, `wait_for_approval` (default false) | decision: `action_id`, `route`, `status`, `handoff_id`, `degraded` |
| `get_decision` | `action_id`, optional `wait` (default false) | decision |
| `report` | `action_id`, `success`, optional `output`, `error` | `status` |

Map names idiomatically (`wait_for_approval` → `waitForApproval` / `WaitForApproval`, `action_id` → `actionId` / `ActionId`, …). `report` on a decision object is fine as long as it sends the same request.

## Matching

- `request.method`, `request.path`: exact (path includes the query string, e.g. `?wait=30s`).
- `request.headers`: header names are lower-case. Value is exact, or `"*"` (present, non-empty), or `"$capture:<name>"` (first use records the value; later uses must be equal; e.g. the same `Idempotency-Key` on retries).
- `request.body`: JSON **subset** match: every key in the fixture must be present with an equal value (objects recursively, arrays exactly); extra keys are allowed. Absent `body` = not checked.
- `response`: `status` + `body` (JSON), or `{ "network_error": true }` (the transport fails: connection refused/reset).
- `expect.result`: subset match on the returned value, using the snake_case names above. `expect.error`: error kind (below); optional `fields` subset match on the error's properties.

## Behaviour the suite pins down

| Topic | Rule |
| --- | --- |
| Auth | `Authorization: Bearer <api_key>` on every request |
| Idempotency | Every `propose` sends an `Idempotency-Key` (SDK-generated unless given); retries reuse it |
| Retries | 5xx or network error → retry, **3 attempts total**, every call. 4xx → never retried |
| Waiting | `wait_for_approval` / `wait`: long-poll `GET /v1/actions/{id}?wait=30s` while `status` is `pending` (propose) or `pending`/`handed_off` (get_decision) |
| Errors from `propose` | `rejected`, `expired`, `handed_off` (fields `action_id`, `handoff_id`), `declined`, `wait_timeout` |
| HTTP errors | 400/422 → `validation`, 401/403 → `authentication`, 404 → `not_found`, 409 → `conflict` |
| Fail mode | Every decision response carries `fail_mode`; the SDK caches the latest (default `closed`). When `propose` exhausts its retries: `closed` → error `unavailable`; `open` → result `{ "route": "ai_autonomous", "status": "approved", "degraded": true, "action_id": null }`. Other calls always raise `unavailable` |
| Non-blocking | Without `wait_for_approval`, a `pending` decision is returned (not raised); `handed_off` is always raised |
| `get_decision` | Never raises on the decision's status (returns rejected/expired/declined/released decisions); callers check whether it is approved/released before committing |
| Fail-open scope | Only the initial `POST /v1/actions` can yield a degraded approval. If the long-poll of a waiting `propose` is unreachable, `propose` raises `unavailable` (carrying `action_id`): a human-in-the-loop action is never auto-approved |
| Wait timeout | Optional overall wait timeout (default: none). On timeout `propose` raises `wait_timeout` (commit code must not run); `get_decision` returns the still-pending decision |
| Other statuses | `propose` returns (does not raise) `committed`, `failed`, `done_by_human` (possible on idempotent replay) |
| Degraded report | Reporting on a degraded decision (`action_id: null`) is a no-op |
| Session scope | A scoped session (Python `with`, TypeScript `withSession`) ends `completed` on normal exit, `failed` when an exception escapes (incl. `handed_off`); never ends twice. .NET `await using` cannot see exceptions: it ends `completed`; callers end `failed` explicitly |

## Files

| Fixture | Covers |
| --- | --- |
| `01-session.json` | Start/end session, auth header, request shape |
| `02-ai-autonomous.json` | Approved immediately, report result |
| `03-wait-approved.json` | Blocking wait: pending → long-poll → approved |
| `04-wait-rejected.json` | Blocking wait → `rejected` |
| `05-wait-expired.json` | Blocking wait → `expired` |
| `06-handed-off.json` | `human_only` → `handed_off` error |
| `07-pending-non-blocking.json` | Pending returned, resumed with `get_decision` |
| `08-resume-released.json` | Handed-off action released later, commit + report |
| `09-retry-idempotency.json` | 503 + network error retried with the same key |
| `10-http-errors.json` | 4xx mapping, no retries |
| `11-fail-closed.json` | Unreachable, default fail mode → `unavailable` |
| `12-fail-open.json` | Cached `fail_mode: open` → degraded approval |
