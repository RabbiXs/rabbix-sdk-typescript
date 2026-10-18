// Sample refund agent. Run: RABBIX_API_KEY=rbx_test_... RABBIX_BASE_URL=http://localhost:5021 node examples/refund-agent.ts
// It proposes three refunds of different sizes; which route each one gets is decided by your organization's policies
// (the development seed: amount > 500 needs a human approval, amount > 10000 is handed off to a human).
import { HandedOff, RabbiX, Rejected } from "../src/index.ts";

const apiKey = process.env.RABBIX_API_KEY;
if (!apiKey) {
  console.error("Set RABBIX_API_KEY (and RABBIX_BASE_URL for a local platform).");
  process.exit(1);
}

const rbx = new RabbiX({ apiKey, baseUrl: process.env.RABBIX_BASE_URL });
const session = await rbx.startSession({
  agent: "refund-agent",
  goal: "Process today's refund requests for customer C-4411",
  metadata: { ticket: "T-1" },
});
console.log(`session ${session.sessionId}`);

for (const [orderId, amount] of [
  ["O-9012", 100],
  ["O-9013", 1800],
  ["O-9014", 25000],
] as const) {
  // ... the agent works freely here: lookups, reasoning ...
  try {
    const decision = await session.propose({
      action: "refunds.issue",
      proposal: { customer_id: "C-4411", order_id: orderId, amount, currency: "USD" },
      reasoning: "Item arrived damaged; customer has no previous refunds.",
      evidence: { "customer.refund_count": 0, "ticket.attachments": ["damage.jpg"] },
      tags: ["support"],
      // Non-blocking: a refund that needs a human approval comes back as `pending`.
      waitForApproval: false,
    });

    if (!decision.approved) {
      console.log(
        `${amount} USD: ${decision.status}, awaiting a human (route ${decision.route}, action ${decision.actionId}); ` +
          "resume later with rbx.getDecision(actionId, { wait: true })",
      );
      continue;
    }

    const refundId = `R-${orderId}`; // the commit: payments.refund(...) in a real agent
    const result = await decision.report({ success: true, output: { refund_id: refundId } });
    console.log(
      `${amount} USD: ${decision.route}${decision.degraded ? " (degraded)" : ""}, refunded ${refundId}, action ${result.status}`,
    );
  } catch (error) {
    if (error instanceof HandedOff) {
      console.log(
        `${amount} USD: handed off to a human (action ${error.actionId}, handoff ${error.handoffId}); not committed`,
      );
    } else if (error instanceof Rejected) {
      console.log(`${amount} USD: rejected (${error.message}); not committed`);
    } else {
      throw error;
    }
  }
}

const ended = await session.end({ status: "completed", summary: "Processed 3 refund requests" });
console.log(`session ${ended.status}`);
