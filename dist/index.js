                                                                                      
                                                          
import { createApprovalExtension, decide, pendingApprovals,                      } from "./approval.js";
import { createReviewExtension } from "./review.js";
import { createTestsExtension } from "./tests.js";

export { ApprovalDecision, createApprovalExtension, decide, pendingApprovals, riskOf,                      } from "./approval.js";
export { guardInit, Guards,                  } from "./config.js";
export { createReviewExtension, revision } from "./review.js";
export { createTestsExtension } from "./tests.js";

const describe = (prefix        , request                 ) => `Worker ${request.conversationId} waits for approval (${request.reason}): ${request.command}\n/${prefix}-approve ${request.taskId} or /${prefix}-deny ${request.taskId}`;

/**
 * The three guards for one host extension, and `/<prefix>-approve` and `/<prefix>-deny` to answer parked approvals.
 * `harness()` returns the host's open Harness, or undefined before it opened. Install `extensions` in that Harness and
 * select them in every worker conversation; `guardInit()` turns review and tests on per worker. Call `announce()` once
 * the Harness resumed after a restart, since a gate asks only once.
 */
export function registerGuards(pi              , prefix        , harness                                                         ) {
  let ui                                    ;
  pi.on("session_start", (_event, ctx) => { ui = ctx.hasUI ? ctx.ui : undefined; });
  // A worker's gate fires while the main agent may be mid-run, so tell the person at once instead of queueing a message.
  const notify = (request                 ) => ui?.notify(describe(prefix, request), "warning");
  const announce = async (open         ) => { for (const request of await pendingApprovals(open)) notify(request); };
  const answer = (allow         ) => async (args        , ctx                  ) => {
    const open = await harness(ctx);
    const pending = open ? await pendingApprovals(open) : [];
    const id = Number(args.trim());
    const request = args.trim() ? pending.find((item) => item.taskId === id) : pending.length === 1 ? pending[0] : undefined;
    if (!open || !request) {
      ctx.ui.notify(pending.length ? pending.map((item) => describe(prefix, item)).join("\n") : "No pending approvals.", pending.length ? "warning" : "info");
      return;
    }
    const result = await decide(open, request, allow);
    ctx.ui.notify(`${allow ? "Allowed" : "Denied"} ${request.taskId}: ${result}.`, result === "delivered" ? "info" : "warning");
  };
  pi.registerCommand(`${prefix}-approve`, { description: "Allow a worker's parked command: [task id]", handler: answer(true) });
  pi.registerCommand(`${prefix}-deny`, { description: "Deny a worker's parked command: [task id]", handler: answer(false) });
  return { extensions: [createApprovalExtension(notify), createReviewExtension(), createTestsExtension()], announce };
}
