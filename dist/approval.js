import { createHash } from "node:crypto";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineSignal, hook, ToolTask,                                                              } from "@earendil-works/pi-durable";

                                                                                                                                      
export const ApprovalDecision = defineSignal({ name: "guards.approval", version: 1, schema: Type.Object({ allow: Type.Boolean() }) });
const REQUEST_MEMO = "guards.approval.request.";
const WAIT_MS = 60 * 60 * 1000;

const RISKY                              = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, "recursive or forced rm"],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|rebase)\b/i, "history-changing git command"],
  [/\b(sudo|doas)\b/, "privilege escalation"],
  [/\b(mkfs|dd\s+if=|shutdown|reboot)\b/, "disk or system command"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bgh\s+(release|pr\s+merge|repo\s+delete)\b/i, "publishing or remote change"],
  [/\b(chmod|chown)\s+-R\b/, "recursive permission change"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, "piping a download into a shell"],
  [/\b(kill|pkill|killall)\b/, "killing processes"],
];

/** Why `command` needs a person's approval, or undefined when it does not. */
export function riskOf(command        )                     {
  return RISKY.find(([pattern]) => pattern.test(command))?.[1];
}

/**
 * Parks a worker's risky bash call until a person allows or denies it, or an hour passes. The call holds no process
 * while it waits and survives a restart; the request lives in the call's own memo, so `pendingApprovals()` finds it
 * after a restart too. `notify` hears about each request once per process that asks.
 */
export function createApprovalExtension(notify                                    )            {
  return defineExtension({
    name: "guards.approval",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (call.name !== "bash") return undefined;
          const command = String((call.arguments                         ).command ?? "");
          const reason = riskOf(command);
          if (!reason) return undefined;
          const key = createHash("sha256").update(command).digest("hex").slice(0, 32);
          const decision = await api.readSignal(ApprovalDecision, key, context);
          if (decision?.kind === "value") return decision.value.allow ? undefined : { block: "A person denied this command." };
          if (decision?.kind === "expired") return { block: "No approval within an hour." };
          const asked = await api.memo                 (`${REQUEST_MEMO}${key}`, context);
          const request = asked ?? await api.memo                 (`${REQUEST_MEMO}${key}`, { taskId: api.taskId, conversationId: api.conversationId, key, command, reason, until: api.now() + WAIT_MS }, context);
          if (!asked) notify(request);
          return { sleep: { signals: [ApprovalDecision.key(key)], until: request.until } };
        },
      }),
    ],
  });
}

/** Calls parked on an approval, oldest first. */
export async function pendingApprovals(harness         )                             {
  const pending                    = [];
  for (const { record: task } of (await harness.inspect(BACKGROUND_CONTEXT)).tasks) {
    if (task.kind !== ToolTask.definition.name || task.state.status !== "sleeping") continue;
    for (const wait of task.state.signals ?? []) {
      const request = wait.signal === ApprovalDecision.name ? task.memos?.[`${REQUEST_MEMO}${wait.key}`] : undefined;
      if (request) pending.push(request                   );
    }
  }
  return pending;
}

export function decide(harness         , request                                         , allow         )                        {
  return harness.signal(request.taskId          , ApprovalDecision, request.key, { allow }, BACKGROUND_CONTEXT);
}
