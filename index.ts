import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import { createApprovalExtension, decide, pendingApprovals, type ApprovalRequest } from "./approval.ts";
import { guardInit } from "./config.ts";
import { publishGuards } from "./registry.ts";
import { riskOf } from "./risk.ts";
import { createReviewExtension } from "./review.ts";
import { createTestsExtension } from "./tests.ts";

const CONFIRM_MS = 5 * 60 * 1000;
const REFRESH_MS = 15 * 1000;
const ALLOW = "Allow", DENY_ONCE = "Deny this time", DENY_SESSION = "Deny for this session";
type Pending = { host: string; harness: Harness; request: ApprovalRequest };

/**
 * Pi extension. The main agent's risky bash calls ask for confirmation, and are blocked without a UI. Pi extensions
 * that run Durable workers (pi-teamwork, pi-swarm) find the worker guards on globalThis: an approval gate on every
 * worker, and review and tests after edits where a workflow asks for them. `/guards-approve` and `/guards-deny` answer
 * a worker's parked command in any of those harnesses, by `host:task` id; a widget lists them until they are answered.
 */
export default function (pi: ExtensionAPI) {
  const harnesses = new Map<string, Harness>();
  // Exact commands the user denied for the rest of this session; the main agent is told not to retry them.
  const deniedForSession = new Set<string>();
  let ui: ExtensionContext["ui"] | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const id = ({ host, request }: Omit<Pending, "harness">) => `${host}:${request.taskId}`;
  const describe = (item: Omit<Pending, "harness">) => `${item.host} worker waits for approval (${item.request.reason}): ${item.request.command}\n/guards-approve ${id(item)} or /guards-deny ${id(item)} [reason]`;
  const pending = async () => {
    const all: Pending[] = [];
    for (const [host, harness] of harnesses) for (const request of await pendingApprovals(harness).catch(() => [])) all.push({ host, harness, request });
    return all;
  };
  // A widget, not a one-off notice: a parked worker stays visible until someone answers it, it expires, or it is cancelled.
  const refresh = async () => {
    const all = await pending();
    ui?.setWidget("guards-pending", all.length ? [`Workers waiting for approval: ${all.length}`, ...all.map((item) => `  ${id(item)} (${item.request.reason}): ${item.request.command.replace(/\s+/g, " ").slice(0, 120)}`), "  /guards-approve [host:task] · /guards-deny [host:task] [reason]"] : undefined);
    if (all.length && !timer) { timer = setInterval(() => void refresh().catch(() => {}), REFRESH_MS); timer.unref?.(); }
    else if (!all.length && timer) { clearInterval(timer); timer = undefined; }
    return all;
  };
  const announce = async () => { for (const item of await refresh()) ui?.notify(describe(item), "warning"); };
  const notifier = (host: string) => (request: ApprovalRequest) => { ui?.notify(describe({ host, request }), "warning"); void refresh().catch(() => {}); };
  const review = createReviewExtension(), tests = createTestsExtension();
  const byHost = new Map<string, Extension[]>();

  publishGuards({
    version: 1,
    extensions: (host) => byHost.get(host) ?? byHost.set(host, [createApprovalExtension(notifier(host)), review, tests]).get(host)!,
    init: (config) => config.review || config.testCommand?.trim() ? guardInit(config) : undefined,
    opened: (host, harness) => { if (harnesses.get(host) === harness) return; harnesses.set(host, harness); void announce().catch(() => {}); },
    closed: (host) => { harnesses.delete(host); void refresh().catch(() => {}); },
    pending: async (host) => (await pending()).filter((item) => item.host === host).map(({ request }) => ({ taskId: request.taskId, conversationId: request.conversationId, command: request.command, reason: request.reason })),
  });

  pi.on("session_start", (_event, ctx) => { ui = ctx.hasUI ? ctx.ui : undefined; deniedForSession.clear(); void announce().catch(() => {}); });
  pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String((event.input as { command?: unknown }).command ?? "");
    const reason = riskOf(command);
    if (!reason) return undefined;
    if (deniedForSession.has(command)) return { block: true, reason: `The user denied this exact command for the rest of this session (${reason}). Do not retry it; ask the user how to proceed.` };
    if (!ctx.hasUI) return { block: true, reason: `Blocked without a UI to confirm (${reason}).` };
    const choice = await ctx.ui.select(`Allow ${reason}?\n${command}`, [ALLOW, DENY_ONCE, DENY_SESSION], { timeout: CONFIRM_MS, blockedKind: "permission" });
    if (choice === ALLOW) return undefined;
    if (choice === DENY_SESSION) {
      deniedForSession.add(command);
      return { block: true, reason: `The user denied this command for the rest of this session (${reason}). Do not retry it; ask the user how to proceed.` };
    }
    return { block: true, reason: `The user did not allow this command now (${reason}). It may be allowed later; ask before retrying it.` };
  });

  const answer = (allow: boolean) => async (args: string, ctx: ExtensionContext) => {
    const all = await pending();
    const [first = "", ...rest] = args.trim().split(/\s+/);
    const named = all.find((item) => id(item) === first);
    const chosen = named ?? (all.length === 1 && !/^\w+:\d+$/.test(first) ? all[0] : undefined);
    if (!chosen) {
      ctx.ui.notify(all.length ? all.map(describe).join("\n") : "No pending approvals.", all.length ? "warning" : "info");
      return;
    }
    const note = (named ? rest : [first, ...rest]).join(" ").trim();
    const result = await decide(chosen.harness, chosen.request, allow, allow ? undefined : note || undefined);
    await refresh();
    ctx.ui.notify(`${allow ? "Allowed" : "Denied"} ${id(chosen)}: ${result}.`, result === "delivered" ? "info" : "warning");
  };
  pi.registerCommand("guards-approve", { description: "Allow a worker's parked command: [host:task]", handler: answer(true) });
  pi.registerCommand("guards-deny", { description: "Deny a worker's parked command, telling it why: [host:task] [reason]", handler: answer(false) });
}
