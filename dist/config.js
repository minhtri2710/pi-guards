                                                            
import { defineDoc,                              } from "@earendil-works/pi-durable";

                                                                     
/** Per-conversation guard choices, written when the host creates the worker. */
export const Guards = defineDoc                                         ({ kind: "guards.config", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({}), checkpointWhen: () => false });

/** `init` for `createConversation()`: stores the worker's guard choices in its creating commit. */
export function guardInit(config             ) {
  return async (tx    , conversationId                ) => {
    const doc = await tx.doc(Guards, conversationId);
    if (config.review) doc.review = true;
    if (config.testCommand?.trim()) doc.testCommand = config.testCommand.trim();
  };
}
