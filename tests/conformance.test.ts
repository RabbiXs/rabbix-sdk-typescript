// Runs every fixture in conformance/ (vendored from rabbix-platform) against the SDK; see conformance/README.md.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vite-plus/test";
import { RabbiX, RabbiXError, type Session } from "../src/index.ts";
import { type Exchange, MOCK_BASE_URL, MockTransport, subsetMismatches } from "./mock-transport.ts";

interface FixtureCall {
  call: "start_session" | "end_session" | "propose" | "get_decision" | "report";
  args: Record<string, any>;
  exchanges: Exchange[];
  expect: { result?: Record<string, unknown>; error?: string; fields?: Record<string, unknown> };
}

interface Fixture {
  name: string;
  description: string;
  calls: FixtureCall[];
}

const dir = fileURLToPath(new URL("../conformance/", import.meta.url));
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".json"))
  .sort();

test("all 12 conformance fixtures are vendored", () => {
  expect(files).toHaveLength(12);
});

test.each(files)("conformance %s", async (file) => {
  const fixture = JSON.parse(readFileSync(dir + file, "utf8")) as Fixture;
  const transport = new MockTransport();
  const rbx = new RabbiX({
    apiKey: "rbx_test_conformance",
    baseUrl: MOCK_BASE_URL,
    fetch: transport.fetch,
    retryBackoffMs: 0,
  });
  let session: Session | undefined;

  for (const [index, call] of fixture.calls.entries()) {
    const label = `${fixture.name} call #${index + 1} (${call.call})`;
    transport.expect(call.exchanges);

    let result: unknown;
    let error: unknown;
    try {
      result = await invoke(call);
    } catch (caught) {
      error = caught;
    }

    expect(transport.failures, `${label}: request mismatches`).toEqual([]);
    expect(transport.remaining, `${label}: unconsumed exchanges`).toBe(0);
    if (call.expect.error !== undefined) {
      expect(error, `${label}: expected error ${call.expect.error}`).toBeInstanceOf(RabbiXError);
      expect((error as RabbiXError).kind, label).toBe(call.expect.error);
      expect(subsetMismatches(call.expect.fields ?? {}, toSnake(error), "error"), label).toEqual(
        [],
      );
    } else {
      if (error !== undefined) throw new Error(`${label}: unexpected error`, { cause: error });
      expect(subsetMismatches(call.expect.result ?? {}, toSnake(result), "result"), label).toEqual(
        [],
      );
    }
  }

  async function invoke(call: FixtureCall): Promise<unknown> {
    const a = call.args;
    switch (call.call) {
      case "start_session":
        session = await rbx.startSession({ goal: a.goal, agent: a.agent, metadata: a.metadata });
        return session;
      case "end_session":
        return requireSession().end({ status: a.status, summary: a.summary });
      case "propose":
        return requireSession().propose({
          action: a.action,
          proposal: a.proposal,
          reasoning: a.reasoning,
          evidence: a.evidence,
          tags: a.tags,
          callbackUrl: a.callback_url,
          waitForApproval: a.wait_for_approval,
        });
      case "get_decision":
        return rbx.getDecision(a.action_id, { wait: a.wait });
      case "report":
        return rbx.report(a.action_id, { success: a.success, output: a.output, error: a.error });
    }
  }

  function requireSession(): Session {
    if (!session) throw new Error(`${fixture.name}: no start_session before this call`);
    return session;
  }
});

/** Own enumerable properties with camelCase keys mapped to the fixtures' snake_case names. */
function toSnake(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value ?? {}))
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = field;
  return out;
}
