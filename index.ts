import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import { createApprovalExtension, decide, pendingApprovals, riskOf, type ApprovalRequest } from "./approval.ts";
import { guardInit } from "./config.ts";
import { publishGuards } from "./registry.ts";
import { createReviewExtension } from "./review.ts";
import { createTestsExtension } from "./tests.ts";

const CONFIRM_MS = 5 * 60 * 1000;
type Pending = { host: string; harness: Harness; request: ApprovalRequest };

/**
 * Pi extension. The main agent's risky bash calls ask for confirmation, and are blocked without a UI. Pi extensions
 * that run Durable workers (pi-teamwork, pi-swarm) find the worker guards on globalThis: an approval gate on every
 * worker, and review and tests after edits where a workflow asks for them. `/guards-approve` and `/guards-deny` answer
 * a worker's parked command in any of those harnesses, by `host:task` id.
 */
export default function (pi: ExtensionAPI) {
  const harnesses = new Map<string, Harness>();
  let ui: ExtensionContext["ui"] | undefined;
  const describe = ({ host, request }: Omit<Pending, "harness">) => `${host} worker waits for approval (${request.reason}): ${request.command}\n/guards-approve ${host}:${request.taskId} or /guards-deny ${host}:${request.taskId}`;
  const pending = async () => {
    const all: Pending[] = [];
    for (const [host, harness] of harnesses) for (const request of await pendingApprovals(harness).catch(() => [])) all.push({ host, harness, request });
    return all;
  };
  const announce = async () => { for (const item of await pending()) ui?.notify(describe(item), "warning"); };
  // Tell the person at once, since the main agent may be mid-run.
  const notifier = (host: string) => (request: ApprovalRequest) => ui?.notify(describe({ host, request }), "warning");
  const review = createReviewExtension(), tests = createTestsExtension();
  const byHost = new Map<string, Extension[]>();

  publishGuards({
    version: 1,
    extensions: (host) => byHost.get(host) ?? byHost.set(host, [createApprovalExtension(notifier(host)), review, tests]).get(host)!,
    init: (config) => config.review || config.testCommand?.trim() ? guardInit(config) : undefined,
    opened: (host, harness) => { if (harnesses.get(host) === harness) return; harnesses.set(host, harness); void announce().catch(() => {}); },
    closed: (host) => { harnesses.delete(host); },
  });

  pi.on("session_start", (_event, ctx) => { ui = ctx.hasUI ? ctx.ui : undefined; });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const reason = riskOf(command);
    if (!reason) return undefined;
    if (!ctx.hasUI) return { block: true, reason: `Blocked without a UI to confirm (${reason}).` };
    const ok = await ctx.ui.confirm(`Allow ${reason}?`, command, { timeout: CONFIRM_MS });
    return ok ? undefined : { block: true, reason: `The user did not allow this command (${reason}).` };
  });

  const answer = (allow: boolean) => async (args: string, ctx: ExtensionContext) => {
    const all = await pending();
    const id = args.trim();
    const chosen = id ? all.find((item) => `${item.host}:${item.request.taskId}` === id) : all.length === 1 ? all[0] : undefined;
    if (!chosen) {
      ctx.ui.notify(all.length ? all.map(describe).join("\n") : "No pending approvals.", all.length ? "warning" : "info");
      return;
    }
    const result = await decide(chosen.harness, chosen.request, allow);
    ctx.ui.notify(`${allow ? "Allowed" : "Denied"} ${chosen.host}:${chosen.request.taskId}: ${result}.`, result === "delivered" ? "info" : "warning");
  };
  pi.registerCommand("guards-approve", { description: "Allow a worker's parked command: [host:task]", handler: answer(true) });
  pi.registerCommand("guards-deny", { description: "Deny a worker's parked command: [host:task]", handler: answer(false) });
}
