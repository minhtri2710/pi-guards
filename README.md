# pi-guards

A Pi extension with durable guards, built on `pi-durable` hooks.

```sh
cd ~/Work/pi-guards && npm install --legacy-peer-deps
pi install ~/Work/pi-guards
```

- **Risky commands.** A pattern counts only where a command runs (`rm -rf`, `git push`, `git rebase`, `sudo`, `npm publish`, `curl | sh`, `kill`, ...), so the same words in a quote, a commit message or a heredoc pass. `rm -r` under the temp directory and `git branch -d` are not flagged.
- **Auto mode.** With TypeSafe credentials (`TYPESAFE_API_KEY`), Jev judges each flagged command first; one it finds routine (allow probability at least 0.6) runs without asking, for the main agent and for workers. Pushes, publishing, privilege escalation, system commands and `curl | sh` always ask. Without credentials, or when Jev fails, everything flagged asks.
- **Main agent.** A flagged `bash` call Jev did not clear asks: allow, deny this time, or deny for the rest of the session; the model is told which. It waits up to five minutes. Without a UI (print or RPC mode) it is blocked.
- **Worker approval gate.** With `pi-teamwork` or `pi-swarm` installed too, every worker's risky `bash` call parks before it runs. A widget lists the parked calls until they are answered. Answer one with `/guards-approve [host:task]` or `/guards-deny [host:task] [reason]`, for example `teamwork:12`; with one pending request the id may be left out. A call nobody answers within an hour is blocked. The call holds no process while it waits and survives a restart.
- **Review.** A workflow or worker started with `review: true` gets a reviewer conversation that reads the worker's transcript before its answer stands. `REVISE` sends the worker back with the feedback, at most twice in a row.
- **Tests after edits.** With a `testCommand`, a run that edited or wrote files runs the command in the worker's directory. A failure sends the worker back with the output's tail, at most twice in a row.

The packages do not import each other. This extension publishes its worker guards on `globalThis` (`Symbol.for("pi-guards.host")`, contract in `registry.ts`); `pi-teamwork` and `pi-swarm` read them when they open their Durable harness. Install or remove it, then restart Pi.
