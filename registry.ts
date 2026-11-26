import type { Extension, Harness } from "@earendil-works/pi-durable";

/**
 * The contract between pi-worker-guards and the Pi extensions that run Durable workers, kept on globalThis so neither
 * package imports the other. A host reads it when it opens its Harness, installs `extensions(name)` there, selects them
 * in each worker's `extensions`, and passes `init(config)` to `createConversation()`. It calls `opened(name, harness)`
 * and `closed(name)` so the guards can list and answer parked approvals; `name` prefixes task ids, as in `teamwork:12`.
 */
export type GuardsHost = {
  readonly version: 1;
  /** The guards for one host's Harness; the names are the same for every host. */
  extensions(host: string): readonly Extension[];
  init(config: { review?: boolean; testCommand?: string }): ((tx: any, conversationId: any) => Promise<void>) | undefined;
  opened(host: string, harness: Harness): void;
  closed(host: string): void;
};

export const GUARDS_KEY = Symbol.for("pi-worker-guards.host");

export function publishGuards(host: GuardsHost) {
  (globalThis as Record<symbol, unknown>)[GUARDS_KEY] = host;
}
