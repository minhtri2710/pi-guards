# pi-guards

A Pi extension with durable guards, built on `pi-durable` hooks.

```sh
cd ~/Work/pi-guards && npm install --legacy-peer-deps
pi install ~/Work/pi-guards
```

- **Main agent.** A `bash` call that matches a risky pattern (`rm -rf`, `git push`, `sudo`, `npm publish`, `curl | sh`, `kill`, ...) asks for confirmation, for up to five minutes. Without a UI (print or RPC mode) it is blocked.
- **Worker approval gate.** With `pi-teamwork` or `pi-swarm` installed too, every worker's risky `bash` call parks before it runs. Answer it with `/guards-approve [host:task]` or `/guards-deny [host:task]`, for example `teamwork:12`; with one pending request the id may be left out. A call nobody answers within an hour is blocked. The call holds no process while it waits and survives a restart.
- **Review.** A workflow or worker started with `review: true` gets a reviewer conversation that reads the worker's transcript before its answer stands. `REVISE` sends the worker back with the feedback, at most twice in a row.
- **Tests after edits.** With a `testCommand`, a run that edited or wrote files runs the command in the worker's directory. A failure sends the worker back with the output's tail, at most twice in a row.

The packages do not import each other. This extension publishes its worker guards on `globalThis` (`Symbol.for("pi-guards.host")`, contract in `registry.ts`); `pi-teamwork` and `pi-swarm` read them when they open their Durable harness. Install or remove it, then restart Pi.
