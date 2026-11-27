import { createHash } from "node:crypto";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineSignal, hook, ToolTask, type Extension, type Harness, type SignalResult, type TaskId } from "@earendil-works/pi-durable";
import { riskOf } from "./risk.ts";

export type ApprovalRequest = { taskId: number; conversationId: number; key: string; command: string; reason: string; until: number };
export const ApprovalDecision = defineSignal({ name: "guards.approval", version: 1, schema: Type.Object({ allow: Type.Boolean(), note: Type.Optional(Type.String()) }) });
const REQUEST_MEMO = "guards.approval.request.";
const WAIT_MS = 60 * 60 * 1000;

/**
 * Parks a worker's risky bash call until a person allows or denies it, or an hour passes. The call holds no process
 * while it waits and survives a restart; the request lives in the call's own memo, so `pendingApprovals()` finds it
 * after a restart too. `notify` hears about each request once per process that asks.
 */
export function createApprovalExtension(notify: (request: ApprovalRequest) => void): Extension {
  return defineExtension({
    name: "guards.approval",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (call.name !== "bash") return undefined;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          const reason = riskOf(command);
          if (!reason) return undefined;
          const key = createHash("sha256").update(command).digest("hex").slice(0, 32);
          const decision = await api.readSignal(ApprovalDecision, key, context);
          if (decision?.kind === "value") return decision.value.allow ? undefined : { block: `A person denied this command${decision.value.note ? `: ${decision.value.note}` : "."} Do not run it again unchanged.` };
          if (decision?.kind === "expired") return { block: "No approval within an hour." };
          const asked = await api.memo<ApprovalRequest>(`${REQUEST_MEMO}${key}`, context);
          const request = asked ?? await api.memo<ApprovalRequest>(`${REQUEST_MEMO}${key}`, { taskId: api.taskId, conversationId: api.conversationId, key, command, reason, until: api.now() + WAIT_MS }, context);
          if (!asked) notify(request);
          return { sleep: { signals: [ApprovalDecision.key(key)], until: request.until } };
        },
      }),
    ],
  });
}

/** Calls parked on an approval, oldest first. */
export async function pendingApprovals(harness: Harness): Promise<ApprovalRequest[]> {
  const pending: ApprovalRequest[] = [];
  for (const { record: task } of (await harness.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (task.kind !== ToolTask.definition.name || task.state.status !== "sleeping") continue;
    for (const wait of task.state.signals ?? []) {
      const request = wait.signal === ApprovalDecision.name ? task.memos?.[`${REQUEST_MEMO}${wait.key}`] : undefined;
      if (request) pending.push(request as ApprovalRequest);
    }
  }
  return pending;
}

export function decide(harness: Harness, request: Pick<ApprovalRequest, "taskId" | "key">, allow: boolean, note?: string): Promise<SignalResult> {
  return harness.signal(request.taskId as TaskId, ApprovalDecision, request.key, note ? { allow, note } : { allow }, BACKGROUND_CONTEXT);
}
