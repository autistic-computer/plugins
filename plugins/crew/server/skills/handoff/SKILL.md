---
name: handoff
description: Hand an implementation task to another coding agent with write access to the repo, using crew spawn with mode handoff. Use only when the user asks Codex, Gemini, or agy by name to implement, fix, or build something.
---

# Handoff: delegate an implementation task

`spawn` with `mode: "handoff"`. The worker gets `workspace-write` access: it may create, edit, and delete files and run commands in the working directory.

## Access

- `network: true` (codex) keeps the filesystem sandbox and lets the worker reach the network. `workspace-write` blocks the network by default, so any task that has to hit a cloud API, a database, or a tunnel needs it. Without it those commands fail and the worker reports back a useless "unsure".
- `access: "full"` removes the sandbox. Use it only when the user asks. Prefer `network: true` when the task just needs to reach something.
- With `resume`, access is taken from this call, not from the earlier run. Pass `network` or `access` again if you still want them.
- agy has no filesystem sandbox at any write level. Give it write tasks only in a tree you can reset.

## What to send

The worker cannot see this conversation. The task has to stand alone: the files to touch, the behavior or contract to satisfy, what must not change, and the gates to run as exact commands.

- Spec the contract, not the literal. A spec'd literal (a hard-coded key, a pasted SQL string) gets implemented literally even when a generic path is simpler. Describe the outcome and let the worker pick the shape.
- Check that every file, symbol, table, or migration the task names still exists before you send. The worker is told to stop on a mismatch, but a stale spec still burns the run.
- Boot whatever the gates need first (database, cache, env vars) and say so in the task. A gate whose service is missing comes back BLOCKED and the round has to be repeated.
- Send fix rounds as a fresh job carrying the complete fix list, not `resume`. A fresh run reads the list cold; a resumed one reasons from the spec that produced the bugs.

The mode appends a verification contract: name the exact command and exit code for each gate claimed, mark env-gated or skipped tests as SKIPPED and gates missing a service or credential as BLOCKED, name the build target and feature flags compiled, halt when the task names something missing from the working tree, and disclose every deviation.

## One writer per tree

Do not run two write-capable jobs in the same working directory. Parallelize by giving each its own `cwd` (a git worktree), or run them one after another.

## When it finishes

- Report the worker's final message as written. Do not re-implement or quietly finish its work.
- Run `git status --short` and tell the user which files changed.
- If the job is `failed` or `denied`, report that and stop. Do not substitute your own implementation without saying so.
- **The worker's gate table is a set of claims, not facts.** Before you tell the user the work is green, re-run the gates yourself. Run env-gated tests with the gate on. Grep the diff for tests that early-return on a missing env var or feature flag: a suite that self-skips proves nothing. Grep the diff for anything the rest of the repo no longer references: a stale spec gets dead objects faithfully resurrected. A compile can succeed against a target the build does not ship.
