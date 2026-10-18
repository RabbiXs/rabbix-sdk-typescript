import { isDeepStrictEqual } from "node:util";

/** One request/response pair, as in the conformance fixtures. */
export interface Exchange {
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; body?: unknown } | { network_error: true };
}

export const MOCK_BASE_URL = "http://rabbix.mock";

/**
 * A `fetch` that answers from a queue of expected exchanges, applying the conformance matching rules:
 * exact method/path, header values exact / `"*"` / `"$capture:<name>"`, JSON subset match on the body.
 * Mismatches are collected in `failures` (the SDK would treat a thrown error as a network error and retry).
 */
export class MockTransport {
  readonly failures: string[] = [];
  readonly captures = new Map<string, string>();
  readonly requests: { method: string; path: string; headers: Headers; body: unknown }[] = [];
  #queue: Exchange[] = [];

  expect(exchanges: Exchange[]): void {
    this.#queue = [...exchanges];
  }

  get remaining(): number {
    return this.#queue.length;
  }

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method ?? "GET";
    const path = url.startsWith(MOCK_BASE_URL) ? url.slice(MOCK_BASE_URL.length) : url;
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    this.requests.push({ method, path, headers, body });

    const exchange = this.#queue.shift();
    if (!exchange) {
      this.failures.push(`unexpected extra request ${method} ${path}`);
      throw new TypeError("fetch failed (no exchange left)");
    }
    const where = `${exchange.request.method} ${exchange.request.path}`;
    if (method !== exchange.request.method || path !== exchange.request.path)
      this.failures.push(`expected ${where}, got ${method} ${path}`);
    for (const [name, expected] of Object.entries(exchange.request.headers ?? {})) {
      const actual = headers.get(name);
      if (expected === "*") {
        if (!actual) this.failures.push(`${where}: header ${name} missing or empty`);
      } else if (expected.startsWith("$capture:")) {
        const key = expected.slice("$capture:".length);
        if (!actual) this.failures.push(`${where}: header ${name} missing (capture ${key})`);
        else if (!this.captures.has(key)) this.captures.set(key, actual);
        else if (this.captures.get(key) !== actual)
          this.failures.push(
            `${where}: header ${name} = ${actual}, captured ${this.captures.get(key)}`,
          );
      } else if (actual !== expected) {
        this.failures.push(`${where}: header ${name} = ${actual}, expected ${expected}`);
      }
    }
    if (exchange.request.body !== undefined)
      this.failures.push(...subsetMismatches(exchange.request.body, body, `${where} body`));

    if ("network_error" in exchange.response)
      throw new TypeError("fetch failed (simulated network error)");
    return new Response(JSON.stringify(exchange.response.body ?? null), {
      status: exchange.response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** JSON subset match: objects recursively (extra keys allowed), arrays and scalars exactly. */
export function subsetMismatches(expected: unknown, actual: unknown, path = "$"): string[] {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual))
      return [`${path}: expected an object, got ${JSON.stringify(actual)}`];
    return Object.entries(expected).flatMap(([key, value]) =>
      key in actual
        ? subsetMismatches(value, (actual as Record<string, unknown>)[key], `${path}.${key}`)
        : [`${path}.${key}: missing`],
    );
  }
  return isDeepStrictEqual(expected, actual)
    ? []
    : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}
