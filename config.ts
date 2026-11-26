import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";

export type GuardConfig = { review?: boolean; testCommand?: string };
/** Per-conversation guard choices, written when the host creates the worker. */
export const Guards = defineDoc<GuardConfig & Record<string, JsonValue>>({ kind: "guards.config", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}), checkpointWhen: () => false });

/** `init` for `createConversation()`: stores the worker's guard choices in its creating commit. */
export function guardInit(config: GuardConfig) {
  return async (tx: Tx, conversationId: ConversationId) => {
    const doc = await tx.doc(Guards, conversationId);
    if (config.review) doc.review = true;
    if (config.testCommand?.trim()) doc.testCommand = config.testCommand.trim();
  };
}
