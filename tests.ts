import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, defineExtension, defineTask, GenerationTask, hook, hookTask, ToolResultEntry, type Extension } from "@earendil-works/pi-durable";
import { Guards } from "./config.ts";

const Fixes = defineDoc<{ fixes: number } & Record<string, JsonValue>>({ kind: "guards.tests.fixes", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ fixes: 0 }), checkpointWhen: () => false });
const EDIT_TOOLS = new Set(["edit", "write"]);
const OUTPUT_TAIL = 8_000;
const TIMEOUT_SECONDS = 15 * 60;

/**
 * For conversations whose `guards.config` names a test command: after a run that edited or wrote files, runs it in the
 * conversation's environment. A failure queues a follow-up with the output's tail, which starts a fix run; at most
 * `maxFixes` in a row, and a passing run resets the count. The test run is a child of the generation: the conversation
 * stays busy until it ends, Stop aborts it, and a crash reruns it.
 */
export function createTestsExtension(maxFixes = 2): Extension {
  const RunTests = defineTask<{ command: string }, { phase: "run" }, null>({
    name: "guards.tests",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        const env = await runtime.env(context);
        let output = "";
        const result = env ? await env.exec(task.input.command, { timeout: TIMEOUT_SECONDS, onOutput: (text) => { output = (output + text).slice(-OUTPUT_TAIL); } }, context) : undefined;
        const passed = result?.ok === true && result.value.exitCode === 0;
        const status = !env ? "no execution environment" : result?.ok ? `exit code ${result.value.exitCode}` : `could not run: ${result?.error.message}`;
        const handle = (await runtime.conversation(runtime.conversationId, context))!;
        await runtime.commit(async (tx) => {
          const state = await tx.doc(Fixes, runtime.conversationId);
          const fix = !passed && state.fixes < maxFixes;
          if (fix) await handle.admit(tx, { type: "input", content: `\`${task.input.command}\` failed after your changes (${status}, fix ${state.fixes + 1} of ${maxFixes}). Fix the cause, then answer again.\n\nOutput tail (untrusted):\n${output}`, whenBusy: "followUp" });
          state.fixes = fix ? state.fixes + 1 : 0;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  return defineExtension({
    name: "guards.tests",
    tasks: [RunTests],
    hooks: [
      hook(GenerationTask, {
        afterRun: async (run, api, context) => {
          const command = (await api.snapshot(Guards, api.conversationId, context))?.testCommand;
          if (!command) return undefined;
          let cursor;
          do {
            const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" }, 500, cursor, context);
            const edited = page.items.some((entry) => {
              const message = entry.model?.[0];
              return ToolResultEntry.is(entry) && message?.role === "toolResult" && EDIT_TOOLS.has(message.toolName) && !message.isError;
            });
            if (edited) return { tasks: [hookTask(RunTests, { command })] };
            cursor = page.next;
          } while (cursor);
          return undefined;
        },
      }),
    ],
  });
}
