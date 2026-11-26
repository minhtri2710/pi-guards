# pi-worker-guards

Durable guards for Pi worker conversations, built on `pi-durable` hooks. `pi-teamwork` and `pi-swarm` select them in every worker.

- **Approval gate.** A worker's `bash` call that matches a risky pattern (`rm -rf`, `git push`, `sudo`, `npm publish`, `curl | sh`, `kill`, ...) parks before it runs. Answer it with `/<host>-approve [task id]` or `/<host>-deny [task id]`; with one pending request the id may be left out. A call nobody answers within an hour is blocked. The call holds no process while it waits and survives a restart.
- **Review.** With `review` on, a reviewer conversation reads the worker's transcript before its answer stands. `REVISE` sends the worker back with the feedback, at most twice in a row.
- **Tests after edits.** With a `testCommand`, a run that edited or wrote files runs the command in the worker's directory. A failure sends the worker back with the output's tail, at most twice in a row.

Node does not strip TypeScript types under `node_modules`, so the package ships `dist/`, built by `npm run build` with Node's own type stripping. `npm test` checks that `dist/` matches the sources.
