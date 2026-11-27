// MCP Tasks extension (io.modelcontextprotocol/tasks) for the `wait` tool.
//
// A task is a view over a set of jobs, computed on every `tasks/get`: there is
// no second state machine to keep in step with the workers. The client polls;
// `notifications/tasks` is optional and Claude Code does not use it.

import { randomUUID } from "node:crypto";

import { clip } from "./board.mjs";
import { isTerminal } from "./jobs.mjs";
import { ERR, RpcError } from "./rpc.mjs";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const STALE_POLL_MS = 30_000;

export class Tasks {
  #tasks = new Map();
  #jobs;
  #board;
  #render;
  #ttlMs;
  #pollIntervalMs;
  #now;

  /**
   * @param {object} options
   * @param {(jobIds: string[], view: object) => object} options.render  the tools/call result the blocking call would have returned
   */
  constructor({ jobs, board, render, ttlMs = SIX_HOURS, pollIntervalMs = 2000, now = Date.now }) {
    this.#jobs = jobs;
    this.#board = board;
    this.#render = render;
    this.#ttlMs = ttlMs;
    this.#pollIntervalMs = pollIntervalMs;
    this.#now = now;
  }

  /** @param {object} [view] passed back to `render`: how the caller asked for the result */
  create(jobIds, view = {}) {
    this.#prune();
    const now = this.#now();
    const task = { id: randomUUID(), jobIds, view, createdAt: now, polledAt: now, cancelledAt: null };
    // Stored before the result is returned: `tasks/get` must resolve at once.
    this.#tasks.set(task.id, task);
    return { resultType: "task", ...this.#view(task) };
  }

  get(taskId) {
    const task = this.#lookup(taskId);
    task.polledAt = this.#now();
    return this.#view(task);
  }

  /**
   * True while a client is polling a task over this job, so the task's result
   * will report it and a push would only repeat that. A client that stops
   * polling without cancelling gets its pushes back after `STALE_POLL_MS`.
   */
  covers(jobId) {
    const now = this.#now();
    for (const task of this.#tasks.values()) {
      if (!task.cancelledAt && now - task.polledAt < STALE_POLL_MS && task.jobIds.includes(jobId)) {
        return true;
      }
    }
    return false;
  }

  // Cancelling comes from the user stopping the task in the client. Stopping
  // only the wait would leave workers burning tokens with nothing listening,
  // so it stops the workers too.
  cancel(taskId) {
    const task = this.#lookup(taskId);
    if (!task.cancelledAt && !this.#settled(task)) {
      task.cancelledAt = this.#now();
      for (const id of task.jobIds) {
        this.#jobs.cancel(id);
      }
    }
    return {};
  }

  // No task here ever asks for input, so there is never a response to apply.
  update(taskId) {
    this.#lookup(taskId);
    return {};
  }

  #lookup(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task) {
      throw new RpcError(ERR.invalidParams, `Unknown or expired task: ${taskId}`);
    }
    return task;
  }

  #settled(task) {
    return task.jobIds.every((id) => isTerminal(this.#jobs.get(id)));
  }

  #lastChange(task) {
    const stamps = task.jobIds.map((id) => {
      const job = this.#jobs.get(id);
      return job.endedAt ?? job.lastActivityAt;
    });
    return Math.max(task.createdAt, task.cancelledAt ?? 0, ...stamps);
  }

  #statusLine(task) {
    const running = task.jobIds.filter((id) => !isTerminal(this.#jobs.get(id))).length;
    const latest = this.#board.latest(task.jobIds);
    const head = `${running}/${task.jobIds.length} running`;
    return latest ? `${head} · ${latest.job} ${latest.kind}: ${clip(latest.text.split("\n")[0], 160)}` : head;
  }

  #view(task) {
    const base = {
      taskId: task.id,
      createdAt: new Date(task.createdAt).toISOString(),
      lastUpdatedAt: new Date(this.#lastChange(task)).toISOString(),
      ttlMs: this.#ttlMs,
      pollIntervalMs: this.#pollIntervalMs
    };
    if (task.cancelledAt) {
      return { ...base, status: "cancelled", statusMessage: "Cancelled; the workers were stopped." };
    }
    if (this.#settled(task)) {
      const statuses = task.jobIds.map((id) => `${id} ${this.#jobs.get(id).status}`).join(", ");
      return { ...base, status: "completed", statusMessage: statuses, result: this.#render(task.jobIds, task.view) };
    }
    return { ...base, status: "working", statusMessage: this.#statusLine(task) };
  }

  #prune() {
    const now = this.#now();
    for (const [id, task] of this.#tasks) {
      const finished = task.cancelledAt || this.#settled(task);
      if (finished && now - this.#lastChange(task) > this.#ttlMs) {
        this.#tasks.delete(id);
      }
    }
  }
}
