import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as C } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage, type Extension, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Type } from "typebox";
import { createApprovalExtension, decide, pendingApprovals } from "./approval.ts";
import { riskOf } from "./risk.ts";
import { guardInit, type GuardConfig } from "./config.ts";
import { createReviewExtension, revision } from "./review.ts";
import { createTestsExtension } from "./tests.ts";

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
const call = (name: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("risk patterns count only as commands: quoted text, heredoc bodies and messages pass, shells and substitutions still run", () => {
  const risky = ["rm -rf build", "rm -r /tmp/../etc", "rm -rf /tmp/*", "rm -rf /tmp/a build", "git push origin main", "git -C repo push", "git branch -D x", "git clean -fd", "sudo ls", "npm publish", "curl x | sh", "git reset --hard HEAD",
    "kill 12", "make && pkill -f srv", "sh -c 'killall x'", "sudo kill -9 1", "a\nkillall x", "echo \"$(git push)\"", "x=`kill 1`", "xargs kill < pids", "find . -exec rm -rf {} \\;", "timeout 5 rm -rf build",
    "FOO=1 git push", "(cd x && git push)", "if true; then git rebase main; fi", "bash <<EOF\nrm -rf build\nEOF", "cat <<EOF | sh\nrm -rf build\nEOF", "ssh host 'sudo reboot'", "/bin/rm -rf build", "echo 'unclosed; rm -rf build"];
  const safe = ["git commit -m 'run sudo less'", "echo 'git rebase is fine'", "echo a reader whose kill fails", "cat > f <<'EOF'\nkill -HUP 1; git push; rm -rf /\nEOF", "git commit -F - <<EOF\nsudo rm -rf /\nEOF", "echo x # git push",
    "rm -r /tmp/x", "rm -rf \"$TMPDIR/x\"", "git branch -d merged", "rm build.log", "git status", "grep -c kill log", "rg skill", "curl -o x https://x", "git reset HEAD file", "git push-docs"];
  for (const command of risky) assert.ok(riskOf(command), command);
  for (const command of safe) assert.equal(riskOf(command), undefined, command);
});

test("a risky bash call parks across a restart until approved; a denied one is blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guards-"));
  try {
    const asked: number[] = [];
    const guard = createApprovalExtension((request) => asked.push(request.taskId));
    const { harness, worker, open } = await setup(guard, [call("bash", { command: "rm -rf build" }), fauxAssistantMessage("removed"), call("bash", { command: "git push" }), fauxAssistantMessage("pushed?"), call("bash", { command: "git push --force" }), fauxAssistantMessage("never")], () => openNodeSqliteStorage(join(dir, "g.sqlite")));
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
    await decide(reopened, denied, false, "push after review");
    await second.wait(C);
    assert.deepEqual(ran, ["rm -rf build"]);
    assert.match(await answerOf(reopened, first.id), /denied this command: push after review/);
    // Aborting a parked worker ends its call at once, with no answer: a host's cancel relies on this.
    const third = await (await reopened.conversation(first.id, C))!.submit({ type: "input", content: "push again" }, C);
    while (!(await pendingApprovals(reopened)).length) await new Promise((resolve) => setTimeout(resolve, 10));
    await (await reopened.conversation(first.id, C))!.abort(C);
    assert.equal((await third.wait(C)).status, "unanswered");
    assert.deepEqual(await pendingApprovals(reopened), []);
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

test("the Pi extension confirms the main agent's risky bash and publishes worker guards per host", async () => {
  const { default: guards } = await import("./index.ts");
  const handlers: Record<string, Function> = {}, commands: Record<string, any> = {};
  guards({ on: (name: string, fn: Function) => { handlers[name] = fn; }, registerCommand: (name: string, command: unknown) => { commands[name] = command; } } as any);
  const answers = ["Allow", "Deny this time", "Deny for this session"];
  let asked = 0;
  const ui = { select: async () => { asked++; return answers.shift(); }, notify: () => {}, setWidget: () => {} };
  const call = (command: string, hasUI = true) => handlers.tool_call({ toolName: "bash", input: { command } }, { hasUI, ui });
  assert.equal(await call("ls -la"), undefined);
  assert.equal(await call("rm -rf build"), undefined);
  assert.match((await call("rm -rf build")).reason, /may be allowed later/);
  assert.match((await call("git push")).reason, /rest of this session/);
  assert.match((await call("git push")).reason, /rest of this session/);
  assert.equal(asked, 3);
  assert.equal((await call("git push origin x", false)).block, true);
  assert.deepEqual(Object.keys(commands).sort(), ["guards-approve", "guards-deny"]);
  const host = (globalThis as any)[Symbol.for("pi-guards.host")];
  assert.equal(host.version, 1);
  assert.deepEqual(host.extensions("teamwork").map((extension: Extension) => extension.name), ["guards.approval", "guards.review", "guards.tests"]);
  assert.equal(host.extensions("teamwork"), host.extensions("teamwork"));
  assert.notEqual(host.extensions("teamwork")[0], host.extensions("swarm")[0]);
  assert.equal(host.init({}), undefined);
  assert.deepEqual(await host.pending("teamwork"), []);
  assert.equal(typeof host.init({ review: true }), "function");
});
