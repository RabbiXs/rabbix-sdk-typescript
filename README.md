# RabbiX SDK for TypeScript

Govern what your autonomous AI agents commit: propose an effect, get a route from RabbiX, commit only when allowed. Zero runtime dependencies (uses `fetch`).

```sh
npm install @rabbix/sdk   # not published yet
```

## Status

Pre-release. The package is scaffolded; the client is being built against the RabbiX agent API. Do not use in production yet.

## How it works

Your agent works freely. Before its work takes effect (a refund is paid, an email sent, code pushed), it **proposes** that effect to RabbiX together with its goal, reasoning and evidence. RabbiX answers with a route:

| Route               | What the SDK does                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ai_autonomous`     | Returns; your code commits.                                                                                           |
| `human_in_the_loop` | Blocks (or returns a pending decision) until a human approves or rejects.                                             |
| `human_only`        | Raises `HandedOff`. Your code must not commit; a human takes over. If they approve, RabbiX releases the commit later. |

## What this SDK sends, and when

This repository is public so your security reviewers can verify this list against the code. The SDK sends **only what your code explicitly passes to it**, plus the transport metadata listed below. It does not read environment variables (other than the API key you point it to), files, process or host information, and it has no telemetry of its own.

| Call          | When                               | Fields sent                                                                                                  |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Start session | Your code starts a session         | `agent` (name), `goal`, optional `metadata`                                                                  |
| Propose       | Before your code commits an effect | `session_id`, `action` (name), `proposal`, `reasoning`, `evidence`, optional `tags`, optional `callback_url` |
| Wait          | While waiting for a human decision | `action_id`                                                                                                  |
| Report result | After your code committed          | `action_id`, `success`, `output` and/or `error` as passed                                                    |
| End session   | Your code ends the session         | `session_id`, `status`, optional summary                                                                     |

Transport metadata on every request: `Authorization: Bearer <your API key>`, `Idempotency-Key` (random, for safe retries), `User-Agent` (SDK name and version), `traceparent` (only if your process already has an active trace).

All requests go over HTTPS to the RabbiX API endpoint you configure. Nothing is sent anywhere else.

**Redaction**: you decide what goes into `proposal`, `reasoning` and `evidence`. Leave out or mask fields you are not allowed to share; a redaction hook will let you do this centrally.

## License

Apache-2.0
