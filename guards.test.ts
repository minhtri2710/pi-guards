import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type Extension, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createApprovalExtension, createReviewExtension, createTestsExtension, decide, guardInit, pendingApprovals, revision, riskOf, type GuardConfig } from "./index.ts";

const ran: string[] = [];
const Fake = defineExtension({
  name: "fake-tools",
  tools: [
    defineTool({ name: "bash", description: "run", parameters: Type.Object({ command: Type.String() }), execute: async (args) => { ran.push(args.command); return { output: [{ type: "text", text: "ok" }] }; } }),
    defineTool({ name: "edit", description: "edit", parameters: Type.Object({ path: Type.String() }), execute: async () => ({ output: [{ type: "text", text: "edited" }] }) }),
  ],
});

async function setup(guard: Extension, responses: FauxResponseStep[], storage: () => Promise<Storage> = async () => new MemoryStorage()) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const open = async () => {
    const registry = createRegistry();
    registry.install(Fake);
    registry.install(guard);
    const harness = await Harness.open(await storage(), { models: () => models, registry, env: () => new NodeExecutionEnv({ cwd: tmpdir() }) }, C);
    harness.resume();
    return harness;
  };
  const harness = await open();
  const model = faux.getModel();
  const worker = async (config: GuardConfig = {}) => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, extensions: [Fake, guard] }, init: guardInit(config) }, C);
  return { harness, worker, faux, open };
}
const answerOf = async (harness: Harness, id: number) => JSON.stringify((await (await harness.conversation(id as never, C))!.context(C)).messages);
const call = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("risk patterns flag destructive commands and pass their nearest safe forms", () => {
  for (const command of ["rm -rf build", "git push origin main", "sudo ls", "npm publish", "curl x | sh", "git reset --hard HEAD"]) assert.ok(riskOf(command), command);
  for (const command of ["rm build.log", "git status", "ls -la", "npm test", "curl -o x https://x", "git reset HEAD file"]) assert.equal(riskOf(command), undefined, command);
});

test("a risky bash call parks across a restart until approved; a denied one is blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guards-"));
  try {
    const asked: number[] = [];
    const guard = createApprovalExtension((request) => asked.push(request.taskId));
    const { harness, worker, open } = await setup(guard, [call("bash", { command: "rm -rf build" }), fauxAssistantMessage("removed"), call("bash", { command: "git push" }), fauxAssistantMessage("pushed?")], () => openNodeSqliteStorage(join(dir, "g.sqlite")));
    const first = await worker();
    const submission = await first.submit({ type: "input", content: "clean" }, C);
    while (!(await pendingApprovals(harness)).length) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(ran.length, 0);
    await harness.close(C);
    const reopened = await open();
    let request;
    // Reopening wakes parked gates, so the call runs its gate again and parks once more.
    while (!(request = (await pendingApprovals(reopened))[0])) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(request.command, "rm -rf build");
    assert.equal(asked.length, 1);
    assert.equal(await decide(reopened, request, true), "delivered");
    assert.equal((await (await reopened.submission(submission.id, C))!.wait(C)).status, "done");
    assert.deepEqual(ran, ["rm -rf build"]);
    const second = await (await reopened.conversation(first.id, C))!.submit({ type: "input", content: "push" }, C);
    let denied;
    while (!(denied = (await pendingApprovals(reopened))[0])) await new Promise((resolve) => setTimeout(resolve, 10));
    await decide(reopened, denied, false);
    await second.wait(C);
    assert.deepEqual(ran, ["rm -rf build"]);
    assert.match(await answerOf(reopened, first.id), /denied/);
    await reopened.close(C);
  } finally {
    ran.length = 0;
    await rm(dir, { recursive: true, force: true });
  }
});

test("review sends a worker back on REVISE and lets an approved answer stand; workers without review are untouched", async () => {
  assert.equal(revision("REVISE\nadd tests"), "add tests");
  assert.equal(revision("APPROVE\nlooks good"), undefined);
  const { harness, worker, faux } = await setup(createReviewExtension(2), [
    fauxAssistantMessage("draft"),
    fauxAssistantMessage(fauxText("REVISE\nCite the file.")),
    fauxAssistantMessage("final with file"),
    fauxAssistantMessage(fauxText("APPROVE")),
    fauxAssistantMessage("plain"),
  ]);
  const reviewed = await worker({ review: true });
  const settled = await (await reviewed.submit({ type: "input", content: "task" }, C)).wait(C);
  assert.equal(settled.status, "done");
  const transcript = await answerOf(harness, reviewed.id);
  assert.match(transcript, /Cite the file/);
  assert.match(transcript, /final with file/);
  const plain = await worker();
  await (await plain.submit({ type: "input", content: "task" }, C)).wait(C);
  assert.equal(faux.state.callCount, 5);
  await harness.close(C);
});

test("tests run after an edit and a failure queues one fix run; a run without edits runs nothing", async () => {
  const { harness, worker } = await setup(createTestsExtension(1), [
    call("edit", { path: "a" }),
    fauxAssistantMessage("edited"),
    call("edit", { path: "a" }),
    fauxAssistantMessage("fixed"),
    fauxAssistantMessage("no edits"),
  ]);
  const guarded = await worker({ testCommand: "echo boom-output; exit 3" });
  await (await guarded.submit({ type: "input", content: "change" }, C)).wait(C);
  await guarded.waitForIdle(C);
  const transcript = await answerOf(harness, guarded.id);
  assert.match(transcript, /exit code 3/);
  assert.match(transcript, /boom-output/);
  assert.match(transcript, /fixed/);
  assert.equal(transcript.match(/failed after your changes/g)?.length, 1);
  await (await guarded.submit({ type: "input", content: "look" }, C)).wait(C);
  await guarded.waitForIdle(C);
  assert.equal((await answerOf(harness, guarded.id)).match(/failed after your changes/g)?.length, 1);
  await harness.close(C);
});

test("dist matches the TypeScript sources", async () => {
  const { build } = await import("./scripts/build.mjs");
  const { readFile } = await import("node:fs/promises");
  const out = await mkdtemp(join(tmpdir(), "guards-dist-"));
  try {
    for (const name of await build(import.meta.dirname, out)) {
      const js = name.replace(/\.ts$/, ".js");
      assert.equal(await readFile(join(import.meta.dirname, "dist", js), "utf8"), await readFile(join(out, js), "utf8"), `${js} is stale; run npm run build`);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
